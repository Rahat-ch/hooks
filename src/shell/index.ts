/**
 * Shell analysis: "what will this command line actually execute?"
 *
 * The shared deep module behind every Guard. It parses bash syntax with
 * `unbash` and returns a flat list of simple commands, after unwrapping
 * everything that merely launches another command: `bash -c`, `env`, `sudo`,
 * `xargs`, `eval`, command substitution, pipelines, lists and so on. Text that
 * is only data (heredoc bodies, quoted arguments such as commit messages,
 * comments) never produces an executing command.
 *
 * A script string that holds run-time values (`bash -c "git push -f $R"`,
 * `eval "rm -rf $X/"`) is still analysed, as written: its commands are listed
 * with every word touching such a value marked dynamic, and the launching
 * shell or `eval` is listed too, since part of what it runs is unseen.
 *
 * Guards should depend only on this file's exports.
 */
import { analyze } from "./analyze";

export { parseOptions, type OptionSpec, type ParsedArgs, type ParsedOption } from "./options";

export interface AnalyzeOptions {
  /** Absolute directory the command line starts in (the Host's cwd). Enables `cwd` and `Redirection.path`. */
  readonly cwd?: string | undefined;
  /** The user's home directory, for `~` and `$HOME` expansion and bare `cd`. */
  readonly home?: string | undefined;
}

/** A file redirection on a command. fd duplications (`2>&1`), heredocs and here-strings are not listed. */
export interface Redirection {
  /** The operator as written: `>`, `>>`, `>|`, `&>`, `&>>`, `<`, `<>`, `>&`, `<&`. */
  readonly operator: string;
  /** Whether the command reads the target, writes it (truncating or appending), or both (`<>`). */
  readonly direction: "read" | "write" | "readwrite";
  /** The target as the shell will see it: quotes removed, `~` expanded. Unresolvable parts keep their source text. */
  readonly target: string;
  /** `target` resolved against the command's `cwd`; undefined when the cwd is unknown or the target is dynamic. */
  readonly path: string | undefined;
}

export interface SimpleCommand {
  /**
   * The program's basename, lower-cased, without a `.exe` suffix: `git` for
   * `/usr/bin/git`, `\git` or `GIT.EXE`. Wrappers (`sudo`, `env`, ...) are
   * already removed; see `via`.
   */
  readonly program: string;
  /**
   * The program followed by its arguments, as the program will receive them:
   * quotes removed, env-assignment prefixes and wrappers stripped, statically
   * known variables and `$(echo ...)`-style substitutions resolved, brace
   * lists and `~` expanded. Unresolvable words keep their source text (see
   * `dynamic`). Use `parseOptions` for a normalized option view.
   */
  readonly argv: readonly string[];
  readonly redirections: readonly Redirection[];
  /**
   * true: the shell (or a shell it launches) will run this command.
   * false: text that only parses as a command but is passed to a program as
   * data, e.g. a heredoc body written to a file or a quoted commit message.
   * Guards normally consider only executing commands.
   */
  readonly executes: boolean;
  /** Absolute directory the command runs in, following `cd`, `pushd`, `env -C` and `sudo -D`. undefined when unknown. */
  readonly cwd: string | undefined;
  /**
   * Some of `argv` could not be determined statically: an unresolved
   * `$VAR`/`$(...)` (also one an enclosing `bash -c`/`eval` string
   * substitutes, even inside quotes), a `{}` that `find -exec`/`xargs -I`
   * fills in, a glob-free but unknowable word, or arguments `xargs` will
   * append. Such entries hold their source text.
   */
  readonly dynamic: boolean;
  /** Wrapper programs that launched this command, outermost first, e.g. `["sudo", "bash"]` for `sudo bash -c "..."`. */
  readonly via: readonly string[];
  /** The commands of the previous pipeline stage when this command reads its stdin from a pipe, e.g. `curl` in `curl x | sh`. */
  readonly pipedFrom: readonly SimpleCommand[] | undefined;
}

export type ShellAnalysis =
  | { readonly ok: true; readonly commands: readonly SimpleCommand[] }
  | { readonly ok: false; readonly error: string };

/**
 * Analyse a bash command line. Never throws: when the line (or a script it
 * executes, such as a `bash -c` string) cannot be parsed, the result is
 * `{ ok: false, error }` so Guards can fail closed.
 */
export function analyzeShell(source: string, options: AnalyzeOptions = {}): ShellAnalysis {
  return analyze(source, options);
}
