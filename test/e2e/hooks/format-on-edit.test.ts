/**
 * format-on-edit through `hardhooks run PostToolUse`, as a Host runs it: a
 * real prettier formats a file end to end; every other formatter is a fake
 * that records how it was run (program, arguments, working directory), since
 * the product's only job is to run the right one on the right file. Node
 * formatters (prettier, biome, dprint) are fake packages in `node_modules`
 * and run on every OS; gofmt, rustfmt, ruff and black are spawned by bare
 * name without a shell, so their fakes on PATH work on POSIX only.
 * Detected formatters run only in a trusted project (ADR-0005), so most
 * tests write the project, then `box.trust()`.
 */
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  expectFixture,
  expectMessage,
  expectNoDecision,
  hookFixtures,
  observe,
  sandbox,
  type FakeBehaviour,
  type FakeCall,
  type FakeProgram,
  type Sandbox,
} from "../helpers";

const isWindows = process.platform === "win32";
/** Why bare-name formatter fakes are POSIX only: a spawn without a shell finds only .exe files on Windows. */
const noBareNameFakes = "Windows: the product spawns this formatter by bare name without a shell, so only a real .exe would do";

const repoPrettier = fileURLToPath(new URL("../../../node_modules/prettier", import.meta.url));

const read = (path: string) => readFileSync(path, "utf8");

const writePayload = (file: string) => claudeCode.postToolUse("Write", { file_path: file, content: "..." });

/** A sandbox whose project is a repository root (holds `.git`), so detection never looks above it, with these files. */
function project(files: Record<string, string>): Sandbox {
  const box = sandbox();
  mkdirSync(join(box.project, ".git"));
  for (const [path, content] of Object.entries(files)) box.writeFile(path, content);
  return box;
}

type FormatterName = "prettier" | "biome" | "ruff" | "black" | "gofmt" | "rustfmt" | "dprint";
const nodePackages: Partial<Record<FormatterName, string>> = { prettier: "prettier", biome: "@biomejs/biome", dprint: "dprint" };
/** Whether the product finds this formatter on PATH by bare name (so its fake is POSIX only). */
const onPath = (formatter: FormatterName) => nodePackages[formatter] === undefined;

/** A fake `formatter` where the product looks for it: a Node package in the project's node_modules, else on PATH. */
function fakeFormatter(box: Sandbox, formatter: FormatterName, behaviour: FakeBehaviour = {}): FakeProgram {
  const pkg = nodePackages[formatter];
  return pkg === undefined ? box.fakeProgram(formatter, behaviour) : box.fakeNodePackage(pkg, formatter, behaviour);
}

/** A fake of every formatter the Hook knows, so a test can see which one ran (if any). */
function fakeFormatters(box: Sandbox): Record<FormatterName, FakeProgram> {
  const names: FormatterName[] = ["prettier", "biome", "ruff", "black", "gofmt", "rustfmt", "dprint"];
  return Object.fromEntries(names.map((name) => [name, fakeFormatter(box, name)])) as Record<FormatterName, FakeProgram>;
}

/** Names of the fakes that were run, once per call. */
const ran = (fakes: Record<string, FakeProgram>) => Object.entries(fakes).flatMap(([name, fake]) => fake.calls().map(() => name));

/** The file a formatter call was given: its last argument, resolved against its working directory. */
const fileOf = (call: FakeCall) => resolve(call.cwd, call.argv.at(-1)!);

/**
 * A fake program for a configured `command`, run as `node <script>` (so on
 * every OS), kept outside the project. `commandFor(fake, ...args)` is the
 * `command` option that runs it.
 */
const fakeCommand = (box: Sandbox, name: string, behaviour: FakeBehaviour = {}) =>
  box.fakeNodePackage(name, name, behaviour, box.root);
const commandFor = (fake: FakeProgram, ...args: string[]) => ["node", fake.path, ...args];

describe("format-on-edit", () => {
  describe("with a real prettier", () => {
    it("formats the file the Host wrote, silently, and leaves every other file alone", async () => {
      const box = project({
        ".prettierrc": JSON.stringify({ semi: false }),
        "src/edited.ts": "const  x = {a:1,b:2};\n",
        "src/untouched.ts": "const  y = {c:3};\n",
      });
      // This repo's prettier, installed as the project's own (a junction on Windows).
      mkdirSync(join(box.project, "node_modules"));
      symlinkSync(repoPrettier, join(box.project, "node_modules", "prettier"), "junction");
      await box.trust();
      const file = join(box.project, "src", "edited.ts");

      const result = await box.event(claudeCode.postToolUse("Write", { file_path: file, content: "..." }));

      expectNoDecision(result);
      expect(result.stderr).toBe("");
      expect(read(file)).toBe("const x = { a: 1, b: 2 }\n");
      expect(read(join(box.project, "src", "untouched.ts"))).toBe("const  y = {c:3};\n");
    });
  });

  it.skipIf(isWindows)("formats a .py file in a ruff-configured project with `ruff format`", async () => {
    // Windows: ruff is spawned by bare name without a shell; a fake can't stand in for ruff.exe.
    const box = project({ "pyproject.toml": "[project]\nname = 'demo'\n\n[tool.ruff]\nline-length = 100\n", "app.py": "x=1\n" });
    const ruff = box.fakeProgram("ruff");
    await box.trust();
    const file = join(box.project, "app.py");

    expectNoDecision(await box.event(writePayload(file)));

    expect(ruff.calls()).toHaveLength(1);
    expect(ruff.calls()[0]!.argv).toContain("format");
    expect(fileOf(ruff.calls()[0]!)).toBe(file);
  });

  it.each([
    { tool: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } },
    { tool: "MultiEdit", input: { file_path: "src/a.ts", edits: [] } },
  ])("formats after $tool too, resolving a relative path against the project", async ({ tool, input }) => {
    const box = project({ ".prettierrc": "{}", "src/a.ts": "b\n" });
    const prettier = fakeFormatter(box, "prettier");
    await box.trust();

    expectNoDecision(await box.event(claudeCode.postToolUse(tool, input)));

    expect(prettier.calls().map(fileOf)).toEqual([join(box.project, "src", "a.ts")]);
  });

  it("ignores tools that do not edit files, and runs only after the edit", async () => {
    const box = project({ ".prettierrc": "{}", "a.ts": "" });
    const prettier = fakeFormatter(box, "prettier");
    await box.trust();
    const file = join(box.project, "a.ts");

    expectNoDecision(await box.event(claudeCode.postToolUse("Bash", { command: `touch ${file}` })));
    expectNoDecision(await box.event(claudeCode.postToolUse("Read", { file_path: file })));
    expectNoDecision(await box.event(claudeCode.preToolUse("Write", { file_path: file, content: "" })));
    expect(prettier.calls()).toEqual([]);
  });

  describe("detects the formatter from project config", () => {
    it.for<{ formatter: FormatterName; config: Record<string, string>; file: string; args: string[] }>([
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
    ])("$formatter for $file with $config", async ({ formatter, config, file, args }, { skip }) => {
      skip(isWindows && onPath(formatter), noBareNameFakes);
      const box = project({ ...config, [file]: "unformatted\n" });
      const fakes = fakeFormatters(box);
      await box.trust();
      const path = join(box.project, file);

      expectNoDecision(await box.event(writePayload(path)));

      expect(ran(fakes)).toEqual([formatter]);
      const [call] = fakes[formatter].calls();
      expect(call!.argv).toEqual(expect.arrayContaining(args));
      expect(fileOf(call!)).toBe(path);
    });

    it.skipIf(isWindows)("passes the Rust edition from Cargo.toml, as cargo fmt would", async () => {
      // Windows: rustfmt is spawned by bare name without a shell; a fake can't stand in for rustfmt.exe.
      const box = project({ "Cargo.toml": '[package]\nname = "demo"\nedition = "2021"\n', "src/lib.rs": "" });
      const rustfmt = box.fakeProgram("rustfmt");
      await box.trust();

      await box.event(writePayload(join(box.project, "src", "lib.rs")));

      expect(rustfmt.calls()[0]!.argv).toEqual(expect.arrayContaining(["--edition", "2021"]));
    });

    it.skipIf(isWindows)("prefers ruff over black when pyproject.toml configures both", async () => {
      // Windows: ruff and black are spawned by bare name without a shell; fakes can't stand in for their .exe.
      const box = project({ "pyproject.toml": "[tool.black]\n\n[tool.ruff.lint]\nselect = ['E']\n", "a.py": "" });
      const fakes = fakeFormatters(box);
      await box.trust();

      await box.event(writePayload(join(box.project, "a.py")));

      expect(ran(fakes)).toEqual(["ruff"]);
    });

    it("uses the config nearest the edited file", async () => {
      const box = project({ ".prettierrc": "{}", "packages/app/biome.json": "{}", "packages/app/src/a.ts": "", "packages/lib/b.ts": "" });
      const fakes = fakeFormatters(box);
      await box.trust();

      await box.event(writePayload(join(box.project, "packages", "app", "src", "a.ts")));
      await box.event(writePayload(join(box.project, "packages", "lib", "b.ts")));

      expect(ran(fakes).sort()).toEqual(["biome", "prettier"]);
      expect(fakes.biome.calls().map((call) => call.cwd)).toEqual([join(box.project, "packages", "app")]);
      expect(fakes.prettier.calls().map((call) => call.cwd)).toEqual([box.project]);
    });

    it("does not look above the repository root", async () => {
      const box = project({ "repo/.git/HEAD": "", "repo/a.ts": "" });
      box.writeFile(".prettierrc", "{}");
      const fakes = fakeFormatters(box);
      await box.trust();

      expectNoDecision(await box.event(writePayload(join(box.project, "repo", "a.ts"))));
      expect(ran(fakes)).toEqual([]);
    });
  });

  describe("options", () => {
    it("`command` replaces detection, with `{file}` standing for the edited file", async () => {
      const box = project({ ".prettierrc": "{}", "src/a.ts": "" });
      const prettier = fakeFormatter(box, "prettier");
      const fmt = fakeCommand(box, "fmt");
      box.writeRepoConfig({ hooks: { "format-on-edit": { command: commandFor(fmt, "--in-place", "{file}", "--quiet") } } });
      await box.trust();
      const file = join(box.project, "src", "a.ts");

      expectNoDecision(await box.event(writePayload(file)));

      expect(fmt.calls().map(({ argv, cwd }) => ({ argv, cwd }))).toEqual([{ argv: ["--in-place", file, "--quiet"], cwd: box.project }]);
      expect(prettier.calls()).toEqual([]);
    });

    it("`command` without `{file}` gets the edited file appended, whatever its type", async () => {
      const box = project({ "notes.txt": "" });
      const fmt = fakeCommand(box, "fmt");
      box.writeRepoConfig({ hooks: { "format-on-edit": { command: commandFor(fmt) } } });
      await box.trust();

      await box.event(writePayload(join(box.project, "notes.txt")));

      expect(fmt.calls().map((call) => call.argv)).toEqual([[join(box.project, "notes.txt")]]);
    });

    // These two bound the run by the formatter's own delay, with a wide margin for a loaded
    // CI runner (ADR-0006): a CLI that waited for the formatter would take the whole delay.
    it("`timeoutMs` bounds a hung formatter, which is then ignored", async () => {
      const box = project({ "a.ts": "const  a=1\n" });
      const hangMs = 15_000;
      const hung = fakeCommand(box, "hung-fmt", { delayMs: hangMs });
      box.writeRepoConfig({ hooks: { "format-on-edit": { command: commandFor(hung), timeoutMs: 300 } } });
      await box.trust();

      const result = await box.event(writePayload(join(box.project, "a.ts")));

      expectNoDecision(result);
      expect(result.stderr).toBe("");
      expect(result.durationMs).toBeLessThan(hangMs / 2);
      expect(read(join(box.project, "a.ts"))).toBe("const  a=1\n");
    });

    it("`timeoutMs` holds even when the formatter's own child process keeps running", async () => {
      // Like the biome and dprint npm wrappers: node starts the real binary, which inherits stdout/stderr.
      const box = project({ "a.ts": "" });
      const hangMs = 15_000;
      const binary = fakeCommand(box, "native-fmt", { delayMs: hangMs });
      const wrapper =
        `require('child_process').spawn(process.execPath, [${JSON.stringify(binary.path)}], ` +
        `{ stdio: 'inherit', cwd: require('os').tmpdir() }); setTimeout(() => {}, ${hangMs})`;
      box.writeRepoConfig({ hooks: { "format-on-edit": { command: ["node", "-e", wrapper], timeoutMs: 300 } } });
      await box.trust();

      const result = await box.event(writePayload(join(box.project, "a.ts")));

      expectNoDecision(result);
      expect(result.durationMs).toBeLessThan(hangMs / 2);
    });

    it("a `command` that cannot be started is ignored quietly", async () => {
      // Node refuses this synchronously, as it does Windows .cmd shims run without a shell.
      const box = project({ "a.ts": "" });
      box.writeRepoConfig({ hooks: { "format-on-edit": { command: ["fmt\u0000"] } } });
      await box.trust();

      const result = await box.event(writePayload(join(box.project, "a.ts")));

      expectNoDecision(result);
      expect(result.stderr).toBe("");
    });

    it("can be turned off", async () => {
      const box = project({ ".prettierrc": "{}", "a.ts": "" });
      const prettier = fakeFormatter(box, "prettier");
      box.writeRepoConfig({ hooks: { "format-on-edit": { enabled: false } } });
      await box.trust();

      expectNoDecision(await box.event(writePayload(join(box.project, "a.ts"))));
      expect(prettier.calls()).toEqual([]);
    });
  });

  describe("stays silent and leaves the file alone", () => {
    it("when the project configures no formatter", async () => {
      const box = project({ "a.ts": "const  a=1\n", "b.py": "b=1\n" });
      const fakes = fakeFormatters(box);
      await box.trust();

      for (const name of ["a.ts", "b.py"]) {
        const result = await box.event(writePayload(join(box.project, name)));
        expectNoDecision(result);
        expect(result.stderr).toBe("");
      }
      expect(ran(fakes)).toEqual([]);
    });

    it("when no configured formatter handles the file type", async () => {
      const box = project({ ".prettierrc": "{}", "ruff.toml": "", "notes.txt": "x\n" });
      const fakes = fakeFormatters(box);
      await box.trust();

      expectNoDecision(await box.event(writePayload(join(box.project, "notes.txt"))));
      expect(ran(fakes)).toEqual([]);
    });

    it("when the edited file no longer exists", async () => {
      const box = project({ ".prettierrc": "{}" });
      const fakes = fakeFormatters(box);
      await box.trust();

      expectNoDecision(await box.event(writePayload(join(box.project, "gone.ts"))));
      expect(ran(fakes)).toEqual([]);
    });

    // prettier (a Node package) rather than ruff, so these run on every OS; "not installed" leaves no fake to run.
    it.each<{ failure: string; behaviour?: FakeBehaviour; timeoutMs?: number }>([
      { failure: "the formatter fails", behaviour: { exitCode: 2, stderr: "[error] a.ts: SyntaxError: ')' expected." } },
      { failure: "the formatter times out", behaviour: { delayMs: 15_000 }, timeoutMs: 300 },
      { failure: "the formatter is not installed" },
    ])("when $failure", async ({ behaviour, timeoutMs }) => {
      const box = project({ ".prettierrc": "{}", "a.ts": "x=(\n" });
      const prettier = behaviour === undefined ? undefined : fakeFormatter(box, "prettier", behaviour);
      if (timeoutMs !== undefined) box.writeRepoConfig({ hooks: { "format-on-edit": { timeoutMs } } });
      await box.trust();
      const file = join(box.project, "a.ts");

      const result = await box.event(writePayload(file));

      expectNoDecision(result);
      expect(result.stderr).toBe("");
      if (prettier !== undefined) expect(prettier.calls()).toHaveLength(1);
      expect(read(file)).toBe("x=(\n");
    });
  });

  describe("in an untrusted project", () => {
    it.each<{ formatter: FormatterName; files: Record<string, string>; file: string; from: "node_modules" | "PATH" }>([
      { formatter: "prettier", files: { ".prettierrc": "{}" }, file: "a.ts", from: "node_modules" },
      // On PATH, but the project's config chooses it (and prettier config can load plugins).
      { formatter: "prettier", files: { ".prettierrc": JSON.stringify({ plugins: ["./evil.js"] }) }, file: "a.ts", from: "PATH" },
      { formatter: "gofmt", files: { "go.mod": "module example.com/demo\n" }, file: "main.go", from: "PATH" },
    ])("does not run $formatter, and tells the user once per session", async ({ formatter, files, file, from }) => {
      const box = project({ ...files, [file]: "x\n" });
      const fake = from === "PATH" ? box.fakeProgram(formatter) : fakeFormatter(box, formatter);
      const path = join(box.project, file);

      const first = await box.event(writePayload(path));
      const second = await box.event(writePayload(path));

      expect(fake.calls()).toEqual([]);
      expectMessage(first, new RegExp(`format-on-edit\\] skipped ${formatter}: this project is not trusted.*hardhooks trust`));
      expect(observe(first).decision).toBe("none");
      expectNoDecision(second);
    });

    it("does not run a `command` from the repo config, but does run the user config's", async () => {
      const box = project({ "a.ts": "x\n" });
      const evil = fakeCommand(box, "evil");
      const dprint = fakeCommand(box, "dprint");
      box.writeRepoConfig({ hooks: { "format-on-edit": { command: commandFor(evil) } } });
      const file = join(box.project, "a.ts");

      expectMessage(await box.event(writePayload(file)), /format-on-edit\.command from \.hardhooks\.json/);
      expect(evil.calls()).toEqual([]);

      box.writeUserConfig({ hooks: { "format-on-edit": { command: commandFor(dprint, "fmt") } } });
      await box.event(writePayload(file));
      expect(evil.calls()).toEqual([]);
      expect(dprint.calls().map((call) => call.argv)).toEqual([["fmt", file]]);
    });

    it.skipIf(isWindows)("formats once the user trusts the project", async () => {
      // Windows: gofmt is spawned by bare name without a shell; a fake can't stand in for gofmt.exe.
      const box = project({ "go.mod": "module example.com/demo\n", "main.go": "x\n" });
      const fakes = fakeFormatters(box);
      await box.trust();

      expectNoDecision(await box.event(writePayload(join(box.project, "main.go"))));
      expect(ran(fakes)).toEqual(["gofmt"]);
    });
  });

  it.each(hookFixtures("format-on-edit"))("fixture $file: $description", async (fixture) => {
    expectFixture(await sandbox().event(JSON.stringify(fixture.payload), { event: fixture.event }), fixture);
  });

  describe("prefers project-local binaries", () => {
    const ruffProject = { "ruff.toml": "", "pkg/app.py": "x=1\n" };

    it.for([
      { platform: "linux", venv: ".venv", bin: join("bin", "ruff") },
      { platform: "darwin", venv: "venv", bin: join("bin", "ruff") },
      { platform: "win32", venv: ".venv", bin: join("Scripts", "ruff.exe") },
    ])("uses ruff from the project's $venv on $platform", async ({ platform, venv, bin }, { skip }) => {
      // Each row runs on its own OS. Windows: the virtualenv's ruff.exe would have to be a real .exe, which a fake can't be.
      skip(process.platform !== platform || platform === "win32", `${platform} only; a fake can't be a Windows .exe`);
      const box = project(ruffProject);
      const venvRuff = box.fakeProgramAt(join(venv, bin));
      const pathRuff = box.fakeProgram("ruff");
      await box.trust();
      const file = join(box.project, "pkg", "app.py");

      expectNoDecision(await box.event(writePayload(file)));

      expect(venvRuff.calls().map(fileOf)).toEqual([file]);
      expect(pathRuff.calls()).toEqual([]);
    });

    it.skipIf(isWindows)("falls back to ruff on PATH without a project virtualenv", async () => {
      // Windows: ruff is spawned by bare name without a shell; a fake can't stand in for ruff.exe.
      const box = project(ruffProject);
      const ruff = box.fakeProgram("ruff");
      await box.trust();

      await box.event(writePayload(join(box.project, "pkg", "app.py")));

      expect(ruff.calls().map(fileOf)).toEqual([join(box.project, "pkg", "app.py")]);
    });

    it("runs prettier from the nearest node_modules with node, not through a .bin shim", async () => {
      const box = project({ "package.json": JSON.stringify({ prettier: { semi: false } }), "web/a.ts": "a\n" });
      // The fake package's bin script records only when node runs it; the PATH prettier (POSIX) must stay unused.
      const local = box.fakeNodePackage("prettier", "prettier");
      const pathPrettier = box.fakeProgram("prettier");
      await box.trust();

      await box.event(writePayload(join(box.project, "web", "a.ts")));

      expect(local.calls()).toHaveLength(1);
      expect(pathPrettier.calls()).toEqual([]);
    });

    it.skipIf(isWindows)("falls back to prettier on PATH when the project has none installed", async () => {
      // Windows: without node_modules, prettier is spawned by bare name without a shell; a fake can't stand in for an .exe.
      const box = project({ ".prettierrc": "{}", "a.ts": "a\n" });
      const prettier = box.fakeProgram("prettier");
      await box.trust();

      await box.event(writePayload(join(box.project, "a.ts")));

      expect(prettier.calls()).toHaveLength(1);
    });
  });
});
