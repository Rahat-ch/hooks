/**
 * Which project a directory belongs to, found on the filesystem: the nearest
 * directory up from it holding `.git` (a directory, or the file a worktree or
 * submodule has), else the directory itself. Trust, config, ignore files,
 * settings files, formatter configs and audit-log partitions all key on it.
 *
 * Paths are taken as given: never resolved against the dispatcher's own
 * working directory, which Hooks don't read. Hosts send absolute paths; a
 * relative one has no project to find and is returned unchanged.
 *
 * Deliberately not `git rev-parse --show-toplevel`: that needs a process per
 * lookup. block-destructive-shell uses git's answer instead (`GitQueries`),
 * because it asks git about paths relative to that root.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const isRepoRoot = (dir: string) => existsSync(join(dir, ".git"));

/**
 * Where to look for a project's config files from `dir`: `dir` and its
 * ancestors, nearest first, up to and including the project root; up to the
 * filesystem root when no ancestor holds `.git`.
 */
export function searchUpwards(dir: string): string[] {
  const dirs: string[] = [];
  for (let current = dir; ; ) {
    dirs.push(current);
    if (isRepoRoot(current)) return dirs;
    const parent = dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

/** The project `dir` belongs to: the nearest ancestor (or itself) holding `.git`, else `dir`. */
export function projectRoot(dir: string): string {
  if (!isAbsolute(dir)) return dir;
  const top = searchUpwards(dir).at(-1)!;
  return isRepoRoot(top) ? top : dir;
}
