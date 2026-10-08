import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fakeEnvironment, type FakeEnvironment, type FakeEnvironmentOptions } from "./environment";

/**
 * Environment variables for running real git hermetically: the temp home
 * (from fakeEnvironment) replaces the user's global config, and the system
 * config is ignored. PATH (and SystemRoot on Windows) let git be found.
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
 */
export function hermeticGitEnvironment(options: Omit<FakeEnvironmentOptions, "processRunner"> = {}): FakeEnvironment {
  const probe = fakeEnvironment({ ...options, processRunner: "real" });
  return { ...probe, env: { ...gitEnv(probe.home), ...options.env } };
}

export interface RealGitRepo {
  readonly dir: string;
  /** Run git in the repo and return its stdout. Throws on failure. */
  git(...args: string[]): string;
}

export interface RealGitRepoOptions {
  /** Initial branch. Default "main". */
  branch?: string;
  /** Make `origin/HEAD` point at this branch, as a clone of a repo with that default branch would. */
  originHead?: string;
}

/**
 * Initialise a real git repo in `dir` (created if missing) with one empty
 * commit, using `env`'s hermetic home.
 */
export function initRealGitRepo(env: FakeEnvironment, dir: string = env.cwd, options: RealGitRepoOptions = {}): RealGitRepo {
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
  git("commit", "-q", "--allow-empty", "-m", "initial");
  if (options.originHead !== undefined) {
    git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${options.originHead}`);
  }
  return { dir, git };
}
