/**
 * hardhooks' own state, which only the user may change (ADR-0005).
 *
 * Trust means the user, not the agent, decides which Project commands
 * hardhooks runs. An agent (perhaps steered by the repo it is working in)
 * could grant that for them three ways, and this closes each:
 *
 * - Running `hardhooks trust` itself, with `--yes` and `CLAUDECODE` unset,
 *   or through a pseudo-terminal: any invocation that grants trust asks the
 *   user, however it is launched (`npx`, `node …/hardhooks.mjs`, `env`,
 *   `bash -c`, ...). `--status` and `--revoke` are left alone.
 * - Writing a trust record into the state dir: writes there are blocked,
 *   by file tools and by shell (redirections, and any argument of a program
 *   that isn't a known reader). Reading is fine (`cat` an audit log).
 * - Writing the user config, whose commands always run: the same.
 *
 * It lives in protect-secrets because this is the same job: hardhooks'
 * trust store is a credential the agent must not forge, guarded on the same
 * tools. It is not a sandbox: a program that computes the path at run time
 * is not seen.
 */
import { dirname } from "node:path";
import { userConfigPath } from "../../config/load";
import type { Environment } from "../../environment";
import { canonicalPath, resolvePath } from "../../paths";
import { parseOptions, type SimpleCommand } from "../../shell";
import type { Finding } from "../guard";
import { fedArguments } from "./shell";

/** Programs that only read the files they are given, or never take file names. */
const readers = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "rg",
  "ag",
  "ack",
  "jq",
  "wc",
  "ls",
  "dir",
  "tree",
  "stat",
  "file",
  "du",
  "diff",
  "cmp",
  "md5",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "shasum",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "nl",
  "realpath",
  "readlink",
  "dirname",
  "basename",
  "test",
  "[",
  "echo",
  "printf",
  "cd",
  "pushd",
  "popd",
  // The CLI itself keeps this state; granting trust is handled separately.
  "hardhooks",
]);

/** `find` only lists names unless it deletes or writes files itself. */
const findWrites = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** Programs that read their sources and write only their destination. */
const copiers = new Set(["cp", "rsync", "scp", "install", "ln"]);

/** Programs that run a package's binary named in their arguments: `npx hardhooks`, `node …/hardhooks.mjs`. */
const runners = new Set(["node", "npx", "npm", "pnpm", "pnpx", "yarn", "bun", "bunx", "deno", "corepack"]);

/** `hardhooks`, `hardhooks@1.2.0`, `.../dist/hardhooks.mjs`. */
const hardhooksWord = /^hardhooks(@[\w.-]*)?(\.[cm]?js)?$/i;

const lastSegment = (word: string) => word.split(/[\\/]/).pop() ?? word;

/** Whether `command` runs `hardhooks trust` in a way that grants trust (not `--status` or `--revoke`). */
function grantsTrust(command: SimpleCommand): boolean {
  const { argv } = command;
  // The program itself, or for a runner any of its arguments.
  const candidates = runners.has(command.program) ? argv.length : 1;
  for (let i = 0; i < candidates; i++) {
    if (!hardhooksWord.test(lastSegment(argv[i] ?? ""))) continue;
    const rest = argv.slice(i + 1).filter((arg) => arg !== "--");
    const subcommand = rest.findIndex((arg) => !arg.startsWith("-"));
    if (rest[subcommand] !== "trust") return false;
    const flags = rest.slice(subcommand + 1);
    return !flags.includes("--status") && !flags.includes("--revoke");
  }
  return false;
}

const trustReason =
  "`hardhooks trust` lets hardhooks run this project's own commands (check scripts, formatters, " +
  "session-context commands) from now on. Only the user should decide that: ask them to run " +
  "`hardhooks trust` themselves, in their own terminal, after reviewing what it lists.";

/** The directories holding hardhooks' own state: the state dir and the user config's directory. */
export function ownStateDirs(env: Environment): string[] {
  return [env.stateDir, dirname(userConfigPath(env))];
}

/** Matches paths in hardhooks' own state, as written or resolved. */
class OwnState {
  private readonly dirs: string[];
  /**
   * Spellings of the dirs that code or a dynamic word may contain, lower-cased
   * with `/` separators: absolute (also `c:/…` for a drive the canonical form
   * spells `/c/…`), `~/…`, `$HOME/…`.
   */
  private readonly spellings: string[];

  constructor(
    dirs: readonly string[],
    private readonly home: string,
  ) {
    this.dirs = dirs.map(canonicalPath);
    const canonicalHome = canonicalPath(home);
    this.spellings = this.dirs.flatMap((dir) => {
      const drive = /^\/([a-z])\//.exec(dir);
      const absolute = drive ? [dir, `${drive[1]}:${dir.slice(2)}`] : [dir];
      const rel = dir.startsWith(`${canonicalHome}/`) ? dir.slice(canonicalHome.length + 1) : undefined;
      return rel === undefined ? absolute : [...absolute, `~/${rel}`, `$home/${rel}`, `\${home}/${rel}`];
    });
  }

  /** The state dir `path` is in, or undefined. Relative paths are taken from `cwd`. */
  dirOf(path: string, cwd: string): string | undefined {
    const canonical = resolvePath(path, cwd, this.home);
    const resolved = this.dirs.find((dir) => canonical === dir || canonical.startsWith(`${dir}/`));
    if (resolved !== undefined) return resolved;
    const text = path.replace(/\\(?= )/g, "").replace(/\\/g, "/").toLowerCase();
    const index = this.spellings.findIndex((spelling) => text.includes(spelling));
    return index === -1 ? undefined : this.spellings[index];
  }
}

const writeReason = (path: string, dir: string) =>
  `\`${path}\` is in hardhooks' own state (\`${dir}\`): the record of which projects the user trusts, ` +
  "the audit log and the user config. The agent may read it but not change it. " +
  "Ask the user to run `hardhooks trust` or edit it themselves.";

/** Whether a write into hardhooks' own state is a file tool's target. */
export function ownStateWrite(path: string, cwd: string, env: Environment): Finding | undefined {
  const dir = new OwnState(ownStateDirs(env), env.home).dirOf(path, cwd);
  return dir === undefined ? undefined : { decision: "block", reason: writeReason(path, dir) };
}

/** The arguments of `command` it may write to. */
function writtenArguments(command: SimpleCommand, previous: readonly SimpleCommand[]): readonly string[] {
  const { program } = command;
  const args = command.argv.slice(1);
  if (program === "find") return args.some((arg) => findWrites.has(arg)) ? args : [];
  if (program === "sed") return args.some((arg) => arg.startsWith("-i") || arg.startsWith("--in-place")) ? args : [];
  if (readers.has(program)) return [];
  const fed = fedArguments(command, previous);
  if (copiers.has(program)) {
    const parsed = parseOptions(args, { withValue: ["-t", "--target-directory", "-e", "--rsh", "-S", "--suffix"] });
    const target = parsed.options.find((o) => o.name === "-t" || o.name === "--target-directory")?.value;
    const destination = target ?? parsed.operands.at(-1);
    return destination === undefined ? fed : [destination, ...fed];
  }
  return [...args, ...fed];
}

/** Whether the shell commands grant trust or write into hardhooks' own state. Block beats ask. */
export function ownStateShellFinding(
  commands: readonly SimpleCommand[],
  projectDir: string,
  env: Environment,
): Finding | undefined {
  const state = new OwnState(ownStateDirs(env), env.home);
  let ask: Finding | undefined;
  for (const [index, command] of commands.entries()) {
    if (!command.executes) continue;
    const cwd = command.cwd ?? projectDir;
    const written = [
      ...command.redirections.filter((r) => r.direction !== "read").map((r) => r.target),
      ...writtenArguments(command, commands.slice(0, index)),
    ];
    for (const operand of written) {
      const dir = state.dirOf(operand, cwd);
      if (dir !== undefined) return { decision: "block", reason: writeReason(operand, dir) };
    }
    if (ask === undefined && grantsTrust(command)) ask = { decision: "ask", reason: trustReason };
  }
  return ask;
}
