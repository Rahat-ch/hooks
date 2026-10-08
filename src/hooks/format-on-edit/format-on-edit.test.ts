import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProcessResult } from "../../environment";
import {
  claudeCode,
  expectNoDecision,
  fakeEnvironment,
  recordingProcessRunner,
  runEvent,
  writeRepoConfig,
  type FakeEnvironmentOptions,
} from "../../../test/helpers";

const repoPrettier = fileURLToPath(new URL("../../../node_modules/prettier", import.meta.url));

/** A temp project (a git repo root, so detection never looks above it) with these files. */
function project(files: Record<string, string>, options: FakeEnvironmentOptions = {}) {
  const env = fakeEnvironment(options);
  mkdirSync(join(env.cwd, ".git"));
  for (const [path, content] of Object.entries(files)) write(join(env.cwd, path), content);
  return env;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Install this repo's prettier into a project as its own `node_modules/prettier` (a junction on Windows). */
function linkPrettier(projectDir: string): void {
  mkdirSync(join(projectDir, "node_modules"), { recursive: true });
  symlinkSync(repoPrettier, join(projectDir, "node_modules", "prettier"), "junction");
}

const read = (path: string) => readFileSync(path, "utf8");

/**
 * Stands in for formatters CI may not have (ruff, gofmt, ...): a recording
 * process runner that, when `program` runs, rewrites the file named by its
 * last argument to `formatted`, as the real formatter would. With a failing
 * `result` it leaves the file alone.
 */
function fakeFormatter(program: string, formatted: string, result: Partial<ProcessResult> = {}) {
  const succeeds = (result.exitCode ?? 0) === 0 && !result.timedOut && !result.spawnError;
  return recordingProcessRunner((command, args, options) => {
    if (succeeds && basename(command).replace(/\.exe$/, "") === program) {
      writeFileSync(resolve(options.cwd ?? ".", args.at(-1)!), formatted);
    }
    return result;
  });
}

const writePayload = (file: string) => claudeCode.postToolUse("Write", { file_path: file, content: "..." });

describe("format-on-edit", () => {
  describe("with a real prettier", () => {
    it("formats the file the Host wrote, silently, and leaves every other file alone", { timeout: 30_000 }, async () => {
      const env = project(
        {
          ".prettierrc": JSON.stringify({ semi: false }),
          "src/edited.ts": "const  x = {a:1,b:2};\n",
          "src/untouched.ts": "const  y = {c:3};\n",
        },
        { processRunner: "real" },
      );
      linkPrettier(env.cwd);
      const file = join(env.cwd, "src", "edited.ts");

      const result = await runEvent(claudeCode.postToolUse("Write", { file_path: file, content: "..." }), { env });

      expectNoDecision(result);
      expect(result.stderr).toBe("");
      expect(read(file)).toBe("const x = { a: 1, b: 2 }\n");
      expect(read(join(env.cwd, "src", "untouched.ts"))).toBe("const  y = {c:3};\n");
    });
  });

  it("formats a .py file in a ruff-configured project with `ruff format`", async () => {
    const runner = fakeFormatter("ruff", "x = 1\n");
    const env = project({ "pyproject.toml": "[project]\nname = 'demo'\n\n[tool.ruff]\nline-length = 100\n", "app.py": "x=1\n" }, { processRunner: runner });
    const file = join(env.cwd, "app.py");

    const result = await runEvent(writePayload(file), { env });

    expectNoDecision(result);
    expect(read(file)).toBe("x = 1\n");
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]!.args).toContain("format");
  });

  describe("detects the formatter from project config", () => {
    it.each<{ formatter: string; config: Record<string, string>; file: string; args: string[] }>([
      { formatter: "biome", config: { "biome.json": "{}" }, file: "src/a.ts", args: ["format", "--write"] },
      { formatter: "biome", config: { "biome.jsonc": "{}" }, file: "data.json", args: ["format", "--write"] },
      { formatter: "prettier", config: { ".prettierrc.yaml": "semi: false\n" }, file: "README.md", args: ["--write"] },
      { formatter: "prettier", config: { "prettier.config.mjs": "export default {}\n" }, file: "a.css", args: ["--write"] },
      { formatter: "dprint", config: { "dprint.json": "{}" }, file: "src/a.ts", args: ["fmt"] },
      { formatter: "dprint", config: { ".dprint.jsonc": "{}" }, file: "Cargo.toml", args: ["fmt"] },
      { formatter: "ruff", config: { ".ruff.toml": "" }, file: "a.pyi", args: ["format"] },
      { formatter: "black", config: { "pyproject.toml": "[tool.black]\nline-length = 88\n" }, file: "a.py", args: [] },
      { formatter: "gofmt", config: { "go.mod": "module example.com/demo\n" }, file: "cmd/main.go", args: ["-w"] },
      { formatter: "rustfmt", config: { "Cargo.toml": "[package]\nname = 'demo'\n" }, file: "src/main.rs", args: [] },
      { formatter: "rustfmt", config: { "rustfmt.toml": "" }, file: "lib.rs", args: [] },
    ])("$formatter for $file with $config", async ({ formatter, config, file, args }) => {
      const runner = fakeFormatter(formatter, "formatted\n");
      const env = project({ ...config, [file]: "unformatted\n" }, { processRunner: runner });
      const path = join(env.cwd, file);

      expectNoDecision(await runEvent(writePayload(path), { env }));

      expect(runner.runs.map((r) => r.command)).toEqual([formatter]);
      expect(runner.runs[0]!.args).toEqual(expect.arrayContaining(args));
      expect(read(path)).toBe("formatted\n");
    });

    it("passes the Rust edition from Cargo.toml, as cargo fmt would", async () => {
      const runner = recordingProcessRunner();
      const env = project({ "Cargo.toml": '[package]\nname = "demo"\nedition = "2021"\n', "src/lib.rs": "" }, { processRunner: runner });

      await runEvent(writePayload(join(env.cwd, "src", "lib.rs")), { env });

      expect(runner.runs[0]!.args).toEqual(expect.arrayContaining(["--edition", "2021"]));
    });

    it("prefers ruff over black when pyproject.toml configures both", async () => {
      const runner = recordingProcessRunner();
      const env = project({ "pyproject.toml": "[tool.black]\n\n[tool.ruff.lint]\nselect = ['E']\n", "a.py": "" }, { processRunner: runner });

      await runEvent(writePayload(join(env.cwd, "a.py")), { env });

      expect(runner.runs.map((r) => r.command)).toEqual(["ruff"]);
    });

    it("uses the config nearest the edited file", async () => {
      const runner = recordingProcessRunner();
      const env = project(
        { ".prettierrc": "{}", "packages/app/biome.json": "{}", "packages/app/src/a.ts": "", "packages/lib/b.ts": "" },
        { processRunner: runner },
      );

      await runEvent(writePayload(join(env.cwd, "packages", "app", "src", "a.ts")), { env });
      await runEvent(writePayload(join(env.cwd, "packages", "lib", "b.ts")), { env });

      expect(runner.runs.map((r) => [r.command, r.options.cwd])).toEqual([
        ["biome", join(env.cwd, "packages", "app")],
        ["prettier", env.cwd],
      ]);
    });

    it("does not look above the repository root", async () => {
      const runner = recordingProcessRunner();
      const env = project({ "repo/.git/HEAD": "", "repo/a.ts": "" }, { processRunner: runner });
      write(join(env.cwd, ".prettierrc"), "{}");

      expectNoDecision(await runEvent(writePayload(join(env.cwd, "repo", "a.ts")), { env }));
      expect(runner.runs).toEqual([]);
    });
  });

  describe("options", () => {
    it("`command` replaces detection, with `{file}` standing for the edited file", async () => {
      const runner = recordingProcessRunner();
      const env = project({ ".prettierrc": "{}", "src/a.ts": "" }, { processRunner: runner });
      writeRepoConfig(env, { hooks: { "format-on-edit": { command: ["fmt", "--in-place", "{file}", "--quiet"] } } });
      const file = join(env.cwd, "src", "a.ts");

      expectNoDecision(await runEvent(writePayload(file), { env }));

      expect(runner.runs.map(({ command, args, options }) => ({ command, args, cwd: options.cwd }))).toEqual([
        { command: "fmt", args: ["--in-place", file, "--quiet"], cwd: env.cwd },
      ]);
    });

    it("`command` without `{file}` gets the edited file appended, whatever its type", async () => {
      const runner = recordingProcessRunner();
      const env = project({ "notes.txt": "" }, { processRunner: runner });
      writeRepoConfig(env, { hooks: { "format-on-edit": { command: ["fmt"] } } });

      await runEvent(writePayload(join(env.cwd, "notes.txt")), { env });

      expect(runner.runs.map((r) => [r.command, ...r.args])).toEqual([["fmt", join(env.cwd, "notes.txt")]]);
    });

    it("`timeoutMs` bounds a hung formatter, which is then ignored", { timeout: 20_000 }, async () => {
      const env = project({ "a.ts": "const  a=1\n" }, { processRunner: "real" });
      writeRepoConfig(env, {
        hooks: { "format-on-edit": { command: ["node", "-e", "setTimeout(() => {}, 15000)"], timeoutMs: 300 } },
      });
      const started = Date.now();

      const result = await runEvent(writePayload(join(env.cwd, "a.ts")), { env });

      expectNoDecision(result);
      expect(result.stderr).toBe("");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(read(join(env.cwd, "a.ts"))).toBe("const  a=1\n");
    });

    it("`timeoutMs` holds even when the formatter's own child process keeps running", { timeout: 20_000 }, async () => {
      // Like the biome and dprint npm wrappers: node starts the real binary, which inherits stdout/stderr.
      const wrapper =
        "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], " +
        "{ stdio: 'inherit', cwd: require('os').tmpdir() }); setTimeout(() => {}, 15000)";
      const env = project({ "a.ts": "" }, { processRunner: "real" });
      writeRepoConfig(env, { hooks: { "format-on-edit": { command: ["node", "-e", wrapper], timeoutMs: 300 } } });
      const started = Date.now();

      expectNoDecision(await runEvent(writePayload(join(env.cwd, "a.ts")), { env }));
      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it("a `command` that cannot be started is ignored quietly", async () => {
      // Node refuses this synchronously, as it does Windows .cmd shims run without a shell.
      const env = project({ "a.ts": "" }, { processRunner: "real" });
      writeRepoConfig(env, { hooks: { "format-on-edit": { command: ["fmt\u0000"] } } });

      const result = await runEvent(writePayload(join(env.cwd, "a.ts")), { env });

      expectNoDecision(result);
      expect(result.stderr).toBe("");
    });

    it("can be turned off", async () => {
      const runner = recordingProcessRunner();
      const env = project({ ".prettierrc": "{}", "a.ts": "" }, { processRunner: runner });
      writeRepoConfig(env, { hooks: { "format-on-edit": { enabled: false } } });

      expectNoDecision(await runEvent(writePayload(join(env.cwd, "a.ts")), { env }));
      expect(runner.runs).toEqual([]);
    });
  });

  describe("stays silent and leaves the file alone", () => {
    it("when the project configures no formatter", async () => {
      const runner = recordingProcessRunner();
      const env = project({ "a.ts": "const  a=1\n", "b.py": "b=1\n" }, { processRunner: runner });

      for (const name of ["a.ts", "b.py"]) {
        const result = await runEvent(writePayload(join(env.cwd, name)), { env });
        expectNoDecision(result);
        expect(result.stderr).toBe("");
      }
      expect(runner.runs).toEqual([]);
    });

    it("when no configured formatter handles the file type", async () => {
      const runner = recordingProcessRunner();
      const env = project({ ".prettierrc": "{}", "ruff.toml": "", "notes.txt": "x\n" }, { processRunner: runner });

      expectNoDecision(await runEvent(writePayload(join(env.cwd, "notes.txt")), { env }));
      expect(runner.runs).toEqual([]);
    });

    it("when the edited file no longer exists", async () => {
      const runner = recordingProcessRunner();
      const env = project({ ".prettierrc": "{}" }, { processRunner: runner });

      expectNoDecision(await runEvent(writePayload(join(env.cwd, "gone.ts")), { env }));
      expect(runner.runs).toEqual([]);
    });

    it.each([
      { failure: "the formatter fails", result: { exitCode: 2, stderr: "error: cannot parse app.py" } },
      { failure: "the formatter times out", result: { exitCode: null, timedOut: true } },
      { failure: "the formatter is not installed", result: { exitCode: null, spawnError: "spawn ruff ENOENT" } },
    ])("when $failure", async ({ result: failure }) => {
      const runner = fakeFormatter("ruff", "", failure);
      const env = project({ "ruff.toml": "", "app.py": "x=(\n" }, { processRunner: runner });
      const file = join(env.cwd, "app.py");

      const result = await runEvent(writePayload(file), { env });

      expectNoDecision(result);
      expect(result.stderr).toBe("");
      expect(runner.runs).toHaveLength(1);
      expect(read(file)).toBe("x=(\n");
    });
  });

  describe("prefers project-local binaries", () => {
    const ruffProject = { "ruff.toml": "", "pkg/app.py": "x=1\n" };

    it.each([
      { platform: "linux" as const, venv: ".venv", bin: join("bin", "ruff") },
      { platform: "darwin" as const, venv: "venv", bin: join("bin", "ruff") },
      { platform: "win32" as const, venv: ".venv", bin: join("Scripts", "ruff.exe") },
    ])("uses ruff from the project's $venv on $platform", async ({ platform, venv, bin }) => {
      const runner = fakeFormatter("ruff", "x = 1\n");
      const env = project({ ...ruffProject, [join(venv, bin)]: "" }, { processRunner: runner, platform });
      const file = join(env.cwd, "pkg", "app.py");

      expectNoDecision(await runEvent(writePayload(file), { env }));

      expect(runner.runs.map((r) => r.command)).toEqual([join(env.cwd, venv, bin)]);
      expect(read(file)).toBe("x = 1\n");
    });

    it("falls back to ruff on PATH without a project virtualenv", async () => {
      const runner = fakeFormatter("ruff", "x = 1\n");
      const env = project(ruffProject, { processRunner: runner });

      await runEvent(writePayload(join(env.cwd, "pkg", "app.py")), { env });

      expect(runner.runs.map((r) => r.command)).toEqual(["ruff"]);
    });

    it("runs prettier from the nearest node_modules with node, not through a .bin shim", async () => {
      const runner = recordingProcessRunner();
      const env = project(
        {
          "package.json": JSON.stringify({ prettier: { semi: false } }),
          "node_modules/prettier/package.json": JSON.stringify({ name: "prettier", bin: "./bin/prettier.cjs" }),
          "web/a.ts": "a\n",
        },
        { processRunner: runner },
      );

      await runEvent(writePayload(join(env.cwd, "web", "a.ts")), { env });

      expect(runner.runs).toHaveLength(1);
      expect(runner.runs[0]!.command).toBe("node");
      expect(runner.runs[0]!.args[0]).toBe(join(env.cwd, "node_modules", "prettier", "bin", "prettier.cjs"));
    });

    it("falls back to prettier on PATH when the project has none installed", async () => {
      const runner = recordingProcessRunner();
      const env = project({ ".prettierrc": "{}", "a.ts": "a\n" }, { processRunner: runner });

      await runEvent(writePayload(join(env.cwd, "a.ts")), { env });

      expect(runner.runs.map((r) => r.command)).toEqual(["prettier"]);
    });
  });
});
