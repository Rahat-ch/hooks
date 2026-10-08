/**
 * gitignore-style patterns compiled to matchers over canonical paths
 * (see `./paths`). Zero-dependency: we need only the pattern syntax, not
 * directory walking.
 *
 * - Blank lines and `#` comments are skipped; `\#` and `\!` escape them.
 * - `!pattern` re-includes what an earlier pattern in the same list matched.
 *   The last matching pattern wins.
 * - A pattern with no `/` except a trailing one matches a name at any depth;
 *   otherwise it is anchored to the list's base directory. `~/` anchors to the
 *   home directory instead.
 * - `*` and `?` stay within one path segment, `**` crosses them, `[...]` is a
 *   character class.
 * - A trailing `/` marks a directory: it and everything inside it match.
 */
import { relativeTo, resolvePath } from "./paths";

export interface Rule {
  /** The pattern as written, for messages. */
  readonly pattern: string;
  readonly negate: boolean;
  readonly regex: RegExp;
  /** Matched against the path relative to `base`; otherwise against names. */
  readonly anchored: boolean;
  /** Canonical directory the pattern is relative to. */
  readonly base: string;
  /** Also matches everything inside a matching directory. */
  readonly descendants: boolean;
}

export interface CompileOptions {
  /** Canonical directory that anchored patterns are relative to. */
  readonly base: string;
  readonly home: string;
  /**
   * gitignore semantics: a pattern matching a directory also matches its
   * contents. Without it only a trailing-`/` pattern does, so `.env` matches
   * a `.env` file but not a Python virtualenv's `.env/bin/activate`.
   */
  readonly gitignore: boolean;
}

/** Whether `text` contains glob syntax (`*`, `?`, `[`). */
export function hasGlob(text: string): boolean {
  return /[*?[]/.test(text);
}

/**
 * A regex for one path segment as the shell expands it: like a pattern, but a
 * leading `*`, `?` or `[` does not match a leading `.` (so `*` skips `.env`).
 */
export function shellSegmentRegex(glob: string): RegExp {
  return new RegExp(`^${glob.startsWith(".") ? "" : "(?!\\.)"}${globToRegex(glob)}$`, "i");
}

function globToRegex(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    const atSegmentStart = i === 0 || glob[i - 1] === "/";
    if (c === "*" && glob[i + 1] === "*" && atSegmentStart && (glob[i + 2] === "/" || i + 2 === glob.length)) {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        re += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      re += `[${negated ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = close;
    } else if (c === "\\" && i + 1 < glob.length) {
      re += glob[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return re;
}

/** Compile one line; undefined for blank lines and comments. */
export function compileRule(line: string, options: CompileOptions): Rule | undefined {
  let text = line.replace(/(?<!\\)\s+$/, "");
  if (text === "" || text.startsWith("#")) return undefined;
  const pattern = text;
  const negate = text.startsWith("!");
  if (negate) text = text.slice(1);
  if (text.startsWith("\\#") || text.startsWith("\\!")) text = text.slice(1);

  let base = options.base;
  let anchoredToHome = false;
  if (text.startsWith("~/")) {
    base = resolvePath("~", "/", options.home);
    text = text.slice(2);
    anchoredToHome = true;
  }
  const dirOnly = text.endsWith("/");
  if (dirOnly) text = text.replace(/\/+$/, "");
  if (text === "") return undefined;
  const anchored = anchoredToHome || text.includes("/");
  if (text.startsWith("/")) text = text.slice(1);

  return {
    pattern,
    negate,
    regex: new RegExp(`^${globToRegex(text)}$`, "i"),
    anchored,
    base,
    descendants: options.gitignore || dirOnly,
  };
}

export function compileRules(lines: readonly string[], options: CompileOptions): Rule[] {
  return lines.flatMap((line) => compileRule(line, options) ?? []);
}

function ruleMatches(rule: Rule, path: string): boolean {
  const relative = relativeTo(path, rule.base);
  if (rule.anchored) {
    if (relative === undefined || relative === "") return false;
    const segments = relative.split("/");
    const upTo = rule.descendants ? 1 : segments.length;
    for (let n = segments.length; n >= upTo; n--) {
      if (rule.regex.test(segments.slice(0, n).join("/"))) return true;
    }
    return false;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (rule.regex.test(segments[segments.length - 1]!)) return true;
  // A matching directory protects its contents, but only inside the base: a
  // project that happens to live under a directory named `secrets` is not all secret.
  if (!rule.descendants || relative === undefined || relative === "") return false;
  const inside = relative.split("/");
  return inside.slice(0, -1).some((name) => rule.regex.test(name));
}

/** The last rule matching `path` (canonical), when that rule protects rather than re-includes. */
export function lastMatch(rules: readonly Rule[], path: string): Rule | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (ruleMatches(rule, path)) return rule.negate ? undefined : rule;
  }
  return undefined;
}
