/**
 * Which protected paths a shell command line would read or write.
 *
 * Rather than enumerating readers (`cat`, `head`, `base64`, `tar`, ...), any
 * executing command whose operand or redirection names a protected path
 * counts: almost every program given a file name opens it, and a list of
 * readers is always one program short. The exceptions are programs that only
 * look at names and metadata (`ls`, `stat`, `test`, `chmod`, `find`) or use a
 * key without revealing it (`ssh -i`), and arguments that are not file names
 * (the search pattern of `grep`/`rg`, `git commit -m` messages).
 */
import { readdirSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { hasGlob, shellSegmentRegex, type SecretMatch, type SecretsMatcher } from "../../secrets";
import { parseOptions, type SimpleCommand } from "../../shell";

export interface ShellFinding {
  /** The argument or redirection target as written. */
  readonly operand: string;
  readonly match: SecretMatch;
}

/** Programs that only look at names or metadata, or use a credential without printing it. */
const namesOnly = new Set([
  "ls",
  "dir",
  "tree",
  "eza",
  "exa",
  "lsd",
  "stat",
  "test",
  "[",
  "file",
  "du",
  "realpath",
  "readlink",
  "dirname",
  "basename",
  "echo",
  "printf",
  "which",
  "type",
  "chmod",
  "chown",
  "chgrp",
  "touch",
  "mkdir",
  "cd",
  "pushd",
  "popd",
  "ssh",
  "ssh-add",
  "ssh-keygen",
]);

/** `find` lists names, unless it deletes or writes files itself (`-exec` commands are analysed separately). */
const findWrites = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** git subcommands that take paths but never read or change their contents. */
const gitNamesOnly = new Set(["check-ignore", "ls-files", "status"]);

/** Content searchers whose first operand is a pattern unless one is given with -e/-f. */
const searchers: Record<string, { withValue: string[]; patternOptions: string[] }> = {
  grep: {
    withValue: ["-e", "--regexp", "-f", "--file", "-A", "-B", "-C", "-m", "--max-count", "-d", "-D", "--label"],
    patternOptions: ["-e", "--regexp", "-f", "--file"],
  },
  rg: {
    withValue: [
      "-e", "--regexp", "-f", "--file", "-A", "-B", "-C", "-m", "--max-count", "-g", "--glob", "--iglob",
      "-t", "--type", "-T", "--type-not", "-M", "--max-columns", "-j", "--threads", "-E", "--encoding",
      "--max-depth", "--max-filesize", "--sort", "--sortr", "-r", "--replace", "--colors", "--color",
    ],
    patternOptions: ["-e", "--regexp", "-f", "--file"],
  },
};
searchers.egrep = searchers.fgrep = searchers.zgrep = searchers.grep!;
searchers.ag = searchers.ack = { withValue: ["-A", "-B", "-C", "-m", "-G", "-g"], patternOptions: ["-g"] };

/** The arguments of a command that may name files. */
function fileArguments(command: SimpleCommand): readonly string[] {
  const { program } = command;
  const args = command.argv.slice(1);
  if (namesOnly.has(program)) return [];
  if (program === "find") return args.some((arg) => findWrites.has(arg)) ? args : [];
  if (program === "git") {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (subcommand !== undefined && gitNamesOnly.has(subcommand)) return [];
    // Commit messages are prose, not file names.
    return args.filter((arg, i) => !["-m", "--message"].includes(args[i - 1] ?? "") && !arg.startsWith("--message="));
  }
  const searcher = searchers[program];
  if (searcher !== undefined) {
    const parsed = parseOptions(args, { withValue: searcher.withValue });
    const explicitPattern = parsed.options.some((o) => searcher.patternOptions.includes(o.name));
    const patternValues = parsed.options
      .filter((o) => o.name === "-e" || o.name === "--regexp")
      .map((o) => o.value);
    return [
      ...parsed.options.flatMap((o) => (o.value === undefined || patternValues.includes(o.value) ? [] : [o.value])),
      ...(explicitPattern ? parsed.operands : parsed.operands.slice(1)),
    ];
  }
  return args;
}

/** The file names an argument may stand for: itself, the value of `--opt=value` or `if=value`, and `@file`. */
function candidates(arg: string): string[] {
  if (arg === "" || arg === "-") return [];
  const out = arg.startsWith("-") && !arg.includes("=") ? [] : [arg];
  const eq = arg.indexOf("=");
  if (eq > 0) out.push(arg.slice(eq + 1));
  if (arg.startsWith("@")) out.push(arg.slice(1));
  return out.filter((candidate) => candidate !== "");
}

/** What the shell would expand a glob in the last path segment to, from the real file system. */
function expandGlob(glob: string, cwd: string): string[] {
  const dir = dirname(glob);
  const last = basename(glob);
  if (!hasGlob(last) || hasGlob(dir)) return [];
  const regex = shellSegmentRegex(last);
  try {
    return readdirSync(resolve(cwd, dir))
      .filter((name) => regex.test(name))
      .map((name) => (dir === "." && !glob.startsWith("./") ? name : `${dir}/${name}`));
  } catch {
    return [];
  }
}

function check(operand: string, cwd: string, matcher: SecretsMatcher): ShellFinding | undefined {
  for (const candidate of candidates(operand)) {
    if (hasGlob(candidate)) {
      for (const expanded of expandGlob(candidate, cwd)) {
        const match = matcher.match(expanded, cwd);
        if (match) return { operand: expanded, match };
      }
      const match = matcher.matchGlob(candidate, cwd);
      if (match) return { operand: candidate, match };
    } else {
      const match = matcher.match(candidate, cwd);
      if (match) return { operand: candidate, match };
    }
  }
  return undefined;
}

/** The first protected path the commands would read or write, if any. */
export function shellFinding(
  commands: readonly SimpleCommand[],
  projectDir: string,
  matcher: SecretsMatcher,
): ShellFinding | undefined {
  for (const command of commands) {
    if (!command.executes) continue;
    const cwd = command.cwd ?? projectDir;
    for (const redirection of command.redirections) {
      const finding = check(redirection.target, cwd, matcher);
      if (finding) return finding;
    }
    for (const arg of fileArguments(command)) {
      const finding = check(arg, cwd, matcher);
      if (finding) return finding;
    }
  }
  return undefined;
}
