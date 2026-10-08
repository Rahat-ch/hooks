/**
 * Downloads run as code: `curl … | sh`, `wget -O- … | bash`,
 * `bash <(curl …)`, `sh -c "$(curl …)"`, `eval "$(wget -qO- …)"`. Always
 * blocked: the script is run unseen, and can differ from what a browser shows.
 * Downloading to a file first (`curl -o install.sh`) is allowed, because the
 * file can be read before it is run.
 */
import { parseOptions, type SimpleCommand } from "../../shell";
import type { Finding } from "../guard";

const DOWNLOADERS = ["curl", "wget", "fetch", "http", "https", "xh", "curlie", "aria2c", "lwp-request"];
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh"]);

/** Options that make an interpreter run code from an argument rather than a file or stdin. */
const CODE_OPTIONS: Record<string, readonly string[]> = {
  python: ["-c", "-m"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  node: ["-e", "--eval", "-p", "--print"],
  php: ["-r", "--run"],
};

function interpreterFamily(program: string): string | undefined {
  if (SHELLS.has(program)) return "shell";
  if (/^python[\d.]*$/.test(program) || program === "pypy" || program === "pypy3") return "python";
  if (/^(perl|ruby|node|php)[\d.]*$/.test(program)) return program.replace(/[\d.]+$/, "");
  return undefined;
}

/** Whether the interpreter reads the program it runs from stdin. */
function runsStdin(command: SimpleCommand): boolean {
  const family = interpreterFamily(command.program);
  if (family === undefined) return false;
  const args = command.argv.slice(1);
  if (family === "shell") {
    const parsed = parseOptions(args, { withValue: ["-o", "--rcfile", "--init-file"] });
    if (parsed.options.some((o) => o.name === "-c")) return false;
    if (parsed.options.some((o) => o.name === "-s")) return true;
    return parsed.operands.length === 0 || parsed.operands[0] === "-";
  }
  const parsed = parseOptions(args, { withValue: ["-W", "-X", "-I", "-r", "--require"] });
  if (parsed.options.some((o) => CODE_OPTIONS[family]!.includes(o.name))) return false;
  return parsed.operands.length === 0 || parsed.operands[0] === "-";
}

/** A download anywhere upstream in the pipeline, e.g. through `tee` or `gunzip`. */
function downloadUpstream(command: SimpleCommand, seen = new Set<SimpleCommand>()): SimpleCommand | undefined {
  for (const source of command.pipedFrom ?? []) {
    if (seen.has(source)) continue;
    seen.add(source);
    if (DOWNLOADERS.includes(source.program)) return source;
    const deeper = downloadUpstream(source, seen);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

const SUBSTITUTED_DOWNLOAD = new RegExp(`(\\$\\(|\`|<\\()[^]*\\b(${DOWNLOADERS.join("|")})\\b`);

const reason = (what: string) =>
  `${what} runs a downloaded script without anyone reading it first. ` +
  "Download it to a file, read it, then run it, or ask the user to run it.";

export function downloadFindings(command: SimpleCommand): Finding[] {
  if (!command.executes) return [];
  const upstream = runsStdin(command) ? downloadUpstream(command) : undefined;
  if (upstream !== undefined) {
    return [{ decision: "block", reason: reason(`Piping \`${upstream.program}\` into \`${command.program}\``) }];
  }
  const runsArgument =
    interpreterFamily(command.program) !== undefined || ["eval", "source", "."].includes(command.program);
  if (runsArgument && command.dynamic && command.argv.slice(1).some((arg) => SUBSTITUTED_DOWNLOAD.test(arg))) {
    return [{ decision: "block", reason: reason(`\`${command.program}\` with a substituted download`) }];
  }
  return [];
}
