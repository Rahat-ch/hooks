/**
 * Platform-neutral path arithmetic for secret matching. Paths from a Host may
 * be POSIX (`/home/me/.env`), Windows (`C:\Users\me\.env`) or Git Bash
 * (`/c/Users/me/.env`) whatever platform hardhooks runs on, so `node:path`
 * (which follows the running platform) is not used here.
 *
 * The canonical form uses `/` separators, maps drive letters to Git Bash
 * style (`C:\x` and `/c/x` are both `/c/x`), resolves `.` and `..`, and is
 * lower-cased: macOS and Windows file systems are case-insensitive, so `.ENV`
 * is `.env` there, and treating it so on Linux costs nothing.
 */

const drive = /^([a-zA-Z]):(?:[\\/]|$)/;

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || drive.test(path);
}

/** Canonical form of an absolute path. */
export function canonicalPath(path: string): string {
  let p = path.replace(/\\/g, "/");
  const letter = drive.exec(path);
  if (letter) p = `/${letter[1]}/${p.slice(2)}`;
  p = p.replace(/^\/cygdrive\/([a-zA-Z])(?=\/|$)/i, "/$1");
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`.toLowerCase();
}

/**
 * `path` as an absolute canonical path: `~` and `~/` (or `~\`) expand to
 * `home`, and relative paths are taken from `cwd`.
 */
export function resolvePath(path: string, cwd: string, home: string): string {
  if (path === "~") return canonicalPath(home);
  if (path.startsWith("~/") || path.startsWith("~\\")) return canonicalPath(`${home}/${path.slice(2)}`);
  if (isAbsolutePath(path)) return canonicalPath(path);
  return canonicalPath(`${cwd}/${path}`);
}

/** `path` relative to `dir` (both canonical), or undefined when it is not inside `dir`. "" when equal. */
export function relativeTo(path: string, dir: string): string | undefined {
  if (path === dir) return "";
  const prefix = dir === "/" ? "/" : `${dir}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}
