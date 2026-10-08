import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fakeEnvironment, type FakeEnvironment, type FakeEnvironmentOptions } from "./environment";
import { writeProjectFile } from "./files";

/**
 * Environment variables for running real git hermetically, the same for the
 * test's own git and the git a Hook runs through `env.processRunner`: the
 * temp home (from fakeEnvironment) replaces the user's global config, the
 * system config is ignored, and PATH (and SystemRoot on Windows) let git be
 * found. Works on Windows too, where Git for Windows reads `$HOME`.
 */
function gitEnv(home: string): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/**
 * A fakeEnvironment whose process runner spawns real programs, with an
 * environment in which real git works hermetically. Call inside a test.
 * `options.env` is added on top (e.g. PATHEXT for commands run through a shell).
 */
export function hermeticGitEnvironment(options: Omit<FakeEnvironmentOptions, "processRunner"> = {}): FakeEnvironment {
  const probe = fakeEnvironment({ ...options, processRunner: "real" });
  return { ...probe, env: { ...gitEnv(probe.home), ...options.env } };
}

export interface GitRepo {
  readonly dir: string;
  /** Run git in the repo and return its stdout. Throws on failure. */
  git(...args: string[]): string;
  /** Write `files` (default: one file named after the message), stage everything and commit. */
  commit(message: string, files?: Record<string, string>): void;
}

export interface GitRepoOptions {
  /** Initial branch. Default "main". */
  branch?: string;
  /** Make `origin/HEAD` point at this branch, as a clone of a repo with that default branch would. */
  originHead?: string;
  /** Start with one empty commit named "initial", so the branch exists. Default true. */
  initialCommit?: boolean;
}

/**
 * Initialise a real git repo in `dir` (created if missing) inside a
 * `hermeticGitEnvironment()`, with a fixed identity and no commit signing
 * in the repo's own config, so commits made by a Hook work too.
 */
export function initGitRepo(env: FakeEnvironment, dir: string = env.cwd, options: GitRepoOptions = {}): GitRepo {
  mkdirSync(dir, { recursive: true });
  const childEnv = Object.fromEntries(
    Object.entries(gitEnv(env.home)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
