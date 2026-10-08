/**
 * A hermetic world for one test of the real CLI: a temp home, project dir,
 * fake-program dir and environment, under the run's temp root (removed when
 * the run ends, so there is no per-test cleanup and tests may run
 * concurrently). Nothing is inherited from the developer's environment:
 * no Host variables (`CLAUDECODE`, `CURSOR_VERSION`, …), no XDG or APPDATA
 * overrides, `TZ=UTC`, no PATH beyond fakes plus real node and git (opt in to system
 * tools with `systemPath`), and git's system config off.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { expect, inject } from "vitest";
import { hardhooks, type CliResult, type Env } from "./cli";
import { writeFakeNodePackage, writeFakeProgram, type FakeBehaviour, type FakeProgram } from "./fake-program";
import { writeProjectFile } from "./files";
import type { ClaudeCodePayload } from "./payloads";

export interface SandboxOptions {
  /** Fix the CLI's clock for every run (`HARDHOOKS_NOW`, ISO 8601). Default: the real clock. */
  now?: string;
  /** Extra variables for every run (undefined removes one), e.g. a Host's `CURSOR_VERSION`. */
  env?: Env;
  /** Make the project a real git repo (`initGitRepo` options). Default: a plain directory. */
  git?: boolean | GitRepoOptions;
  /**
   * Also put `/usr/bin:/bin` on PATH, for command lines that need `sleep`,
   * `cat` and friends. Off by default: on macOS `/usr/bin` holds `osascript`,
   * so notify would show real notifications. (Windows always gets
   * `%SystemRoot%\System32`, which holds no notifier.)
   */
  systemPath?: boolean;
}

export interface RunOptions {
  stdin?: string;
  /** Default: the project dir. */
  cwd?: string;
  /** On top of the sandbox env; undefined removes a variable. */
  env?: Env;
  /** `HARDHOOKS_NOW` for this run only. */
  now?: string;
  timeoutMs?: number;
  /** Run this copy of the bundle (see `copyBundle`) instead of the built one. */
  bundle?: string;
}

export interface EventOptions extends Omit<RunOptions, "stdin"> {
  /** The Event named on the command line. Default: the payload's `hook_event_name` (PreToolUse for a string payload). */
  event?: string;
}

export interface GitRepoOptions {
  /** Initial branch. Default "main". */
  branch?: string;
  /** Make `origin/HEAD` point at this branch, as a clone of a repo with that default branch would. */
  originHead?: string;
  /** Start with one empty commit named "initial", so the branch exists. Default true. */
  initialCommit?: boolean;
}

export interface GitRepo {
  readonly dir: string;
  /** Run real git in the repo (hermetic env) and return its stdout. Throws on failure. */
  git(...args: string[]): string;
  /** Write `files` (default: one file named after the message), stage everything and commit. */
  commit(message: string, files?: Record<string, string>): void;
}

export interface Sandbox {
  readonly root: string;
  /** `HOME` (and `USERPROFILE`) of every run. */
  readonly home: string;
  /** The project: default cwd of runs and the payload's `cwd`. */
  readonly project: string;
  /** Fake programs dir, first on PATH. */
  readonly bin: string;
  /** The environment every run starts from. */
  readonly env: Readonly<Env>;
  /** Where the CLI keeps state on this OS, given `env` (audit logs, trust, check, notify). */
  readonly stateDir: string;
  /** Where the CLI reads the user config on this OS, given `env`. */
  readonly userConfigFile: string;

  /** `hardhooks <args>` in the project. */
  run(args: readonly string[], options?: RunOptions): Promise<CliResult>;
  /**
   * `hardhooks run <Event>` with a Host payload on stdin. An object payload
   * gets `cwd` set to the run's cwd (the project); a string is sent verbatim.
   */
  event(payload: ClaudeCodePayload | string, options?: EventOptions): Promise<CliResult>;
  /** Write `.hardhooks.json` (an object, or raw text) into `dir` (default: the project). Returns its path. */
  writeRepoConfig(config: object | string, dir?: string): string;
  /** Write the user config where the CLI looks for it on this OS. Returns its path. */
  writeUserConfig(config: object | string): string;
  /** Write a file relative to the project (or at an absolute path). Returns its absolute path. */
  writeFile(path: string, content?: string): string;
  /** Trust `dir` (default: the project) by running the real `hardhooks trust --yes`. Write its files first: trust covers them. */
  trust(dir?: string): Promise<void>;
  /** Make `dir` (default: the project) a real git repo with a fixed identity, using the real git even if a fake is on PATH. */
  initGitRepo(dir?: string, options?: GitRepoOptions): GitRepo;
  /** A fake program called `name` on PATH (see ./fake-program.ts for where fakes work). */
  fakeProgram(name: string, behaviour?: FakeBehaviour): FakeProgram;
  /** A fake program at an exact path, e.g. `.venv/bin/ruff` (relative paths are under the project). POSIX only. */
  fakeProgramAt(path: string, behaviour?: FakeBehaviour): FakeProgram;
  /** A fake Node package in `dir/node_modules` (default: the project), run as `node <bin script>` on every OS. */
  fakeNodePackage(pkg: string, bin: string, behaviour?: FakeBehaviour, dir?: string): FakeProgram;
  /** Every audit-log entry written so far, oldest first (all projects and days). */
  auditLog(): Record<string, any>[];
}

/** The state dir hardhooks uses, written out independently of `src/environment`. */
function stateDirFor(env: Env, home: string): string {
  if (process.platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "hardhooks", "state");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "hardhooks", "state");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "hardhooks");
}

/** The user config file hardhooks reads, written out independently of `src/config`. */
function userConfigFor(env: Env, home: string): string {
  if (process.platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "hardhooks", "config.json");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "hardhooks", "config.json");
}

const systemDirs = () =>
  process.platform === "win32"
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"]
    : ["/usr/bin", "/bin"];

/** Remove undefined values, apply overrides. */
function merge(base: Env, overrides: Env = {}): Env {
  const out: Env = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

function toJson(content: object | string): string {
  return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}

/** A new sandbox for the current test. Call it inside the test (each test gets its own). */
export function sandbox(options: SandboxOptions = {}): Sandbox {
  const context = inject("hardhooksE2E");
  const root = mkdtempSync(join(context.runRoot, "s-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const fakes = join(root, "fakes");
  const tmp = join(root, "tmp");
  for (const dir of [home, project, bin, fakes, tmp]) mkdirSync(dir, { recursive: true });

  // Windows always gets System32 (taskkill, cmd.exe's tools; no notifier lives there); POSIX opts in.
  const system = options.systemPath || process.platform === "win32" ? systemDirs() : [];
  const path = [bin, ...context.toolsPath, ...system].join(delimiter);
  const windows: Env =
    process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot,
          windir: process.env.windir,
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          // Without these Windows falls back to %SystemRoot%\temp, which users can't write.
          TEMP: tmp,
          TMP: tmp,
        }
      : {};
  const env = merge(
    {
      HOME: home,
      USERPROFILE: home,
      PATH: path,
      GIT_CONFIG_NOSYSTEM: "1",
      // Dates the CLI prints (session-context's "Today") are local time.
      TZ: "UTC",
      ...windows,
      ...(options.now !== undefined ? { HARDHOOKS_NOW: options.now } : {}),
    },
    options.env,
  );
  const stateDir = stateDirFor(env, home);
  const userConfigFile = userConfigFor(env, home);
  const abs = (p: string) => (isAbsolute(p) ? p : join(project, p));

  const box: Sandbox = {
    root,
    home,
    project,
    bin,
    env,
    stateDir,
    userConfigFile,

    run(args, run = {}) {
      return hardhooks(args, {
        cwd: run.cwd ?? project,
        env: merge(env, { ...run.env, ...(run.now !== undefined ? { HARDHOOKS_NOW: run.now } : {}) }),
        ...(run.stdin !== undefined ? { stdin: run.stdin } : {}),
        ...(run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {}),
        ...(run.bundle !== undefined ? { bundle: run.bundle } : {}),
      });
    },

    event(payload, run = {}) {
      const cwd = run.cwd ?? project;
      const stdin = typeof payload === "string" ? payload : JSON.stringify({ ...payload, cwd });
      const event = run.event ?? (typeof payload === "string" ? "PreToolUse" : payload.hook_event_name);
      return box.run(["run", event], { ...run, cwd, stdin });
    },

    writeRepoConfig(config, dir = project) {
      return box.writeFile(join(dir, ".hardhooks.json"), toJson(config));
    },

    writeUserConfig(config) {
      return box.writeFile(userConfigFile, toJson(config));
    },

    writeFile(file, content) {
      const full = abs(file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content ?? `${file}\n`);
      return full;
    },

    async trust(dir = project) {
      const result = await box.run(["trust", "--yes"], { cwd: dir });
      expect(result.exitCode, `hardhooks trust --yes failed:\n${result.stderr}`).toBe(0);
    },

    initGitRepo(dir = project, git = {}) {
      return initGitRepo(context.git, env, dir, git);
    },

    fakeProgram(name, behaviour = {}) {
      return writeFakeProgram(join(bin, name), behaviour, fakes);
    },

    fakeProgramAt(file, behaviour = {}) {
      return writeFakeProgram(abs(file), behaviour, fakes);
    },

    fakeNodePackage(pkg, binName, behaviour = {}, dir = project) {
      return writeFakeNodePackage(dir, pkg, binName, behaviour, fakes);
    },

    auditLog() {
      const base = join(stateDir, "audit-log");
      let projects: string[];
      try {
        projects = readdirSync(base);
      } catch {
        return [];
      }
      return projects
        .flatMap((dir) => readdirSync(join(base, dir)).map((file) => join(base, dir, file)))
        .sort()
        .flatMap((file) => readFileSync(file, "utf8").split("\n").filter((line) => line !== ""))
        .map((line) => JSON.parse(line) as Record<string, any>);
    },
  };

  if (options.git) box.initGitRepo(project, options.git === true ? {} : options.git);
  return box;
}

function initGitRepo(gitPath: string, env: Env, dir: string, options: GitRepoOptions): GitRepo {
  mkdirSync(dir, { recursive: true });
  const childEnv = merge(env) as Record<string, string>;
  const git = (...args: string[]) =>
    execFileSync(gitPath, args, { cwd: dir, env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", options.branch ?? "main");
  git("config", "user.name", "hardhooks test");
  git("config", "user.email", "test@hardhooks.invalid");
  git("config", "commit.gpgsign", "false");
  const commit = (message: string, files: Record<string, string> = {}) => {
    const entries = Object.entries(files);
    if (entries.length === 0) {
      entries.push([`${message.replace(/\W+/g, "-").toLowerCase().slice(0, 40)}.txt`, `${message}\n`]);
    }
    for (const [path, content] of entries) writeProjectFile(dir, path, content);
    git("add", "--all");
    git("commit", "--quiet", "--message", message);
  };
  if (options.initialCommit ?? true) git("commit", "-q", "--allow-empty", "-m", "initial");
  if (options.originHead !== undefined) {
    git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${options.originHead}`);
  }
  return { dir, git, commit };
}
