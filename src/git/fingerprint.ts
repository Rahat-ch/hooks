/**
 * A fingerprint of a git working tree: equal fingerprints mean the same HEAD,
 * the same changed and untracked (non-ignored) paths, and the same content in
 * each of them. Read-only: it never writes to the repo or its index.
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRunner } from "../environment";

export interface GitOptions {
  /** Environment for the git processes (the Hook's `env.env`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

/** Paths (relative to the repo root) named by `git status --porcelain=v2 -z` output. */
function statusPaths(status: string): string[] {
  const tokens = status.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // Ordinary, renamed/copied (followed by the original path), unmerged, untracked.
    const fieldsBeforePath = { "1": 8, "2": 9, u: 10, "?": 1 }[token[0] ?? ""];
    if (fieldsBeforePath === undefined || token[1] !== " ") continue;
    paths.push(token.split(" ").slice(fieldsBeforePath).join(" "));
    if (token[0] === "2") i++;
  }
  return paths;
}

/**
 * The fingerprint of the working tree containing `cwd`, or undefined when
 * `cwd` isn't in a git work tree or git fails.
 */
export async function workingTreeFingerprint(
  runner: ProcessRunner,
  cwd: string,
  options: GitOptions,
): Promise<string | undefined> {
  // `git status` may refresh and rewrite the index; optional locks off keeps it read-only.
  const env = { ...options.env, GIT_OPTIONAL_LOCKS: "0" };
  const git = (args: string[], dir: string, input?: string) =>
    runner.run("git", args, {
      cwd: dir,
      env,
      ...(input !== undefined ? { input } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (top.exitCode !== 0) return undefined;
  const root = top.stdout.trim();

  // --branch adds the HEAD commit; -z keeps paths unquoted.
  const status = await git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], root);
  if (status.exitCode !== 0) return undefined;

  const files = statusPaths(status.stdout).filter((path) => {
    if (path.includes("\n")) return false;
    try {
      return lstatSync(join(root, path)).isFile();
    } catch {
      return false; // Deleted: the status line already records it.
    }
  });
  let contents = "";
  if (files.length > 0) {
    const hashes = await git(["hash-object", "--stdin-paths"], root, `${files.join("\n")}\n`);
    if (hashes.exitCode !== 0) return undefined;
    contents = hashes.stdout;
  }

  return createHash("sha256").update(status.stdout).update("\0").update(contents).digest("hex");
}
