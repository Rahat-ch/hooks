/**
 * `hardhooks test` at its seam, `runTests()`: shipped fixtures and the user's
 * case files run through the dispatcher against the resolved config, in a
 * temp project and home. Asserts only the printed report and the exit code.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Environment } from "../src/environment";
import { defineHook, type Hook } from "../src/hooks/hook";
import { hooks } from "../src/hooks/registry";
import { runTests } from "../src/testing";
import type { FixtureFile } from "../src/testing/fixture-files";
import { fakeEnvironment, hermeticGitEnvironment, initRealGitRepo, writeRepoConfig } from "./helpers";

interface TestRunOptions {
  env?: Environment;
  /** `--cases <path>`. */
  cases?: string;
  hooks?: readonly Hook<any>[];
  /** Replace the shipped fixtures. */
  fixtures?: readonly FixtureFile[];
}

async function runTestCommand(options: TestRunOptions = {}) {
  const env = options.env ?? fakeEnvironment();
  let stdout = "";
  let stderr = "";
  const exitCode = await runTests({
    env,
    ...(options.cases !== undefined ? { casesPath: options.cases } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.fixtures ? { fixtures: options.fixtures } : {}),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { stdout, stderr, exitCode, env };
}

describe("hardhooks test", () => {
  it("passes every shipped fixture with the default config", async () => {
    const result = await runTestCommand();
    expect(result.stdout).toMatch(/PASS\s+git-guard\/force-push-blocked/);
    expect(result.stdout).toMatch(/PASS\s+session-context\/compact-adds-date/);
    expect(result.stdout).not.toMatch(/FAIL/);
    expect(result.stdout).toMatch(/\b0 failed\b/);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  });

  it("runs the user's cases from .hardhooks/tests/ in the project", async () => {
    const env = fakeEnvironment();
    writeCases(env, "git.json", [
      { name: "force-push to main is blocked", event: "PreToolUse", bash: "git push --force origin main", expect: "block" },
    ]);
    const result = await runTestCommand({ env });
    expect(result.stdout).toMatch(/PASS\s+git\.json\s+force-push to main is blocked/);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  });

  it("fails a case whose Hook is disabled, showing the expected and actual Decisions", async () => {
    const env = fakeEnvironment();
    writeRepoConfig(env, { hooks: { "git-guard": { enabled: false } } });
    writeCases(env, "git.json", [{ name: "force-push to main is blocked", bash: "git push --force origin main", expect: "block" }]);
    const result = await runTestCommand({ env });
    expect(result.stdout).toMatch(/FAIL\s+git\.json\s+force-push to main is blocked/);
    expect(result.stdout).toMatch(/expected block, got none/);
    expect(result.stdout).toMatch(/\b1 failed\b/);
    expect(result.exitCode).toBe(1);
  });

  it("skips the shipped fixtures of a disabled Hook, saying why", async () => {
    const env = fakeEnvironment();
    writeRepoConfig(env, { hooks: { "git-guard": { enabled: false } } });
    const result = await runTestCommand({ env });
    expect(result.stdout).toMatch(/SKIP\s+git-guard\/force-push-blocked.*\n\s+git-guard is disabled/);
    expect(result.stdout).toMatch(/PASS\s+session-context\/compact-adds-date/);
    expect(result.exitCode, result.stdout).toBe(0);
  });

  it("matches reasons and added context, for any Event, with extra payload fields", async () => {
    const env = fakeEnvironment();
    writeCases(env, "cases.json", [
      { name: "says why", bash: "git push --force origin main", expect: { decision: "block", reason: "force" } },
      { name: "dates the session", event: "SessionStart", payload: { source: "compact" }, expect: { context: "^today: \\d{4}-" } },
      { name: "wrong reason", bash: "git push --force origin main", expect: { decision: "block", reason: "lease" } },
      { name: "wrong context", event: "SessionStart", expect: { context: "Branch:" } },
    ]);
    const result = await runTestCommand({ env });
    expect(result.stdout).toMatch(/PASS\s+cases\.json\s+says why/);
    expect(result.stdout).toMatch(/PASS\s+cases\.json\s+dates the session/);
    expect(result.stdout).toMatch(/FAIL\s+cases\.json\s+wrong reason\n\s+reason: expected to match \/lease\/i, got ".*force/);
    expect(result.stdout).toMatch(/FAIL\s+cases\.json\s+wrong context\n\s+context: expected to match \/Branch:\/i, got "Today: /);
    expect(result.exitCode).toBe(1);
  });

  describe("side effects", () => {
    it("never runs formatters or other programs from the user's config", async () => {
      const env = fakeEnvironment({ processRunner: "real" });
      const marker = join(env.home, "formatter-ran");
      writeRepoConfig(env, {
        hooks: { "format-on-edit": { command: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`] } },
      });
      writeFileSync(join(env.cwd, "a.ts"), "const  a=1\n");
      writeCases(env, "edit.json", [{ name: "writing a file is fine", event: "PostToolUse", write: "a.ts", expect: "allow" }]);
      const result = await runTestCommand({ env });
      expect(result.stdout).toMatch(/PASS\s+edit\.json/);
      expect(existsSync(marker)).toBe(false);
    });

    it("keeps Hook state (audit logs, check fingerprints) out of the user's state directory", async () => {
      const env = fakeEnvironment();
      const stateful = defineHook({
        name: "stateful",
        description: "test-only: records each Stop in the state dir",
        events: ["Stop"],
        failMode: "open",
        defaults: { standard: { enabled: true, options: {} }, strict: { enabled: true, options: {} } },
        run(_event, _options, hookEnv) {
          mkdirSync(hookEnv.stateDir, { recursive: true });
          writeFileSync(join(hookEnv.stateDir, "stopped"), "");
          return undefined;
        },
      });
      writeCases(env, "stop.json", [{ name: "stop is fine", event: "Stop", expect: "allow" }]);
      const result = await runTestCommand({ env, hooks: [...hooks, stateful] });
      expect(result.stdout).toMatch(/PASS\s+stop\.json/);
      expect(readdirSync(env.stateDir)).toEqual([]);
    });

    it("lets user cases see the real git repository", async () => {
      const env = hermeticGitEnvironment();
      const repo = initRealGitRepo(env);
      writeRepoConfig(env, { preset: "strict" });
      writeCases(env, "branches.json", [{ name: "no commits on main", bash: "git commit -m wip", expect: { decision: "block", reason: "`main`" } }]);
      expect((await runTestCommand({ env })).stdout).toMatch(/PASS\s+branches\.json\s+no commits on main/);

      repo.git("switch", "-q", "-c", "feature");
      // Only read-only git runs: a configured command that would write is never started.
      writeRepoConfig(env, {
        preset: "strict",
        hooks: { "session-context": { commands: [["git", "-C", env.cwd, "commit", "-q", "--allow-empty", "-m", "from hardhooks test"]] } },
      });
      writeCases(env, "session.json", [{ name: "session starts", event: "SessionStart", expect: { context: "feature" } }]);
      const onFeature = await runTestCommand({ env });
      expect(onFeature.stdout).toMatch(/FAIL\s+branches\.json\s+no commits on main\n\s+decision: expected block, got none/);
      expect(onFeature.stdout).toMatch(/PASS\s+session\.json\s+session starts/);
      expect(repo.git("log", "--format=%s")).not.toMatch(/from hardhooks test/);
    });
  });

  it("never fails a shipped fixture just because the user configured a Hook's options", async () => {
    const env = fakeEnvironment();
    writeFileSync(join(env.cwd, "NOTES.md"), "remember the milk\n");
    writeRepoConfig(env, { preset: "strict", hooks: { "session-context": { files: ["NOTES.md"], commands: [["gh", "pr", "list"]] } } });
    const result = await runTestCommand({ env });
    expect(result.stdout).not.toMatch(/FAIL/);
    expect(result.exitCode, result.stdout).toBe(0);
  });

  describe("shipped fixtures that assume a config", () => {
    const fixture = (assumes: object): FixtureFile => ({
      hook: "git-guard",
      file: "protected.json",
      text: JSON.stringify({ description: "assumes something", bash: "git status", expect: "allow", assumes }),
    });

    it("run when the resolved config matches", async () => {
      const env = fakeEnvironment();
      writeRepoConfig(env, { preset: "strict" });
      const result = await runTestCommand({ env, fixtures: [fixture({ preset: "strict", options: { protectedBranches: ["main", "master"] } })] });
      expect(result.stdout).toMatch(/PASS\s+git-guard\/protected\s+assumes something/);
    });

    it("are skipped under another Preset", async () => {
      const result = await runTestCommand({ fixtures: [fixture({ preset: "strict" })] });
      expect(result.stdout).toMatch(/SKIP\s+git-guard\/protected.*\n\s+assumes the strict Preset/);
      expect(result.exitCode).toBe(0);
    });

    it("are skipped when the Hook's options differ", async () => {
      const env = fakeEnvironment();
      writeRepoConfig(env, { hooks: { "git-guard": { protectedBranches: ["release"] } } });
      const result = await runTestCommand({ env, fixtures: [fixture({ options: { protectedBranches: [] } })] });
      expect(result.stdout).toMatch(/SKIP\s+git-guard\/protected.*\n\s+assumes git-guard option protectedBranches = \[\]/);
    });

    it("fail when invalid", async () => {
      const result = await runTestCommand({ fixtures: [{ hook: "git-guard", file: "broken.json", text: "{" }] });
      expect(result.stdout).toMatch(/FAIL\s+git-guard\/broken.*\n\s+git-guard\/fixtures\/broken\.json: invalid JSON/);
      expect(result.exitCode).toBe(1);
    });
  });

  describe("invalid case files", () => {
    it.each([
      ["invalid JSON", "{ name: 'x' ", /bad\.json: invalid JSON/],
      ["a case that isn't an object", ["git status"], /bad\.json\[0\]: a case must be a JSON object/],
      ["a missing name", [{ bash: "ls", expect: "allow" }], /bad\.json\[0\]: "name" is required/],
      ["a misspelt key", [{ name: "push", bash: "git push", expects: "block" }], /bad\.json\[0\] \(push\): unknown key "expects"/],
      ["a missing expect", [{ name: "push", bash: "git push" }], /"expect" is required/],
      ["an unknown Decision", [{ name: "push", bash: "git push", expect: "deny" }], /"expect" must be one of block, ask, allow, none/],
      ["an invalid regular expression", [{ name: "push", bash: "git push", expect: { reason: "(" } }], /"expect\.reason" is not a valid regular expression/],
      ["an unknown Event", [{ name: "x", event: "PreToolCall", expect: "allow" }], /unknown "event" "PreToolCall" \(known: SessionStart, /],
      ["no Event or tool", [{ name: "x", expect: "allow" }], /"event" is required/],
      ["a tool on a tool-less Event", [{ name: "x", event: "Stop", bash: "ls", expect: "allow" }], /a tool only applies to PreToolUse and PostToolUse, not Stop/],
      ["two tools", [{ name: "x", bash: "ls", read: "a.txt", expect: "allow" }], /give one of "tool", .*not bash and read/],
      ["input without a tool", [{ name: "x", input: { command: "ls" }, expect: "allow" }], /"input" needs "tool"/],
      ["an unknown Host", [{ name: "x", host: "vim", bash: "ls", expect: "allow" }], /unknown "host" "vim"/],
      ["assumes, which only shipped fixtures may declare", [{ name: "x", bash: "ls", expect: "allow", assumes: { preset: "strict" } }], /unknown key "assumes"/],
    ])("names the file, the case and the problem: %s", async (_, cases, message) => {
      const env = fakeEnvironment();
      writeCases(env, "bad.json", cases);
      const result = await runTestCommand({ env });
      expect(result.stderr).toMatch(message);
      expect(result.exitCode).toBe(1);
    });

    it("reports every invalid case at once and runs nothing", async () => {
      const env = fakeEnvironment();
      writeCases(env, "a.json", [{ name: "one", bash: "ls", expect: "maybe" }, { name: "two", bash: "ls", expect: "allow" }]);
      writeCases(env, "b.json", [{ name: "three", expect: "allow" }]);
      const result = await runTestCommand({ env });
      expect(result.stderr).toMatch(/a\.json\[0\] \(one\)/);
      expect(result.stderr).toMatch(/b\.json\[0\] \(three\)/);
      expect(result.stderr).not.toMatch(/two/);
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("--cases", () => {
    it("runs one case file", async () => {
      const env = fakeEnvironment();
      writeCases(env, "ignored.json", [{ name: "never runs", bash: "git status", expect: "block" }]);
      const file = writeCases(env, "push.json", { name: "force-push is blocked", bash: "git push -f", expect: "block" }, join(env.cwd, "ci"));
      const result = await runTestCommand({ env, cases: file });
      expect(result.stdout).toMatch(/PASS\s+push\.json\s+force-push is blocked/);
      expect(result.stdout).not.toMatch(/never runs/);
      expect(result.exitCode, result.stdout).toBe(0);
    });

    it("runs every *.json file in a directory, relative to the working directory", async () => {
      const env = fakeEnvironment();
      const dir = join(env.cwd, "ci", "hooks");
      writeCases(env, "a.json", [{ name: "status is fine", bash: "git status", expect: "allow" }], dir);
      writeCases(env, "b.json", [{ name: "reset --hard is blocked", bash: "git reset --hard", expect: "block" }], dir);
      writeCases(env, "notes.txt", "not a case file", dir);
      const result = await runTestCommand({ env, cases: join("ci", "hooks") });
      expect(result.stdout).toMatch(/PASS\s+a\.json\s+status is fine/);
      expect(result.stdout).toMatch(/PASS\s+b\.json\s+reset --hard is blocked/);
      expect(result.exitCode, result.stdout).toBe(0);
    });

    it("fails when the path doesn't exist", async () => {
      const result = await runTestCommand({ cases: "missing.json" });
      expect(result.stderr).toMatch(/missing\.json/);
      expect(result.exitCode).toBe(1);
    });
  });
});

/** Write a case file into the default cases directory. */
function writeCases(env: Environment, file: string, cases: unknown, dir = join(env.cwd, ".hardhooks", "tests")): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, typeof cases === "string" ? cases : JSON.stringify(cases, null, 2));
  return path;
}
