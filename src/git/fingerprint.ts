/**
 * A fingerprint of a git working tree: equal fingerprints mean the same HEAD,
 * the same changed and untracked (non-ignored) paths, and the same content in
 * each of them. Read-only: it never writes to the repo or its index.
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { parsePorcelainV2 } from "./porcelain";
import { runGit, type GitEnvironment } from "./run";

/**
 * The fingerprint of the working tree containing `cwd`, or undefined when
 * `cwd` isn't in a git work tree or git fails.
 */
export async function workingTreeFingerprint(
  env: GitEnvironment,
  cwd: string,
  timeoutMs?: number,
): Promise<string | undefined> {
  const git = (args: string[], dir: string, input?: string) => runGit(env, dir, args, { input, timeoutMs });

  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (top.exitCode !== 0) return undefined;
  const root = top.stdout.trim();

  // --branch adds the HEAD commit; -z keeps paths unquoted.
  const status = await git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], root);
  if (status.exitCode !== 0) return undefined;

  const files = parsePorcelainV2(status.stdout).paths.filter((path) => {
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
