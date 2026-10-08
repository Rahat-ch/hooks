/**
 * check through `hardhooks run <Event>` exactly as a Host runs it (ADR-0006):
 * real command lines through the platform shell (`node -e …`, or fake
 * npm/pnpm/yarn/ruff/go/cargo on PATH for autodetected commands), real git
 * for the working-tree fingerprint, real time for timeouts, and the
 * sandbox's state dir carrying the block count from one Stop to the next.
 *
 * Configured commands come from the user config, which runs without trust
 * (ADR-0005); autodetected ones need the real `hardhooks trust --yes`.
 */
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  expectBlocked,
  expectContext,
  expectMessage,
  expectNoDecision,
  observe,
  sandbox,
  type FakeProgram,
  type Sandbox,
} from "../helpers";

/**
 * Check commands run through the platform shell (sh on POSIX, cmd.exe on
 * Windows), so test commands stick to `node -e "..."` with double quotes and
 * `&&`, which mean the same in both.
 */
const node = (script: string) => `node -e "${script}"`;

/** Enable check with these options in the user config, whose commands run without trusting the project. */
function enableCheck(box: Sandbox, options: Record<string, unknown> = {}): void {
  box.writeUserConfig({ hooks: { check: { enabled: true, ...options } } });
}

/** Enable check in the repo config, so it autodetects a Project command (which then needs trust). */
function enableCheckInRepo(box: Sandbox): void {
  box.writeRepoConfig({ hooks: { check: { enabled: true } } });
}

function scripts(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "fixture", private: true, scripts });
}

/** Make the project a real git repo with `files` committed. */
function gitRepo(box: Sandbox, files: Record<string, string>): void {
  box.initGitRepo(box.project, { initialCommit: false }).commit("initial", files);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The same directory, however the OS spelled it (symlinks, Windows short names). */
const samePath = (a: string, b: string) => realpathSync.native(a) === realpathSync.native(b);

describe("check", () => {
  it("blocks Stop when the configured command fails, with its output in the reason", async () => {
    const box = sandbox();
    enableCheck(box, { command: node("console.error('lint: 3 problems in src/a.ts'); process.exit(1)") });

    const { reason } = expectBlocked(await box.event(claudeCode.stop()), /3 problems in src\/a\.ts/);
    expect(reason).toContain("node -e");
  });

  it("allows Stop when the configured command passes", async () => {
    const box = sandbox();
    enableCheck(box, { command: node("process.exit(0)") });
    expectNoDecision(await box.event(claudeCode.stop()));
  });

  it("truncates long failure output to the byte budget, keeping its start and end", async () => {
    const box = sandbox();
    const noisy = "console.log('FIRST-LINE'); for (let i = 0; i < 5000; i++) console.log('noise line ' + i); console.log('LAST-LINE'); process.exit(1)";
    enableCheck(box, { command: node(noisy), outputBytes: 1000 });

    const { reason } = expectBlocked(await box.event(claudeCode.stop()), /FIRST-LINE[\s\S]*omitted[\s\S]*LAST-LINE/);
    expect(Buffer.byteLength(reason!)).toBeLessThan(1500);
  });

  describe("Presets", () => {
    it("is off under `standard`", async () => {
      const box = sandbox();
      box.writeFile("package.json", scripts({ lint: "eslint ." }));
      const npm = box.fakeProgram("npm", { exitCode: 1 });
      await box.trust();

      expectNoDecision(await box.event(claudeCode.stop()));
      expect(npm.calls()).toEqual([]);
    });

    it("is on under `strict`", async () => {
      const box = sandbox();
      box.writeRepoConfig({ preset: "strict" });
      box.writeFile("package.json", scripts({ lint: "eslint ." }));
      box.fakeProgram("npm", { exitCode: 1, stdout: "lint failed\n" });
      await box.trust();

      expectBlocked(await box.event(claudeCode.stop()), /lint failed/);
    });
  });

  describe("failing open", () => {
    it("allows Stop with a warning when the command times out, even if it left children holding its output", async () => {
      const box = sandbox();
      const hang =
        "require('child_process').spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], { stdio: 'inherit' }); setInterval(function(){}, 1000)";
      enableCheck(box, { command: node(hang), timeoutSeconds: 1 });

      const result = await box.event(claudeCode.stop());
      expect(result.durationMs).toBeLessThan(5000);
      expect(observe(result).decision).toBe("none");
      expectMessage(result, /timed out after 1s/);
    });

    it("allows Stop with a warning when the command can't be found", async () => {
      const box = sandbox();
      enableCheck(box, { command: "hardhooks-no-such-check-command --all" });

      const result = await box.event(claudeCode.stop());
      expect(observe(result).decision).toBe("none");
      expectMessage(result, /could not run/i);
    });
  });

  describe("loop protection", () => {
    const failing = node("console.log('still red'); process.exit(1)");

    it("allows Stop with a message after the cap of consecutive blocks", async () => {
      const box = sandbox();
      enableCheck(box, { command: failing, maxBlocks: 2 });

      expectBlocked(await box.event(claudeCode.stop({ stop_hook_active: false })), /still red/);
      expectBlocked(await box.event(claudeCode.stop({ stop_hook_active: true })), /still red/);
      const result = await box.event(claudeCode.stop({ stop_hook_active: true }));
      expect(observe(result).decision).toBe("none");
      expectMessage(result, /still failing after 2 attempts/);
    });

    it("counts again from zero on a fresh stop (stop-hook-active not set)", async () => {
      const box = sandbox();
      enableCheck(box, { command: failing, maxBlocks: 1 });

      expectBlocked(await box.event(claudeCode.stop({ stop_hook_active: false })));
      expectMessage(await box.event(claudeCode.stop({ stop_hook_active: true })), /still failing/);
      expectBlocked(await box.event(claudeCode.stop({ stop_hook_active: false })));
    });

    it("counts blocks per session", async () => {
      const box = sandbox();
      enableCheck(box, { command: failing, maxBlocks: 1 });

      expectBlocked(await box.event(claudeCode.stop({ session_id: "one" })));
      expectBlocked(await box.event(claudeCode.stop({ session_id: "two", stop_hook_active: true })));
    });
  });

  describe("skipping unchanged work", () => {
    /** A configured command that passes and appends a line to a file outside the project, so tests can count runs. */
    function countingCommand(box: Sandbox): { command: string; runs: () => number } {
      const log = join(box.home, "runs.log").replace(/\\/g, "/");
      return {
        command: node(`require('fs').appendFileSync('${log}', 'ran\\n')`),
        runs: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0),
      };
    }

    it("skips the run when the working tree is unchanged since the last pass", async () => {
      const box = sandbox();
      gitRepo(box, { "src/a.ts": "export const a = 1;\n" });
      const counter = countingCommand(box);
      enableCheck(box, { command: counter.command });

      expectNoDecision(await box.event(claudeCode.stop()));
      expectNoDecision(await box.event(claudeCode.stop()));
      expect(counter.runs()).toBe(1);
    });

    it.each([
      { change: "an edited tracked file", edit: (box: Sandbox) => box.writeFile("src/a.ts", "export const a = 2;\n") },
      { change: "a new untracked file", edit: (box: Sandbox) => box.writeFile("src/b.ts", "export const b = 1;\n") },
      { change: "a deleted file", edit: (box: Sandbox) => rmSync(join(box.project, "src/a.ts")) },
    ])("runs again after $change", async ({ edit }) => {
      const box = sandbox();
      gitRepo(box, { "src/a.ts": "export const a = 1;\n" });
      const counter = countingCommand(box);
      enableCheck(box, { command: counter.command });

      await box.event(claudeCode.stop());
      edit(box);
      await box.event(claudeCode.stop());
      expect(counter.runs()).toBe(2);
    });

    it("runs again after an uncommitted file changes a second time", async () => {
      const box = sandbox();
      gitRepo(box, { "src/a.ts": "export const a = 1;\n" });
      const counter = countingCommand(box);
      enableCheck(box, { command: counter.command });

      box.writeFile("src/a.ts", "export const a = 2;\n");
      await box.event(claudeCode.stop());
      box.writeFile("src/a.ts", "export const a = 3;\n");
      await box.event(claudeCode.stop());
      expect(counter.runs()).toBe(2);
    });

    it("ignores changes to gitignored files", async () => {
      const box = sandbox();
      gitRepo(box, { ".gitignore": "dist/\n", "src/a.ts": "export const a = 1;\n" });
      const counter = countingCommand(box);
      enableCheck(box, { command: counter.command });

      await box.event(claudeCode.stop());
      box.writeFile("dist/a.js", "exports.a = 1;\n");
      await box.event(claudeCode.stop());
      expect(counter.runs()).toBe(1);
    });

    it("runs every time outside a git repo", async () => {
      const box = sandbox();
      const counter = countingCommand(box);
      enableCheck(box, { command: counter.command });

      await box.event(claudeCode.stop());
      await box.event(claudeCode.stop());
      expect(counter.runs()).toBe(2);
    });
  });

  describe("opt-in extras", () => {
    const failing = node("console.log('red'); process.exit(1)");

    it("does nothing on SubagentStop unless enabled", async () => {
      const box = sandbox();
      enableCheck(box, { command: failing });
      expectNoDecision(await box.event(claudeCode.subagentStop()));
    });

    it("blocks SubagentStop when enabled", async () => {
      const box = sandbox();
      enableCheck(box, { command: failing, subagentStop: true });
      expectBlocked(await box.event(claudeCode.subagentStop()), /red/);
    });

    const edit = (box: Sandbox, file = "src/a.ts") =>
      claudeCode.postToolUse("Edit", { file_path: join(box.project, file), old_string: "a", new_string: "b" });

    it("does nothing after an edit unless per-edit mode is enabled", async () => {
      const box = sandbox();
      enableCheck(box, { command: failing });
      expectNoDecision(await box.event(edit(box)));
    });

    it("per-edit mode runs the edit command on the changed file and feeds back its failure", async () => {
      const box = sandbox();
      enableCheck(box, { editCommand: `${node("console.log('2 problems in ' + process.argv[1]); process.exit(1)")} {file}` });

      const observed = expectContext(await box.event(edit(box, "src/my file.ts")), /2 problems in .*src[\\/]my file\.ts/);
      expect(observed.decision).toBe("none");
    });

    it("per-edit mode appends the file when the command has no {file} placeholder", async () => {
      const box = sandbox();
      enableCheck(box, { editCommand: node("console.log('checked ' + process.argv[1]); process.exit(1)") });
      expectContext(await box.event(edit(box)), /checked .*src[\\/]a\.ts/);
    });

    it("per-edit mode caps its feedback", async () => {
      const box = sandbox();
      enableCheck(box, {
        editCommand: node("for (let i = 0; i < 2000; i++) console.log('problem ' + i); process.exit(1)"),
        editOutputBytes: 300,
      });
      const { context } = expectContext(await box.event(edit(box)), /problem 0[\s\S]*omitted/);
      expect(Buffer.byteLength(context!)).toBeLessThan(600);
    });

    it("per-edit mode stays silent when the edit command passes", async () => {
      const box = sandbox();
      enableCheck(box, { editCommand: node("process.exit(0)") });
      expectNoDecision(await box.event(edit(box)));
    });
  });

  describe("with no command configured", () => {
    it("in an untrusted project, does not run detected scripts and tells the user, without blocking", async () => {
      const box = sandbox();
      enableCheckInRepo(box);
      box.writeFile("package.json", scripts({ lint: "eslint ." }));
      const npm = box.fakeProgram("npm", { exitCode: 1 });

      const result = await box.event(claudeCode.stop());

      expect(npm.calls()).toEqual([]);
      expectMessage(result, /skipped `npm run lint` \(detected from package\.json[^)]*\): this project is not trusted.*`hardhooks trust`/);
      expect(observe(result).decision).toBe("none");
    });

    it("detects a package.json `lint` script, runs it and announces it", async () => {
      const box = sandbox();
      enableCheckInRepo(box);
      box.writeFile("package.json", scripts({ lint: "eslint ." }));
      const npm = box.fakeProgram("npm");
      await box.trust();

      expectMessage(await box.event(claudeCode.stop()), /`npm run lint`.*package\.json/);
      const calls = npm.calls();
      expect(calls.map((call) => call.argv)).toEqual([["run", "lint"]]);
      expect(samePath(calls[0]!.cwd, box.project)).toBe(true);
    });

    it("names the autodetected Project command when it blocks", async () => {
      const box = sandbox();
      enableCheckInRepo(box);
      box.writeFile("package.json", scripts({ lint: "eslint ." }));
      box.fakeProgram("npm", { exitCode: 1, stdout: "2 lint errors\n" });
      await box.trust();

      expectBlocked(await box.event(claudeCode.stop()), /`npm run lint`[\s\S]*package\.json[\s\S]*2 lint errors/);
    });

    /** Every program an autodetected command may start, faked on PATH (through the shell, so on every OS). */
    const detectable = ["npm", "pnpm", "yarn", "bun", "ruff", "go", "cargo"] as const;

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
      const box = sandbox();
      enableCheckInRepo(box);
      for (const [name, content] of Object.entries(files)) box.writeFile(name, content);
      const fakes = Object.fromEntries(detectable.map((name) => [name, box.fakeProgram(name)])) as Record<string, FakeProgram>;
      await box.trust();

      expectMessage(await box.event(claudeCode.stop()), new RegExp(`ran \`${escapeRegExp(command)}\` \\(detected`));
      // Exactly the detected command lines ran, in order, and nothing else.
      const expected = command.split(" && ").map((line) => line.split(" "));
      const ran = detectable.flatMap((name) => fakes[name]!.calls().map((call) => ({ name, argv: call.argv, time: call.time })));
      ran.sort((a, b) => a.time - b.time);
      expect(ran.map(({ name, argv }) => [name, ...argv])).toEqual(expected);
    });

    it.each([
      { project: "no recognised check", files: { "README.md": "# hi\n" } },
      { project: "only npm init's placeholder test script", files: { "package.json": scripts({ test: 'echo "Error: no test specified" && exit 1' }) } },
      { project: "pyproject.toml without ruff", files: { "pyproject.toml": "[project]\nname = 'x'\n" } },
    ])("does nothing in a project with $project", async ({ files }) => {
      const box = sandbox();
      enableCheckInRepo(box);
      for (const [name, content] of Object.entries(files)) box.writeFile(name, content);
      const fakes = detectable.map((name) => box.fakeProgram(name));
      await box.trust();

      expectNoDecision(await box.event(claudeCode.stop()));
      expect(fakes.flatMap((fake) => fake.calls())).toEqual([]);
    });
  });
});
