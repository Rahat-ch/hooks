/**
 * The process runner `hardhooks test` gives Hooks, so a test run never
 * formats files, runs check commands or sends notifications on the user's
 * machine:
 *
 * - every program except git "succeeds" with no output and is never started;
 * - detached processes (notifications, webhooks) are never started;
 * - git: with `realGit`, read-only queries (status, rev-parse, ls-files,
 *   check-ignore, ...) run for real, so user cases see the real repo (its
 *   branch, what is tracked or ignored); anything else, and every git call
 *   without `realGit`, answers "not a git repository".
 */
import type { ProcessResult, ProcessRunner } from "../environment";
import { nodeProcessRunner } from "../environment";

export interface SandboxOptions {
  /** Run read-only git queries for real (user cases). Off for shipped fixtures, whose project dir is fake. */
  readonly realGit: boolean;
}

/** git subcommands that only read the repository. */
const readOnlyGit = new Set([
  "cat-file",
  "check-attr",
  "check-ignore",
  "describe",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "status",
]);

/** git's global options that take a separate value, e.g. `-C <dir>`. */
const gitOptionsWithValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

/** Whether a git invocation only reads: a read-only subcommand, or `symbolic-ref` with one ref (reading it). */
function isReadOnlyGit(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += gitOptionsWithValue.has(args[i]!) ? 2 : 1;
  const subcommand = args[i];
  const rest = args.slice(i + 1);
  if (subcommand === "symbolic-ref") {
    return rest.filter((arg) => !arg.startsWith("-")).length <= 1 && !rest.some((arg) => arg === "-d" || arg === "--delete");
  }
  return subcommand !== undefined && readOnlyGit.has(subcommand);
}

const notARepo: ProcessResult = {
  exitCode: 128,
  stdout: "",
  stderr: "fatal: not a git repository (hardhooks test)\n",
  timedOut: false,
};

export function sandboxProcessRunner(options: SandboxOptions): ProcessRunner {
  return {
    async run(command, args, runOptions) {
      if (command === "git") {
        return options.realGit && isReadOnlyGit(args) ? nodeProcessRunner.run(command, args, runOptions) : { ...notARepo };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    spawnDetached() {},
  };
}
