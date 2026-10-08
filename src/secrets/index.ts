/**
 * Which paths hold secrets. The pattern matcher behind the `protect-secrets`
 * Guard, shared with anything else that must recognise secret paths (e.g.
 * audit-log redaction).
 *
 * A path is protected when it matches the built-in patterns, a project ignore
 * file (`.claudeignore`, `.cursorignore`, `.aiignore`) or the `protect`
 * patterns, unless it matches an `allow` pattern. Each list is gitignore
 * syntax and is evaluated on its own (last match wins, `!` re-includes), so a
 * `!` in `.cursorignore` only undoes `.cursorignore` patterns. `allow` beats
 * everything. Matching is case-insensitive and understands POSIX, Windows and
 * Git Bash paths alike.
 */
import { readFileSync } from "node:fs";
import { compileRules, lastMatch, type Rule } from "./patterns";
import { canonicalPath, resolvePath } from "../paths";

export { hasGlob, shellSegmentRegex } from "./patterns";

/**
 * The built-in protected patterns, in gitignore syntax. Unlike ignore files,
 * a pattern without a trailing `/` matches only the path itself, so a Python
 * virtualenv named `.env/` is not protected by `.env`.
 */
export const builtInPatterns: readonly string[] = [
  // Environment files, except the templates that document which variables exist.
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  // Private keys, certificates and keystores.
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.p8",
  "*.ppk",
  "*.jks",
  "*.keystore",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "~/.ssh/",
  // Cloud credentials: AWS, GCP (gcloud on Linux/macOS and Windows), Azure.
  "~/.aws/credentials",
  "~/.aws/sso/cache/",
  "~/.aws/cli/cache/",
  "~/.config/gcloud/",
  "~/AppData/Roaming/gcloud/",
  "~/.azure/",
  // Kubernetes and Docker.
  "~/.kube/config",
  "~/.docker/config.json",
  // Credential stores.
  ".netrc",
  "_netrc",
  ".pgpass",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.pypirc",
  // The public half of a key pair is meant to be shared.
  "!*.pub",
];

/** The project ignore files honoured by default, read from the project root. */
export const defaultIgnoreFiles: readonly string[] = [".claudeignore", ".cursorignore", ".aiignore"];

export interface SecretsOptions {
  /** Absolute project root: ignore files are read here and relative patterns are anchored here. */
  readonly projectDir: string;
  /** The user's home directory, for `~/` patterns and paths. */
  readonly home: string;
  /** Extra protected patterns (gitignore syntax). */
  readonly protect?: readonly string[] | undefined;
  /** Exceptions (gitignore syntax); a path matching one is never protected. */
  readonly allow?: readonly string[] | undefined;
  /** Ignore files to honour, by name in `projectDir`. Default: `defaultIgnoreFiles`. Missing files are skipped. */
  readonly ignoreFiles?: readonly string[] | undefined;
}

/** Why a path is protected. */
export interface SecretMatch {
  /** The pattern that matched, as written, e.g. `.env.*` or `~/.ssh/`. */
  readonly pattern: string;
  /** Where the pattern comes from: `built-in`, an ignore file name such as `.cursorignore`, or `protect`. */
  readonly source: string;
}

export interface SecretsMatcher {
  /**
   * Why `path` is protected, or undefined when it is not. Relative paths are
   * taken from `cwd` (default: the project root); `~` expands to home.
   */
  match(path: string, cwd?: string): SecretMatch | undefined;
  /**
   * Why a file glob (`.env*`, `**\/*.pem`, `~/.ssh/*`) would select protected
   * paths, or undefined. Heuristic and file-system free: it tries the glob
   * as a path and with its wildcards filled in a few typical ways, so
   * `.env*` and `*.pem` are caught while `*` and `*.ts` are not.
   */
  matchGlob(glob: string, cwd?: string): SecretMatch | undefined;
}

/** Wildcard fillers for `matchGlob`: `.env*` → `.env`, `.env.local`; `*.pem` → `x.pem`; `id_*` → `id_rsa`. */
const globFillers = ["", "x", ".local", "rsa"];

function fillGlob(glob: string, filler: string): string {
  return glob
    .replace(/\{([^{}]*)\}/g, (_, options: string) => options.split(",")[0] ?? "")
    .replace(/\[[^\]]+\]/g, "x")
    .replace(/\*+/g, filler)
    .replace(/\?/g, "x");
}

/** Brace alternatives: `*.{pem,key}` → `*.pem`, `*.key`. One level, as in most globs. */
function braceAlternatives(glob: string): string[] {
  const match = /\{([^{}]*)\}/.exec(glob);
  if (!match) return [glob];
  return match[1]!
    .split(",")
    .flatMap((option) =>
      braceAlternatives(glob.slice(0, match.index) + option + glob.slice(match.index + match[0].length)),
    );
}

interface Source {
  readonly name: string;
  readonly rules: readonly Rule[];
}

function readIgnoreFile(path: string): string[] | undefined {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Build a matcher. Reads the ignore files once, now; throws if one exists but
 * can't be read (a Guard then fails closed).
 */
export function secretsMatcher(options: SecretsOptions): SecretsMatcher {
  const base = canonicalPath(options.projectDir);
  const { home } = options;
  const gitignore = { base, home, gitignore: true };
  const sources: Source[] = [
    { name: "built-in", rules: compileRules(builtInPatterns, { base, home, gitignore: false }) },
  ];
  for (const name of options.ignoreFiles ?? defaultIgnoreFiles) {
    const lines = readIgnoreFile(`${options.projectDir}/${name}`);
    if (lines !== undefined) sources.push({ name, rules: compileRules(lines, gitignore) });
  }
  sources.push({ name: "protect", rules: compileRules(options.protect ?? [], gitignore) });
  const allow = compileRules(options.allow ?? [], gitignore);

  const match = (path: string, cwd: string = options.projectDir): SecretMatch | undefined => {
    const canonical = resolvePath(path, cwd, home);
    if (lastMatch(allow, canonical) !== undefined) return undefined;
    for (const source of sources) {
      const rule = lastMatch(source.rules, canonical);
      if (rule !== undefined) return { pattern: rule.pattern, source: source.name };
    }
    return undefined;
  };

  return {
    match,
    matchGlob(glob, cwd) {
      for (const alternative of braceAlternatives(glob)) {
        for (const candidate of [alternative, ...globFillers.map((filler) => fillGlob(alternative, filler))]) {
          const found = match(candidate, cwd);
          if (found) return found;
        }
      }
      return undefined;
    },
  };
}

/** One-off convenience: whether `path` is protected. Build a `secretsMatcher` to check many paths. */
export function isProtectedPath(path: string, options: SecretsOptions & { readonly cwd?: string }): boolean {
  return secretsMatcher(options).match(path, options.cwd) !== undefined;
}
