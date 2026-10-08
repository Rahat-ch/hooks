/**
 * Read-only git queries, all run through `runGit()` (`./run.ts`): the
 * injected ProcessRunner, the Environment's variables, optional locks off.
 *
 * - For information (session-context, check, init): `gitStatus`,
 *   `recentCommitSubjects`, `isGitIgnored`, `workingTreeFingerprint`. Each
 *   returns undefined when `cwd` is not in a git work tree or git cannot
 *   run, so callers can degrade quietly.
 * - For Guards: `GitQueries` (`./queries.ts`), cached for one Event, and
 *   throwing on a timeout so the Guard fails closed.
 */
import { parsePorcelainV2 } from "./porcelain";
import { gitOutput, runGit, type GitEnvironment } from "./run";

export { workingTreeFingerprint } from "./fingerprint";
export { GitQueries, type PathContents } from "./queries";
export type { GitEnvironment } from "./run";

export interface GitStatus {
  /** Current branch name, or undefined when HEAD is detached. */
  branch: string | undefined;
  /** Abbreviated commit HEAD points at; undefined before the first commit. */
  head: string | undefined;
  /** The upstream branch with ahead/behind counts, when one is configured. */
  upstream: { name: string; ahead: number; behind: number } | undefined;
  /** Paths with staged, unstaged, untracked or conflicted changes, relative to the repo root. */
  dirty: string[];
}

const defaultTimeoutMs = 3000;

/** Branch, upstream ahead/behind and dirty paths, from `git status --porcelain=v2`. */
export async function gitStatus(
  env: GitEnvironment,
  cwd: string,
  timeoutMs = defaultTimeoutMs,
): Promise<GitStatus | undefined> {
  const out = await gitOutput(env, cwd, ["status", "--porcelain=v2", "--branch", "-z"], { timeoutMs });
  if (out === undefined) return undefined;
  const { headers, paths } = parsePorcelainV2(out);
  // Real git always reports the branch headers; anything else isn't git status.
  const oid = headers.get("branch.oid");
  if (oid === undefined) return undefined;
  const branch = headers.get("branch.head");
  const upstream = headers.get("branch.upstream");
  const ab = /^\+(\d+) -(\d+)$/.exec(headers.get("branch.ab") ?? "");
  return {
    branch: branch === "(detached)" ? undefined : branch,
    head: oid === "(initial)" ? undefined : oid.slice(0, 7),
    upstream:
      upstream === undefined ? undefined : { name: upstream, ahead: Number(ab?.[1] ?? 0), behind: Number(ab?.[2] ?? 0) },
    dirty: [...paths],
  };
}

/** Subjects of the last `count` commits on HEAD, newest first; undefined also before the first commit. */
export async function recentCommitSubjects(
  env: GitEnvironment,
  cwd: string,
  count: number,
  timeoutMs = defaultTimeoutMs,
): Promise<string[] | undefined> {
  const out = await gitOutput(env, cwd, ["log", `--max-count=${count}`, "--format=%s"], { timeoutMs });
  if (out === undefined) return undefined;
  return out.split("\n").filter((line) => line !== "");
}

/**
 * Whether git would leave `path` out of a commit: ignored by `.gitignore`,
 * `.git/info/exclude` or the global excludes file, and not tracked. Undefined
 * outside a work tree or when git can't run.
 */
export async function isGitIgnored(
  env: GitEnvironment,
  cwd: string,
  path: string,
  timeoutMs = defaultTimeoutMs,
): Promise<boolean | undefined> {
  try {
    const result = await runGit(env, cwd, ["check-ignore", "-q", "--", path], { timeoutMs });
    // check-ignore: 0 ignored, 1 not ignored (tracked files never are), 128 not a repo or other error.
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    return undefined;
  } catch {
    return undefined;
  }
}
