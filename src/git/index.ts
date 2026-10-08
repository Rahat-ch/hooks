/**
 * Small read-only git queries for Hooks, run through the injected
 * ProcessRunner. Each returns undefined when `cwd` is not in a git work tree
 * or git cannot run, so callers can degrade quietly.
 */
import type { ProcessRunner } from "../environment";

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

async function runGit(
  runner: ProcessRunner,
  cwd: string,
  args: readonly string[],
  timeoutMs = defaultTimeoutMs,
): Promise<string | undefined> {
  try {
    // --no-optional-locks: never contend for index.lock with the user's own git.
    const result = await runner.run("git", ["--no-optional-locks", ...args], { cwd, timeoutMs });
    return result.exitCode === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** Branch, upstream ahead/behind and dirty paths, from `git status --porcelain=v2`. */
export async function gitStatus(runner: ProcessRunner, cwd: string, timeoutMs?: number): Promise<GitStatus | undefined> {
  const out = await runGit(runner, cwd, ["status", "--porcelain=v2", "--branch", "-z"], timeoutMs);
  if (out === undefined) return undefined;

  const status: GitStatus = { branch: undefined, head: undefined, upstream: undefined, dirty: [] };
  let upstreamName: string | undefined;
  let ahead = 0;
  let behind = 0;
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid" && value !== "(initial)") status.head = value.slice(0, 7);
      else if (key === "branch.head" && value !== "(detached)") status.branch = value;
      else if (key === "branch.upstream") upstreamName = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) [ahead, behind] = [Number(match[1]), Number(match[2])];
      }
    } else if (record.startsWith("1 ")) {
      status.dirty.push(field(record, 8));
    } else if (record.startsWith("2 ")) {
      status.dirty.push(field(record, 9));
      i++; // the rename's original path follows as its own record
    } else if (record.startsWith("u ")) {
      status.dirty.push(field(record, 10));
    } else if (record.startsWith("? ")) {
      status.dirty.push(record.slice(2));
    }
  }
  if (upstreamName !== undefined) status.upstream = { name: upstreamName, ahead, behind };
  return status;
}

/** Everything after the first `n` space-separated fields (the path may contain spaces). */
function field(record: string, n: number): string {
  let index = 0;
  for (let i = 0; i < n; i++) index = record.indexOf(" ", index) + 1;
  return record.slice(index);
}

/** Subjects of the last `count` commits on HEAD, newest first; undefined also before the first commit. */
export async function recentCommitSubjects(
  runner: ProcessRunner,
  cwd: string,
  count: number,
  timeoutMs?: number,
): Promise<string[] | undefined> {
  const out = await runGit(runner, cwd, ["log", `--max-count=${count}`, "--format=%s"], timeoutMs);
  if (out === undefined) return undefined;
  return out.split("\n").filter((line) => line !== "");
}
