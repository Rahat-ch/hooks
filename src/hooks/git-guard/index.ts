/**
 * git-guard (Guard, fails closed): stops git commands that rewrite shared
 * history, destroy uncommitted work or skip the user's git hooks.
 *
 * Blocks force-push (`--force`, `-f`, `+refspec`), `reset --hard`,
 * `clean -f` and `--no-verify` on commit/push. Unparseable input is blocked
 * (ADR-0004).
 */
import { resolve } from "node:path";
import { block, type Decision } from "../../decision";
import { analyzeShell, parseOptions, type ParsedArgs, type SimpleCommand } from "../../shell";
import { defineHook } from "../hook";

/** One git invocation, after git's own global options. */
interface GitCall {
  readonly subcommand: string;
  readonly args: readonly string[];
  /** Where git runs, following `cd` and `git -C`. */
  readonly cwd: string | undefined;
}

interface Finding {
  readonly decision: "block" | "ask";
  readonly reason: string;
}

/** git's global options that take a separate value argument. */
const globalOptionsWithValue = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
]);

function gitCall(command: SimpleCommand): GitCall | undefined {
  if (!command.executes || command.program !== "git") return undefined;
  let cwd = command.cwd;
  const argv = command.argv;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (globalOptionsWithValue.has(arg)) {
      const value = argv[++i];
      if (arg === "-C" && value !== undefined) cwd = cwd === undefined ? undefined : resolve(cwd, value);
      continue;
    }
    if (arg.startsWith("-")) continue;
    return { subcommand: arg, args: argv.slice(i + 1), cwd };
  }
  return undefined;
}

/**
 * git accepts any unambiguous prefix of a long option (`--har` for `--hard`),
 * so match those too. An ambiguous prefix makes git refuse the command, so
 * over-matching one is harmless.
 */
function isLong(name: string, full: string): boolean {
  return name === full || (name.length >= 3 && full.startsWith(name));
}

const has = (parsed: ParsedArgs, short: string | undefined, long: string) =>
  parsed.options.some((o) => (short !== undefined && o.name === short) || isLong(o.name, long));

const reasons = {
  force:
    "`git push --force` rewrites history on the remote and can destroy other people's commits. " +
    "Push without force, or ask the user to force-push themselves.",
  plusRefspec:
    "A `+` in a push refspec (`git push origin +main`) force-pushes that ref, rewriting history on the remote. " +
    "Push without the `+`, or ask the user to force-push themselves.",
  resetHard:
    "`git reset --hard` throws away all uncommitted changes, which can't be recovered. " +
    "Commit or `git stash` them first, or use `git reset --soft`/`--mixed`; ask the user before discarding work.",
  clean:
    "`git clean -f` permanently deletes untracked files, which git can't recover. " +
    "Preview with `git clean -n` and ask the user to delete them.",
  noVerify:
    "`--no-verify` skips the repository's git hooks (pre-commit and pre-push checks). " +
    "Fix what the hooks report instead of bypassing them.",
};

const rules: Record<string, (args: readonly string[]) => Finding[]> = {
  push(args) {
    const parsed = parseOptions(args, { withValue: ["-o", "--push-option", "--repo", "--receive-pack", "--exec"] });
    const findings: Finding[] = [];
    const force = parsed.options.some(
      (o) => o.name === "-f" || (isLong(o.name, "--force") && !o.name.startsWith("--force-")),
    );
    if (force) findings.push({ decision: "block", reason: reasons.force });
    if (parsed.operands.some((operand) => operand.startsWith("+"))) {
      findings.push({ decision: "block", reason: reasons.plusRefspec });
    }
    if (has(parsed, undefined, "--no-verify")) findings.push({ decision: "block", reason: reasons.noVerify });
    return findings;
  },
  commit(args) {
    const parsed = parseOptions(args, {
      withValue: [
        "-m",
        "--message",
        "-F",
        "--file",
        "-c",
        "--reedit-message",
        "-C",
        "--reuse-message",
        "--author",
        "--date",
        "-t",
        "--template",
        "--fixup",
        "--squash",
        "--trailer",
        "--cleanup",
        "--pathspec-from-file",
      ],
    });
    return has(parsed, "-n", "--no-verify") ? [{ decision: "block", reason: reasons.noVerify }] : [];
  },
  reset(args) {
    const parsed = parseOptions(args, { withValue: ["--pathspec-from-file"] });
    return has(parsed, undefined, "--hard") ? [{ decision: "block", reason: reasons.resetHard }] : [];
  },
  clean(args) {
    const parsed = parseOptions(args, { withValue: ["-e", "--exclude"] });
    return has(parsed, "-f", "--force") ? [{ decision: "block", reason: reasons.clean }] : [];
  },
};

function decide(findings: readonly Finding[]): Decision | undefined {
  const strongest = findings.some((f) => f.decision === "block") ? "block" : findings.length > 0 ? "ask" : undefined;
  if (strongest === undefined) return undefined;
  const reason = [...new Set(findings.filter((f) => f.decision === strongest).map((f) => f.reason))].join("\n");
  return strongest === "block" ? block(reason) : { kind: "ask", reason };
}

export const gitGuard = defineHook({
  name: "git-guard",
  description: "Blocks git commands that rewrite shared history, destroy uncommitted work or skip git hooks.",
  events: ["PreToolUse"],
  tools: ["shell"],
  failMode: "closed",
  defaults: {
    standard: { enabled: true, options: {} },
    strict: { enabled: true, options: {} },
  },
  run(event, _options, env) {
    const command = event.tool?.command;
    if (command === undefined) return undefined;
    const analysis = analyzeShell(command, { cwd: event.cwd, home: env.home });
    if (!analysis.ok) {
      return block(
        `This command couldn't be analysed (${analysis.error}), so git-guard blocked it to be safe. ` +
          "Fix the syntax or split it into simpler commands.",
      );
    }
    const findings = analysis.commands.flatMap((c) => {
      const call = gitCall(c);
      return call === undefined ? [] : (rules[call.subcommand]?.(call.args) ?? []);
    });
    return decide(findings);
  },
});
