import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  expectBlocked,
  expectContext,
  expectMessage,
  expectNoDecision,
  fakeEnvironment,
  observe,
  runEvent as dispatchEvent,
  writeRepoConfig,
  type FakeEnvironment,
} from "../../../test/helpers";

/**
 * Check commands run through the platform shell (sh on POSIX, cmd.exe on
 * Windows), so test commands stick to `node -e "..."` with double quotes and
 * `&&`, which mean the same in both.
 */
const node = (script: string) => `node -e "${script}"`;

/**
 * These tests are about check itself, so the project is trusted (ADR-0005).
 * "in an untrusted project" below uses the real trust lookup.
 */
const runEvent: typeof dispatchEvent = (payload, options = {}) => dispatchEvent(payload, { trusted: true, ...options });

/** A temp project with real processes and enough of the real environment (PATH) to find node, git and the shell. */
function realEnvironment(): FakeEnvironment {
  const passthrough = [
    ...["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "WINDIR", "TEMP", "TMP"],
    // npm on Windows looks for its config and prefix here.
    ...["APPDATA", "LOCALAPPDATA", "USERPROFILE"],
  ];
  const env = Object.fromEntries(passthrough.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
  return fakeEnvironment({ processRunner: "real", env });
}

function enableCheck(env: FakeEnvironment, options: Record<string, unknown> = {}) {
  writeRepoConfig(env, { hooks: { check: { enabled: true, ...options } } });
}

describe("check", () => {
  it("blocks Stop when the configured command fails, with its output in the reason", async () => {
    const env = realEnvironment();
    enableCheck(env, { command: node("console.error('lint: 3 problems in src/a.ts'); process.exit(1)") });

    const { reason } = expectBlocked(await runEvent(claudeCode.stop(), { env }), /3 problems in src\/a\.ts/);
    expect(reason).toContain("node -e");
  });

  it("allows Stop when the configured command passes", async () => {
    const env = realEnvironment();
    enableCheck(env, { command: node("process.exit(0)") });
    expectNoDecision(await runEvent(claudeCode.stop(), { env }));
  });

  it("truncates long failure output to the byte budget, keeping its start and end", async () => {
    const env = realEnvironment();
    const noisy = "console.log('FIRST-LINE'); for (let i = 0; i < 5000; i++) console.log('noise line ' + i); console.log('LAST-LINE'); process.exit(1)";
    enableCheck(env, { command: node(noisy), outputBytes: 1000 });

    const { reason } = expectBlocked(await runEvent(claudeCode.stop(), { env }), /FIRST-LINE[\s\S]*omitted[\s\S]*LAST-LINE/);
    expect(Buffer.byteLength(reason!)).toBeLessThan(1500);
  });

  describe("Presets", () => {
    it("is off under `standard`", async () => {
      const env = realEnvironment();
      writePackageJson(env, { lint: node("process.exit(1)") });
      expectNoDecision(await runEvent(claudeCode.stop(), { env }));
    });

    it("is on under `strict`", async () => {
      const env = realEnvironment();
      writeRepoConfig(env, { preset: "strict" });
      writePackageJson(env, { lint: node("console.log('lint failed'); process.exit(1)") });
      expectBlocked(await runEvent(claudeCode.stop(), { env }), /lint failed/);
    });
  });

  describe("failing open", () => {
    it("allows Stop with a warning when the command times out, even if it left children holding its output", { timeout: 15_000 }, async () => {
      const env = realEnvironment();
      const hang =
        "require('child_process').spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { stdio: 'inherit' }); setInterval(function(){}, 1000)";
      enableCheck(env, { command: node(hang), timeoutSeconds: 1 });

      const started = Date.now();
      const result = await runEvent(claudeCode.stop(), { env });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(observe(result).decision).toBe("none");
      expectMessage(result, /timed out after 1s/);
    });

    it("allows Stop with a warning when the command can't be found", async () => {
      const env = realEnvironment();
      enableCheck(env, { command: "hardhooks-no-such-check-command --all" });

      const result = await runEvent(claudeCode.stop(), { env });
      expect(observe(result).decision).toBe("none");
      expectMessage(result, /could not run/i);
    });
  });

  describe("loop protection", () => {
    const failing = node("console.log('still red'); process.exit(1)");

    it("allows Stop with a message after the cap of consecutive blocks", async () => {
      const env = realEnvironment();
      enableCheck(env, { command: failing, maxBlocks: 2 });

      expectBlocked(await runEvent(claudeCode.stop({ stop_hook_active: false }), { env }), /still red/);
      expectBlocked(await runEvent(claudeCode.stop({ stop_hook_active: true }), { env }), /still red/);
      const result = await runEvent(claudeCode.stop({ stop_hook_active: true }), { env });
      expect(observe(result).decision).toBe("none");
      expectMessage(result, /still failing after 2 attempts/);
    });

    it("counts again from zero on a fresh stop (stop-hook-active not set)", async () => {
      const env = realEnvironment();
      enableCheck(env, { command: failing, maxBlocks: 1 });

      expectBlocked(await runEvent(claudeCode.stop({ stop_hook_active: false }), { env }));
      expectMessage(await runEvent(claudeCode.stop({ stop_hook_active: true }), { env }), /still failing/);
      expectBlocked(await runEvent(claudeCode.stop({ stop_hook_active: false }), { env }));
    });

    it("counts blocks per session", async () => {
      const env = realEnvironment();
      enableCheck(env, { command: failing, maxBlocks: 1 });

      expectBlocked(await runEvent(claudeCode.stop({ session_id: "one" }), { env }));
      expectBlocked(await runEvent(claudeCode.stop({ session_id: "two", stop_hook_active: true }), { env }));
    });
  });

  describe("skipping unchanged work", () => {
    /** A configured command that passes and appends a line to a file outside the project, so tests can count runs. */
    function countingCommand(env: FakeEnvironment): { command: string; runs: () => number } {
      const log = join(env.home, "runs.log").replace(/\\/g, "/");
      return {
        command: node(`require('fs').appendFileSync('${log}', 'ran\\n')`),
        runs: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0),
      };
    }

    it("skips the run when the working tree is unchanged since the last pass", async () => {
      const env = realEnvironment();
      gitRepo(env.cwd, { "src/a.ts": "export const a = 1;\n" });
      const counter = countingCommand(env);
      enableCheck(env, { command: counter.command });

      expectNoDecision(await runEvent(claudeCode.stop(), { env }));
      expectNoDecision(await runEvent(claudeCode.stop(), { env }));
      expect(counter.runs()).toBe(1);
    });

    it.each([
      { change: "an edited tracked file", edit: (cwd: string) => writeFileSync(join(cwd, "src/a.ts"), "export const a = 2;\n") },
      { change: "a new untracked file", edit: (cwd: string) => writeFileSync(join(cwd, "src/b.ts"), "export const b = 1;\n") },
      { change: "a deleted file", edit: (cwd: string) => rmSync(join(cwd, "src/a.ts")) },
    ])("runs again after $change", async ({ edit }) => {
      const env = realEnvironment();
      gitRepo(env.cwd, { "src/a.ts": "export const a = 1;\n" });
      const counter = countingCommand(env);
      enableCheck(env, { command: counter.command });

      await runEvent(claudeCode.stop(), { env });
      edit(env.cwd);
      await runEvent(claudeCode.stop(), { env });
      expect(counter.runs()).toBe(2);
    });

    it("runs again after an uncommitted file changes a second time", async () => {
      const env = realEnvironment();
      gitRepo(env.cwd, { "src/a.ts": "export const a = 1;\n" });
      const counter = countingCommand(env);
      enableCheck(env, { command: counter.command });

      writeFileSync(join(env.cwd, "src/a.ts"), "export const a = 2;\n");
      await runEvent(claudeCode.stop(), { env });
      writeFileSync(join(env.cwd, "src/a.ts"), "export const a = 3;\n");
      await runEvent(claudeCode.stop(), { env });
      expect(counter.runs()).toBe(2);
    });

    it("ignores changes to gitignored files", async () => {
      const env = realEnvironment();
      gitRepo(env.cwd, { ".gitignore": "dist/\n", "src/a.ts": "export const a = 1;\n" });
      const counter = countingCommand(env);
      enableCheck(env, { command: counter.command });

      await runEvent(claudeCode.stop(), { env });
      mkdirSync(join(env.cwd, "dist"));
      writeFileSync(join(env.cwd, "dist/a.js"), "exports.a = 1;\n");
      await runEvent(claudeCode.stop(), { env });
      expect(counter.runs()).toBe(1);
    });

    it("runs every time outside a git repo", async () => {
      const env = realEnvironment();
      const counter = countingCommand(env);
      enableCheck(env, { command: counter.command });

      await runEvent(claudeCode.stop(), { env });
      await runEvent(claudeCode.stop(), { env });
      expect(counter.runs()).toBe(2);
    });
  });

  describe("opt-in extras", () => {
    const failing = node("console.log('red'); process.exit(1)");

    it("does nothing on SubagentStop unless enabled", async () => {
      const env = realEnvironment();
      enableCheck(env, { command: failing });
      expectNoDecision(await runEvent(claudeCode.subagentStop(), { env }));
    });

    it("blocks SubagentStop when enabled", async () => {
      const env = realEnvironment();
      enableCheck(env, { command: failing, subagentStop: true });
      expectBlocked(await runEvent(claudeCode.subagentStop(), { env }), /red/);
    });

    const edit = (env: FakeEnvironment, file = "src/a.ts") =>
      claudeCode.postToolUse("Edit", { file_path: join(env.cwd, file), old_string: "a", new_string: "b" });

    it("does nothing after an edit unless per-edit mode is enabled", async () => {
      const env = realEnvironment();
      enableCheck(env, { command: failing });
      expectNoDecision(await runEvent(edit(env), { env }));
    });

    it("per-edit mode runs the edit command on the changed file and feeds back its failure", async () => {
      const env = realEnvironment();
      enableCheck(env, { editCommand: `${node("console.log('2 problems in ' + process.argv[1]); process.exit(1)")} {file}` });

      const observed = expectContext(await runEvent(edit(env, "src/my file.ts"), { env }), /2 problems in .*src[\\/]my file\.ts/);
      expect(observed.decision).toBe("none");
    });

    it("per-edit mode appends the file when the command has no {file} placeholder", async () => {
      const env = realEnvironment();
      enableCheck(env, { editCommand: node("console.log('checked ' + process.argv[1]); process.exit(1)") });
      expectContext(await runEvent(edit(env), { env }), /checked .*src[\\/]a\.ts/);
    });

    it("per-edit mode caps its feedback", async () => {
      const env = realEnvironment();
      enableCheck(env, {
        editCommand: node("for (let i = 0; i < 2000; i++) console.log('problem ' + i); process.exit(1)"),
        editOutputBytes: 300,
      });
      const { context } = expectContext(await runEvent(edit(env), { env }), /problem 0[\s\S]*omitted/);
      expect(Buffer.byteLength(context!)).toBeLessThan(600);
    });

    it("per-edit mode stays silent when the edit command passes", async () => {
      const env = realEnvironment();
      enableCheck(env, { editCommand: node("process.exit(0)") });
      expectNoDecision(await runEvent(edit(env), { env }));
    });
  });

  describe("with no command configured", () => {
    it("in an untrusted project, does not run detected scripts and tells the user, without blocking", async () => {
      const env = realEnvironment();
      enableCheck(env);
      writePackageJson(env, { lint: node("require('fs').writeFileSync('lint-ran', ''); process.exit(1)") });

      const result = await dispatchEvent(claudeCode.stop(), { env });

      expect(existsSync(join(env.cwd, "lint-ran"))).toBe(false);
      expectMessage(result, /skipped `npm run lint` \(detected from package\.json[^)]*\): this project is not trusted.*`hardhooks trust`/);
      expect(observe(result).decision).toBe("none");
    });

    it("detects a package.json `lint` script, runs it and announces it", async () => {
      const env = realEnvironment();
      enableCheck(env);
      writePackageJson(env, { lint: node("require('fs').writeFileSync('lint-ran', '')") });

      expectMessage(await runEvent(claudeCode.stop(), { env }), /`npm run lint`.*package\.json/);
      expect(existsSync(join(env.cwd, "lint-ran"))).toBe(true);
    });

    it("names the detected command when it blocks", async () => {
      const env = realEnvironment();
      enableCheck(env);
      writePackageJson(env, { lint: node("console.log('2 lint errors'); process.exit(1)") });

      expectBlocked(await runEvent(claudeCode.stop(), { env }), /`npm run lint`[\s\S]*package\.json[\s\S]*2 lint errors/);
    });

    it.each([
      {
        project: "package.json with lint, typecheck and test scripts",
        files: { "package.json": scripts({ test: "vitest run", typecheck: "tsc", lint: "eslint ." }) },
        command: "npm run lint && npm run typecheck && npm run test",
      },
      {
        project: "a pnpm lockfile",
        files: { "package.json": scripts({ test: "vitest run" }), "pnpm-lock.yaml": "" },
        command: "pnpm run test",
      },
      {
        project: "a yarn lockfile",
        files: { "package.json": scripts({ lint: "eslint ." }), "yarn.lock": "" },
        command: "yarn run lint",
      },
      {
        project: "ruff configured in pyproject.toml",
        files: { "pyproject.toml": "[project]\nname = 'x'\n\n[tool.ruff]\nline-length = 100\n" },
        command: "ruff check .",
      },
      { project: "a ruff.toml", files: { "ruff.toml": "line-length = 100\n" }, command: "ruff check ." },
      { project: "a go.mod", files: { "go.mod": "module example.com/x\n" }, command: "go vet ./..." },
      { project: "a Cargo.toml", files: { "Cargo.toml": "[package]\nname = 'x'\n" }, command: "cargo check" },
      {
        project: "package.json scripts before go.mod",
        files: { "package.json": scripts({ lint: "eslint ." }), "go.mod": "module example.com/x\n" },
        command: "npm run lint",
      },
    ])("detects `$command` in a project with $project", async ({ files, command }) => {
      const env = fakeEnvironment();
      enableCheck(env);
      for (const [name, content] of Object.entries(files)) writeFileSync(join(env.cwd, name), content);

      expectMessage(await runEvent(claudeCode.stop(), { env }), new RegExp(`ran \`${escapeRegExp(command)}\` \\(detected`));
    });

    it.each([
      { project: "no recognised check", files: { "README.md": "# hi\n" } },
      { project: "only npm init's placeholder test script", files: { "package.json": scripts({ test: 'echo "Error: no test specified" && exit 1' }) } },
      { project: "pyproject.toml without ruff", files: { "pyproject.toml": "[project]\nname = 'x'\n" } },
    ])("does nothing in a project with $project", async ({ files }) => {
      const env = fakeEnvironment();
      enableCheck(env);
      for (const [name, content] of Object.entries(files)) writeFileSync(join(env.cwd, name), content);
      expectNoDecision(await runEvent(claudeCode.stop(), { env }));
    });
  });
});

/** Make `dir` a git repo with `files` committed. */
function gitRepo(dir: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
}

function scripts(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "fixture", private: true, scripts });
}

function writePackageJson(env: FakeEnvironment, packageScripts: Record<string, string>) {
  writeFileSync(join(env.cwd, "package.json"), scripts(packageScripts));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
