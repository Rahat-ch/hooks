/**
 * Path arithmetic for Hooks, trust and install, in two forms.
 *
 * **Host paths** (`isAbsolutePath`, `canonicalPath`, `resolvePath`,
 * `relativeTo`): strings compared without touching the file system. A Host
 * may send POSIX (`/home/me/.env`), Windows (`C:\Users\me\.env`) or Git Bash
 * (`/c/Users/me/.env`) spellings whatever platform hardhooks runs on, so
 * `node:path` (which follows the running platform) is not used. The
 * canonical form uses `/` separators, spells drives Git Bash style (`C:\x`,
 * `/c/x` and `/cygdrive/c/x` are all `/c/x`), resolves `.` and `..`, and is
 * lower-cased.
 *
 * **Native paths** (`resolveOperand`, `isWithin`, `samePath`,
 * `isFilesystemRoot`, `globBase`, `toPosixRelative`, `toSlashes`): `node:path`
 * for the running platform, for code that reasons about real directories.
 * Compared as written (after resolving `.`/`..`). Paths from different
 * sources can spell one directory differently: a Host's cwd reached through
 * a symlink, or a Windows 8.3 short name (`C:\Users\RUNNER~1`, as in
 * `%TEMP%`), against git's real, long path. Pass both through `physicalPath`
 * before comparing them.
 *
 * Case folding is explicit per use:
 *
 * - matching secrets (`canonicalPath` and everything built on it): always
 *   folded. `.ENV` is `.env` on macOS and Windows file systems, and
 *   over-protecting it on Linux costs nothing;
 * - comparing directories (`isWithin`, `samePath`, `pathUnder`): folded
 *   where the platform's file systems are case-insensitive by default,
 *   Windows and macOS (`foldsCase`);
 * - display and storage (reasons, settings entries, trust records): never
 *   folded. The path keeps the case it was written in.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Whether the platform's file systems are case-insensitive by default (NTFS, APFS), so paths compare folded. */
export function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

const fold = (path: string, platform: NodeJS.Platform) => (foldsCase(platform) ? path.toLowerCase() : path);

// ---------------------------------------------------------------------------
// Host paths

/** `C:\…` or `C:/…` (or just `C:`). */
const driveLetter = /^([a-zA-Z]):(?:[\\/]|$)/;
/** Git Bash / MSYS drive spelling: `/c/…`. */
const msysDrive = /^\/([a-zA-Z])(?=\/|$)/;

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || driveLetter.test(path);
}

/** Canonical form of an absolute Host path, for comparison only (it is lower-cased). */
export function canonicalPath(path: string): string {
  let p = path.replace(/\\/g, "/");
  const letter = driveLetter.exec(path);
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
 * `path` as an absolute canonical Host path: `~` and `~/` (or `~\`) expand to
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

// ---------------------------------------------------------------------------
// Native paths

/**
 * Resolve a command-line operand against the command's directory. On Windows,
 * Git Bash and MSYS spell drives as `/c/Users/...`; read those as `C:\Users\...`.
 */
export function resolveOperand(cwd: string, operand: string, platform: NodeJS.Platform): string {
  let path = operand;
  if (platform === "win32") {
    const msys = msysDrive.exec(path);
    if (msys) path = `${msys[1]!.toUpperCase()}:\\${path.slice(3)}`;
  }
  return trimTrailingSeparators(resolve(cwd, path));
}

function trimTrailingSeparators(path: string): string {
  const root = parse(path).root;
  let end = path.length;
  while (end > root.length && (path[end - 1] === "/" || path[end - 1] === sep)) end--;
  return path.slice(0, end);
}

/** `ancestor` is `path` itself or a directory containing it. */
export function isWithin(path: string, ancestor: string, platform: NodeJS.Platform): boolean {
  const rel = relative(fold(ancestor, platform), fold(path, platform));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return relative(fold(a, platform), fold(b, platform)) === "";
}

/**
 * `path` (made absolute) as the file system names it: the realpath of its
 * longest existing prefix, so symlinks, junctions and Windows 8.3 short names
 * resolve and case is as stored, with the rest appended as written. Touches
 * the file system; the path is returned resolved but otherwise unchanged
 * when no prefix can be read.
 *
 * With `entry`, a final component that is itself a symlink (or junction) is
 * kept, not followed: the path names the link, as in `rm -r link`, which
 * deletes only the link.
 */
export function physicalPath(path: string, options: { entry?: boolean } = {}): string {
  const absolute = resolve(path);
  if (options.entry && !isFilesystemRoot(absolute) && isLink(absolute)) {
    return join(physicalPath(dirname(absolute)), basename(absolute));
  }
  const rest: string[] = [];
  for (let current = absolute; ; ) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A filesystem root: `/`, `C:\`, or a UNC share root. */
export function isFilesystemRoot(path: string): boolean {
  return parse(path).root === path;
}

const GLOB = /[*?[]/;

/**
 * Split a resolved path at its first segment containing a glob character:
 * `/home/me/*` → base `/home/me`, glob true. `rm -rf ~/*` deletes the contents
 * of `base`, which is as bad as deleting `base` itself.
 */
export function globBase(path: string): { base: string; glob: boolean } {
  if (!GLOB.test(path)) return { base: path, glob: false };
  const root = parse(path).root;
  const segments = path.slice(root.length).split(/[\\/]/);
  const index = segments.findIndex((segment) => GLOB.test(segment));
  return { base: resolve(root, ...segments.slice(0, index)), glob: true };
}

/** A native relative path with `/` separators, for display, storage and git pathspecs. */
export function toSlashes(path: string): string {
  return path.split(sep).join("/");
}

/** `path` relative to `root`, with `/` separators, for git pathspecs. */
export function toPosixRelative(root: string, path: string): string {
  return toSlashes(relative(root, path));
}

/**
 * The rest of `path` below `dir` with `/` separators, as written in `path`,
 * or undefined when `path` isn't inside `dir`. String arithmetic, so it works
 * for another platform's paths too (`platform` picks the case folding); `\`
 * and `/` both separate, as Windows accepts either.
 */
export function pathUnder(path: string, dir: string, platform: NodeJS.Platform): string | undefined {
  const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = `${slashes(dir)}/`;
  const full = slashes(path);
  return fold(full, platform).startsWith(fold(root, platform)) ? full.slice(root.length) : undefined;
}
