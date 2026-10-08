/**
 * Git queries for a Guard deciding one Event. Answers are cached per
 * directory and arguments for the life of the object (create one per Event).
 * A git that can't run, or a directory outside a repository, answers
 * undefined ("no repository"); a git that times out throws, so the Guard
 * fails closed (ADR-0004).
 */
import { resolve } from "node:path";
import { runGit, type GitEnvironment } from "./run";

const defaultTimeoutMs = 5_000;

/** What deleting a path would remove, as git sees it. */
export type PathContents =
  /** Nothing git would lose track of: the path is gitignored output, or doesn't exist. */
  | "ignored"
  /** At least one file git tracks. */
  | "tracked"
  /** Files that are neither tracked nor ignored: new work git has never seen. */
  | "untracked";

export class GitQueries {
  private readonly cache = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly env: GitEnvironment,
    private readonly timeoutMs = defaultTimeoutMs,
  ) {}

  /** stdout of a successful git query; undefined when git fails or isn't installed. Throws on timeout. */
  private query(cwd: string, args: readonly string[]): Promise<string | undefined> {
    const key = `${cwd}\0${args.join("\0")}`;
    let result = this.cache.get(key);
    if (result === undefined) {
      result = runGit(this.env, cwd, args, { timeoutMs: this.timeoutMs }).then((r) => {
        if (r.timedOut) throw new Error(`\`git ${args.join(" ")}\` timed out`);
        return r.exitCode === 0 ? r.stdout : undefined;
      });
      this.cache.set(key, result);
    }
    return result;
  }

  /** The work tree containing `cwd` (git's own answer, which can differ from `projectRoot()`), or undefined outside one. */
  async topLevel(cwd: string): Promise<string | undefined> {
    const out = (await this.query(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
    return out ? resolve(out) : undefined;
  }

  /** The checked-out branch; undefined when detached or not in a repo. */
  async currentBranch(cwd: string): Promise<string | undefined> {
    return (await this.query(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim();
  }

  /** The default branch, from `origin/HEAD`; undefined when that isn't set. */
  async defaultBranch(cwd: string): Promise<string | undefined> {
    const head = (await this.query(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim();
    return head?.replace(/^origin\//, "");
  }

  async branchExists(cwd: string, name: string): Promise<boolean> {
    return (await this.query(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) !== undefined;
  }

  /**
   * What deleting `pathspec` (relative to the work tree `root`, `/`-separated,
   * may be a glob) would remove. Throws when git can't answer.
   */
  async pathContents(root: string, pathspec: string, glob: boolean): Promise<PathContents> {
    const spec = `${glob ? ":(glob)" : ":(literal)"}${pathspec}`;
    const tracked = await this.query(root, ["ls-files", "-z", "--cached", "--", spec]);
    if (tracked === undefined) throw new Error(`\`git ls-files\` failed for ${pathspec}`);
    if (tracked !== "") return "tracked";
    const untracked = await this.query(root, [
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "--",
      spec,
    ]);
    if (untracked === undefined) throw new Error(`\`git ls-files\` failed for ${pathspec}`);
    return untracked !== "" ? "untracked" : "ignored";
  }
}
