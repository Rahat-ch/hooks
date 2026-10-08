/**
 * git-guard (Guard, fails closed): stops git commands that rewrite shared
 * history or destroy work. Tracer-bullet rule set: blocks `git push` with
 * `--force`/`-f`; #5 adds the rest.
 */
import { block } from "../../decision";
import { analyzeShell, type SimpleCommand } from "../../shell";
import { defineHook } from "../hook";

/** git options that take a separate value argument before the subcommand. */
const gitOptionsWithValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

function gitSubcommand(argv: readonly string[]): { name: string; args: readonly string[] } | undefined {
  const program = argv[0]?.split(/[\\/]/).pop()?.replace(/\.exe$/i, "");
  if (program !== "git") return undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (gitOptionsWithValue.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return { name: arg, args: argv.slice(i + 1) };
  }
  return undefined;
}

function isForcePush(command: SimpleCommand): boolean {
  const sub = gitSubcommand(command.argv);
  if (sub?.name !== "push") return false;
  for (const arg of sub.args) {
    if (arg === "--") break;
    if (arg === "--force") return true;
    if (/^-[a-zA-Z]+$/.test(arg) && arg.includes("f")) return true;
  }
  return false;
}

export const gitGuard = defineHook({
  name: "git-guard",
  description: "Blocks git commands that rewrite shared history or destroy uncommitted work.",
  events: ["PreToolUse"],
  tools: ["shell"],
  failMode: "closed",
  defaults: {
    standard: { enabled: true, options: {} },
    strict: { enabled: true, options: {} },
  },
  run(event) {
    const command = event.tool?.command;
    if (command === undefined) return undefined;
    const analysis = analyzeShell(command);
    if (!analysis.ok) return block(`Could not parse the shell command, so it was blocked to be safe: ${analysis.error}`);
    if (analysis.commands.some(isForcePush)) {
      return block(
        "`git push --force` rewrites history on the remote and can destroy other people's commits. " +
          "Push without --force, or ask the user to force-push themselves.",
      );
    }
    return undefined;
  },
});
