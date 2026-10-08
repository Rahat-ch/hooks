/**
 * Where audit-log entries go:
 *
 *     <stateDir>/audit-log/<project>/<YYYY-MM-DD>.jsonl
 *
 * `<project>` is the repository root's name plus a hash of its path (so two
 * checkouts named `app` stay apart), and the day is the UTC date. The
 * repository root is the nearest directory up from the Event's `cwd` holding
 * `.git`, or `cwd` itself outside a repository. Nothing is written when the
 * log directory would be inside the project (a state dir pointed into the
 * repo), so the log can never be committed. Directories are created private
 * (0700) and files 0600: entries are redacted, but still say what you ran.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Environment } from "../../environment";

/** The repository root holding `cwd`, or `cwd` outside a repository. */
export function projectRoot(cwd: string): string {
  if (!isAbsolute(cwd)) return cwd;
  for (let dir = cwd; ; ) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/** `<name>-<12 hex digits of sha256(path)>`, safe as a directory name on every platform. */
function projectKey(root: string): string {
  const name = basename(root).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 40) || "project";
  return `${name}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

/** Whether `path` is `dir` or inside it. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The audit-log root: `<stateDir>/audit-log`. */
export function logRoot(env: Environment): string {
  return join(env.stateDir, "audit-log");
}

/** The day's file for the project, or undefined when it would be inside the project. */
export function logFile(env: Environment, project: string, now: Date): string | undefined {
  const root = logRoot(env);
  if (isInside(root, project)) return undefined;
  return join(root, projectKey(project), `${now.toISOString().slice(0, 10)}.jsonl`);
}

/** Append one entry as a JSON line. Returns whether the file is new (the project's first entry of the day). */
export function appendEntry(file: string, entry: object): boolean {
  const created = !existsSync(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return created;
}

const dayFile = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const dayMs = 24 * 60 * 60 * 1000;

/** Names in a directory, or none if it can't be read. */
function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Delete every project's day files dated more than `retentionDays` days
 * before `now` (UTC days), then project directories left empty. Other files
 * are left alone. Best-effort: anything that can't be removed stays.
 */
export function prune(env: Environment, now: Date, retentionDays: number): void {
  const today = Date.parse(now.toISOString().slice(0, 10));
  const root = logRoot(env);
  for (const project of list(root)) {
    const dir = join(root, project);
    for (const name of list(dir)) {
      const day = dayFile.exec(name)?.[1];
      if (day === undefined || today - Date.parse(day) <= retentionDays * dayMs) continue;
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // Best-effort.
      }
    }
    try {
      rmdirSync(dir);
    } catch {
      // Not empty (or not a directory): keep it.
    }
  }
}
