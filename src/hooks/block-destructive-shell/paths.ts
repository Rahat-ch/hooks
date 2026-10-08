/**
 * Lexical path helpers for block-destructive-shell. Paths are compared as
 * written (after resolving `.`/`..`), not through symlinks: the Guard reasons
 * about what a command names, which is what the user reads too.
 */
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

export interface PathContext {
  readonly platform: NodeJS.Platform;
}

/**
 * Resolve a command-line operand against the command's directory. On Windows,
 * Git Bash and MSYS spell drives as `/c/Users/...`; read those as `C:\Users\...`.
 */
export function resolveOperand(cwd: string, operand: string, ctx: PathContext): string {
  let path = operand;
  if (ctx.platform === "win32") {
    const msys = /^\/([a-zA-Z])(\/|$)/.exec(path);
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

function comparable(path: string, ctx: PathContext): string {
  return ctx.platform === "win32" || ctx.platform === "darwin" ? path.toLowerCase() : path;
}

/** `ancestor` is `path` itself or a directory containing it. */
export function isWithin(path: string, ancestor: string, ctx: PathContext): boolean {
  const rel = relative(comparable(ancestor, ctx), comparable(path, ctx));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function samePath(a: string, b: string, ctx: PathContext): boolean {
  return relative(comparable(a, ctx), comparable(b, ctx)) === "";
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

/** `path` relative to `root`, with `/` separators, for git pathspecs. */
export function toPosixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
