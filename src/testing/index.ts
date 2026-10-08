/**
 * The `hardhooks test` seam: run the shipped fixtures and the user's case
 * files through the dispatcher (`dispatch`, the same seam as `hardhooks run`
 * and the project's own tests) against the resolved config, print a pass/fail
 * report, and resolve to the exit code (non-zero on any failure, for CI).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookSettings, type ResolvedConfig } from "../config";
import { formatConfigError, loadConfig } from "../config/load";
import { dispatch } from "../dispatcher";
import type { Environment } from "../environment";
import type { Hook } from "../hooks/hook";
import { hooks as registeredHooks } from "../hooks/registry";
import { parseCaseFile, type TestCase } from "./cases";
import type { FixtureFile } from "./fixture-files";
import { judge, type Verdict } from "./observe";
import { sandboxProcessRunner } from "./sandbox";
import { shippedFixtureFiles } from "./shipped";
import { installWarnings } from "./install-check";
import { loadUserCases } from "./user-cases";

export { defaultCasesDir } from "./user-cases";

export interface TestRequest {
  env: Environment;
  /** `--cases <path>`: a case file or a directory of them. Default: `.hardhooks/tests/` in the project. */
  casesPath?: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Hooks to consider. Defaults to the built-in registry; tests may inject their own. */
  hooks?: readonly Hook<any>[];
  /** The shipped fixtures. Defaults to the ones in this build; tests may inject their own. */
  fixtures?: readonly FixtureFile[];
}

/** The fake project directory that shipped fixtures without a captured payload run in. */
const fixtureCwd = "/home/user/demo";

interface Outcome {
  status: "pass" | "fail" | "skip";
  label: string;
  name: string;
  detail: readonly string[];
}

/** `hardhooks test`. Resolves to the exit code. */
export async function runTests(request: TestRequest): Promise<number> {
  const { env, stdout, stderr } = request;
  const hooks = request.hooks ?? registeredHooks;
  const loaded = loadConfig(env, hooks);
  if (!loaded.ok) {
    for (const error of loaded.errors) stderr(`hardhooks: invalid config: ${formatConfigError(error)}\n`);
    stderr("hardhooks: fix the config, then re-run hardhooks test.\n");
    return 1;
  }
  const { config } = loaded;

  const userCases = loadUserCases(env, request.casesPath);
  if (!userCases.ok) {
    for (const error of userCases.errors) stderr(`hardhooks: invalid case file: ${error}\n`);
    return 1;
  }

  const sandboxDir = mkdtempSync(join(tmpdir(), "hardhooks-test-"));
  try {
    const stateDir = join(sandboxDir, "state");
    const fixtureEnv: Environment = { ...env, stateDir, processRunner: sandboxProcessRunner({ realGit: false }) };
    const caseEnv: Environment = { ...env, stateDir, processRunner: sandboxProcessRunner({ realGit: true }) };
    const outcomes: Outcome[] = [];
    const print = (o: Outcome) => {
      outcomes.push(o);
      stdout(`  ${o.status.toUpperCase()}  ${o.label}  ${o.name}\n`);
      for (const line of o.detail) stdout(`        ${line}\n`);
    };

    stdout("Shipped fixtures\n");
    for (const fixture of request.fixtures ?? shippedFixtureFiles()) {
      const label = `${fixture.hook}/${fixture.file.replace(/\.json$/, "")}`;
      const parsed = parseCaseFile(fixture.text, `${fixture.hook}/fixtures/${fixture.file}`, { kind: "fixture", cwd: fixtureCwd });
      if (!parsed.ok) {
        print({ status: "fail", label, name: "invalid fixture", detail: parsed.errors });
        continue;
      }
      const hook = hooks.find((h) => h.name === fixture.hook);
      for (const testCase of parsed.cases) {
        const skip = hook === undefined ? `no Hook named ${fixture.hook}` : skipReason(hook, config, testCase);
        if (skip !== undefined) print({ status: "skip", label, name: testCase.name, detail: [skip] });
        else print(outcome(label, testCase, await runCase(testCase, config, fixtureEnv, hooks)));
      }
    }

    stdout(`\nYour cases (${userCases.location})\n`);
    if (userCases.cases.length === 0) stdout(`  none: add *.json case files there, or pass --cases <path>\n`);
    for (const testCase of userCases.cases) {
      print(outcome(testCase.source, testCase, await runCase(testCase, config, caseEnv, hooks)));
    }

    // Warnings, not failures: CI checks out a repo where nothing is installed for the Host.
    for (const warning of installWarnings(env, hooks, config)) stderr(`hardhooks: warning: ${warning}\n`);

    const count = (status: Outcome["status"]) => outcomes.filter((o) => o.status === status).length;
    stdout(`\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped\n`);
    return count("fail") > 0 ? 1 : 0;
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}

/**
 * Why a shipped fixture of this Hook doesn't apply under the user's config,
 * or undefined if it does: the Hook is disabled, or the fixture assumes a
 * Preset or option values the config doesn't have.
 */
function skipReason(hook: Hook<any>, config: ResolvedConfig, testCase: TestCase): string | undefined {
  const settings = hookSettings(hook, config);
  if (!settings.enabled) return `${hook.name} is disabled`;
  const { preset, options = {} } = testCase.assumes ?? {};
  if (preset !== undefined && preset !== config.preset) return `assumes the ${preset} Preset (yours: ${config.preset})`;
  for (const [key, value] of Object.entries(options)) {
    const actual = (settings.options as Record<string, unknown>)[key];
    if (JSON.stringify(actual) !== JSON.stringify(value)) {
      return `assumes ${hook.name} option ${key} = ${JSON.stringify(value)} (yours: ${JSON.stringify(actual) ?? "unset"})`;
    }
  }
  return undefined;
}

async function runCase(testCase: TestCase, config: ResolvedConfig, env: Environment, hooks: readonly Hook<any>[]): Promise<Verdict> {
  const result = await dispatch({ event: testCase.event, payload: JSON.stringify(testCase.payload), config, env, hooks });
  return judge(result, testCase.expect);
}

function outcome(label: string, testCase: TestCase, verdict: Verdict): Outcome {
  return { status: verdict.pass ? "pass" : "fail", label, name: testCase.name, detail: verdict.problems };
}
