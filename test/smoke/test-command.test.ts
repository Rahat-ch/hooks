/**
 * `hardhooks test` as a real process: the bundle carries the shipped
 * fixtures (it is copied away from the repo first, so it can't read them from
 * src/), runs the user's cases and exits non-zero on failure.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const builtBundle = fileURLToPath(new URL("../../dist/hardhooks.mjs", import.meta.url));

describe("hardhooks test (bundled)", () => {
  let root: string;
  let bundle: string;
  let project: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    if (!existsSync(builtBundle)) throw new Error(`${builtBundle} is missing: run \`npm run build\` first`);
    root = realpathSync(mkdtempSync(join(tmpdir(), "hardhooks-smoke-")));
    bundle = join(root, "elsewhere", "dist", "hardhooks.mjs");
    mkdirSync(join(root, "elsewhere", "dist"), { recursive: true });
    copyFileSync(builtBundle, bundle);
    project = join(root, "project");
    mkdirSync(join(project, ".hardhooks", "tests"), { recursive: true });
    // Keep the developer's own config and settings out of it.
    env = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config"), APPDATA: join(root, "config"), CLAUDE_CONFIG_DIR: join(root, "claude") };
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function hardhooksTest(...args: string[]) {
    const result = spawnSync(process.execPath, [bundle, "test", ...args], { cwd: project, env, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? -1 };
  }

  it("passes the shipped fixtures and the user's cases, exiting 0", () => {
    writeFileSync(
      join(project, ".hardhooks", "tests", "git.json"),
      JSON.stringify([{ name: "force-push to main is blocked", bash: "git push --force origin main", expect: "block" }]),
    );
    const result = hardhooksTest();
    expect(result.stdout).toMatch(/PASS\s+git-guard\/force-push-blocked/);
    expect(result.stdout).toMatch(/PASS\s+git\.json\s+force-push to main is blocked/);
    expect(result.stderr).toMatch(/warning: hardhooks isn't installed/);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  });

  it("exits 1 when a case fails, e.g. with git-guard disabled", () => {
    writeFileSync(join(project, ".hardhooks.json"), JSON.stringify({ hooks: { "git-guard": { enabled: false } } }));
    try {
      const result = hardhooksTest("--cases", join(".hardhooks", "tests", "git.json"));
      expect(result.stdout).toMatch(/FAIL\s+git\.json\s+force-push to main is blocked\n\s+decision: expected block, got none/);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(join(project, ".hardhooks.json"));
    }
  });

  it("rejects unknown arguments", () => {
    const result = hardhooksTest("--case", "x.json");
    expect(result.stderr).toMatch(/usage: hardhooks test \[--cases <path>\]/);
    expect(result.exitCode).toBe(1);
  });
});
