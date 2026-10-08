/**
 * What git knows about the files a delete would remove, through the injected
 * process runner. Queries are cached for one Event. A git that can't run or
 * isn't in a repository answers "no repository"; a git that times out throws,
 * so the Guard fails closed (ADR-0004).
 */
import { resolve } from "node:path";
import type { Environment } from "../../environment";

const GIT_TIMEOUT_MS = 5_000;

export type Contents =
  /** Nothing git would lose track of: the path is gitignored output, or doesn't exist. */
  | "ignored"
  /** At least one file git tracks. */
  | "tracked"
  /** Files that are neither tracked nor ignored: new work git has never seen. */
  | "untracked";

export class Repo {
  private readonly cache = new Map<string, Promise<string | undefined>>();

  constructor(private readonly env: Environment) {}

  private query(cwd: string, args: readonly string[]): Promise<string | undefined> {
    const key = `${cwd}\0${args.join("\0")}`;
    let result = this.cache.get(key);
    if (result === undefined) {
      result = this.env.processRunner
        .run("git", ["--no-optional-locks", ...args], { cwd, env: this.env.env, timeoutMs: GIT_TIMEOUT_MS })
        .then((r) => {
          if (r.timedOut) throw new Error(`\`git ${args.join(" ")}\` timed out`);
          return r.exitCode === 0 ? r.stdout : undefined;
        });
      this.cache.set(key, result);
    }
    return result;
  }

  /** The work tree containing `cwd`, or undefined outside a git repository. */
  async topLevel(cwd: string): Promise<string | undefined> {
    const out = (await this.query(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
    return out ? resolve(out) : undefined;
  }

  /**
   * What deleting `pathspec` (relative to `root`, `/`-separated, may be a
   * glob) would remove, as git sees it.
   */
  async contents(root: string, pathspec: string, glob: boolean): Promise<Contents> {
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
