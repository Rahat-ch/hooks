/**
 * git-guard (Guard, fails closed): stops git commands that rewrite shared
 * history, destroy uncommitted work or skip the user's git hooks.
 *
 * - Blocks force-push (`--force`, `-f`, `+refspec`), `push --mirror`
 *   (which force-overwrites and deletes remote refs), `reset --hard`,
 *   `clean -f` and `--no-verify` on commit/push.
 * - Asks before `--force-with-lease`, pushes that delete remote refs
 *   (`:branch`, `--delete`, `--prune`), discard-all `checkout`/`restore` and
 *   `branch -D`.
 * - When protection is on (`strict`, or `protectedBranches` configured),
 *   blocks commits and pushes to protected branches, and deleting them.
 * - Blocks input it can't analyse (ADR-0004).
 */
import { resolve } from "node:path";
import { analyzeShell, parseOptions, type ParsedArgs, type SimpleCommand } from "../../shell";
import * as s from "../../config/schema";
import { cannotAnalyse, decide, type Finding } from "../guard";
import { defineHook } from "../hook";
import {
  protectedBranchViolations,
  protectionEnabled,
  pushOptionsWithValue,
  type GitInvocation,
  type ProtectionOptions,
} from "./protected-branches";

/**
 * Protection is on when `protectedBranches` is non-empty or
 * `protectDefaultBranch` is true: off under `standard`, `main`, `master` and
 * the detected default branch under `strict`.
 */
export type GitGuardOptions = ProtectionOptions;

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

/**
 * The git invocation an executing command makes, after git's global options.
 * `cwd` follows `cd` and `git -C`; when a `cd` couldn't be resolved it falls
 * back to the project directory.
 */
function gitInvocation(command: SimpleCommand, projectDir: string): GitInvocation | undefined {
  if (!command.executes || command.program !== "git") return undefined;
  let cwd = command.cwd ?? projectDir;
  const config: string[] = [];
  const argv = command.argv;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (globalOptionsWithValue.has(arg)) {
      const value = argv[++i];
      if (arg === "-C" && value !== undefined) cwd = resolve(cwd, value);
      if (arg === "-c" && value !== undefined) config.push(value);
      continue;
    }
    if (arg.startsWith("-")) continue;
    return { subcommand: arg, args: argv.slice(i + 1), cwd, config };
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

const has = (parsed: ParsedArgs, short: string | undefined, long?: string) =>
  parsed.options.some((o) => o.name === short || (long !== undefined && isLong(o.name, long)));

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
  forceWithLease:
    "`git push --force-with-lease` rewrites history on the remote (safely refusing if someone else pushed). " +
    "Confirm the force-push is intended.",
  discardAll:
    "This discards all uncommitted changes in the working tree, which can't be recovered. " +
    "Confirm the changes should be thrown away (or `git stash` them instead).",
  mirror:
    "`git push --mirror` makes the remote an exact copy of this repository: it force-overwrites every remote ref " +
    "and deletes every remote branch and tag that doesn't exist locally. Push branches by name instead, " +
    "or ask the user to mirror the repository themselves.",
  remoteDelete:
    "This push deletes refs on the remote (a `:branch` refspec, `--delete` or `--prune`), and with them " +
    "any commits only they hold. Confirm the remote branches or tags should be deleted.",
  branchDelete:
    "`git branch -D` deletes the branch even if it isn't merged, which can lose its commits. " +
    "Confirm the branch should be deleted (or use `git branch -d`).",
};

/**
 * Whether a push deletes remote refs: `--delete`/`-d`, `--prune`, or a
 * refspec with an empty source (`:branch`, `+:branch`). A lone `:` is git's
 * "push matching branches", not a delete.
 */
function deletesRemoteRefs(parsed: ParsedArgs): boolean {
  if (has(parsed, "-d", "--delete") || has(parsed, undefined, "--prune")) return true;
  return parsed.operands.slice(1).some((refspec) => /^\+?:./.test(refspec));
}

/** Pathspecs that cover the whole working tree. */
const everything = new Set([".", "./", "./*", "*", ":/", ":/.", ":/*", ":(top)", ":(top).", ":(top)*"]);

const rules: Record<string, (args: readonly string[]) => Finding[]> = {
  push(args) {
    const parsed = parseOptions(args, { withValue: pushOptionsWithValue });
    const findings: Finding[] = [];
    const force = parsed.options.some(
      (o) => o.name === "-f" || (isLong(o.name, "--force") && !o.name.startsWith("--force-")),
    );
    if (force) findings.push({ decision: "block", reason: reasons.force });
    if (parsed.options.some((o) => o.name.length > "--force-".length && "--force-with-lease".startsWith(o.name))) {
      findings.push({ decision: "ask", reason: reasons.forceWithLease });
    }
    if (parsed.operands.some((operand) => operand.startsWith("+"))) {
      findings.push({ decision: "block", reason: reasons.plusRefspec });
    }
    if (has(parsed, undefined, "--mirror")) findings.push({ decision: "block", reason: reasons.mirror });
    if (deletesRemoteRefs(parsed)) findings.push({ decision: "ask", reason: reasons.remoteDelete });
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
  checkout(args) {
    const parsed = parseOptions(args, { withValue: ["-b", "-B", "--orphan", "--pathspec-from-file"] });
    const discards = has(parsed, "-f", "--force") || parsed.operands.some((operand) => everything.has(operand));
    return discards ? [{ decision: "ask", reason: reasons.discardAll }] : [];
  },
  restore(args) {
    const parsed = parseOptions(args, { withValue: ["-s", "--source", "--pathspec-from-file"] });
    // Without --worktree, `--staged` only unstages and leaves the files alone.
    const worktree = has(parsed, "-W", "--worktree") || !has(parsed, "-S", "--staged");
    const discards = worktree && parsed.operands.some((operand) => everything.has(operand));
    return discards ? [{ decision: "ask", reason: reasons.discardAll }] : [];
  },
  branch(args) {
    const parsed = parseOptions(args, { withValue: ["-u", "--set-upstream-to"] });
    const forceDelete = has(parsed, "-D") || (has(parsed, "-d", "--delete") && has(parsed, "-f", "--force"));
    return forceDelete ? [{ decision: "ask", reason: reasons.branchDelete }] : [];
  },
};

/** `git -c core.hooksPath=... commit` skips the hooks just like `--no-verify`. */
function skipsHooks(call: GitInvocation): boolean {
  return (
    (call.subcommand === "commit" || call.subcommand === "push") &&
    call.config.some((setting) => setting.toLowerCase().startsWith("core.hookspath="))
  );
}

export const gitGuard = defineHook<GitGuardOptions>({
  name: "git-guard",
  description: "Blocks git commands that rewrite shared history, destroy uncommitted work or skip git hooks.",
  events: ["PreToolUse"],
  tools: ["shell"],
  failMode: "closed",
  optionsSchema: s.object({
    protectedBranches: s.array(s.string(), {
      description: "Branches that commits and pushes may not target directly. A non-empty list turns protection on.",
    }),
    protectDefaultBranch: s.boolean({
      description: "Also protect the repository's default branch (from origin/HEAD).",
    }),
  }),
  defaults: {
    standard: { enabled: true, options: { protectedBranches: [], protectDefaultBranch: false } },
    strict: { enabled: true, options: { protectedBranches: ["main", "master"], protectDefaultBranch: true } },
  },
  async run(event, options, env) {
    const command = event.tool?.command;
    if (command === undefined) return undefined;
    const analysis = analyzeShell(command, { cwd: event.cwd, home: env.home });
    if (!analysis.ok) {
      return cannotAnalyse("git-guard", analysis.error);
    }
    const invocations = analysis.commands.flatMap((c) => gitInvocation(c, event.cwd) ?? []);
    const findings = invocations.flatMap((call) => [
      ...(rules[call.subcommand]?.(call.args) ?? []),
      ...(skipsHooks(call) ? [{ decision: "block", reason: reasons.noVerify } as const] : []),
    ]);
    if (protectionEnabled(options)) {
      const violations = await protectedBranchViolations(invocations, options, env);
      findings.push(...violations.map((reason): Finding => ({ decision: "block", reason })));
    }
    return decide(findings);
  },
});
