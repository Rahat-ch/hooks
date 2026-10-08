/**
 * check (fails open, ADR-0004): when the Host tries to stop, run the
 * project's check command and block the stop with the failure output while it
 * fails, so the Host can't claim "done" while checks are red.
 *
 * - The command is configured, or detected (see ./detect) and announced.
 *   A detected command, or one from the repo config, runs only in a trusted
 *   project (`hardhooks trust`, ADR-0005); otherwise the stop goes ahead
 *   unchecked and the user is told once per session.
 * - Command lines run through the platform shell, as npm runs scripts:
 *   `sh -c` on POSIX, `cmd.exe /d /s /c` on Windows. So `npm run lint && npm test`
 *   works everywhere, and `npm` resolves to npm.cmd on Windows.
 * - Loop protection: a fresh stop (the Host's stop-hook-active signal unset)
 *   starts a new run of blocks; after `maxBlocks` consecutive blocks the Host
 *   may stop, with a message. The count lives in the state dir per session.
 * - A pass records the git working-tree fingerprint; an unchanged tree skips.
 * - Timeouts and commands that can't start allow, with a warning message.
 * - Opt-in: SubagentStop (`subagentStop`), and per-edit mode (`editCommand`),
 *   which runs on the edited file after each edit and feeds failures back as
 *   capped context instead of blocking.
 */
import { isAbsolute, join, resolve } from "node:path";
import * as s from "../../config/schema";
import { addContext, block, message, type Decision } from "../../decision";
import type { Environment, ProcessResult } from "../../environment";
import type { HookEvent } from "../../event";
import { workingTreeFingerprint } from "../../git/fingerprint";
import { defineHook, type ProjectTrust } from "../hook";
import { detectCommand } from "./detect";
import { truncateOutput } from "./output";
import { CheckState } from "./state";

const optionsSchema = s.object({
  command: s.optional(
    s.string({
      description:
        "Command line to run when the Host stops, through the platform shell (sh -c on POSIX, cmd.exe /d /s /c on Windows). Omit to autodetect from package.json scripts (lint, typecheck, test), ruff, go vet or cargo check. From a repo config, and when autodetected, it runs only once the project is trusted (`hardhooks trust`).",
    }),
  ),
  timeoutSeconds: s.number({
    integer: true,
    minimum: 1,
    description:
      "Seconds before the check command is killed and the Host may stop unchecked. Keep it below the Host's hook timeout (Claude Code: 600).",
  }),
  outputBytes: s.number({
    integer: true,
    minimum: 200,
    maximum: 9000,
    description: "Most bytes of failure output in the block reason, which enters the Host's context.",
  }),
  maxBlocks: s.number({
    integer: true,
    minimum: 1,
    description:
      "Consecutive Stop blocks before check gives up and lets the Host stop. Keep it below Claude Code's own cap (8).",
  }),
  subagentStop: s.boolean({ description: "Also run the check when a subagent stops." }),
  editCommand: s.optional(
    s.string({
      description:
        "Per-edit mode: a command line to run after each file edit, with {file} replaced by the edited file (appended when absent). Failures are fed back to the Host, never blocking. From a repo config, it runs only once the project is trusted (`hardhooks trust`).",
    }),
  ),
  editTimeoutSeconds: s.number({ integer: true, minimum: 1, description: "Seconds before an edit command is killed." }),
  editOutputBytes: s.number({
    integer: true,
    minimum: 100,
    maximum: 9000,
    description: "Most bytes of edit-command output fed back after each edit.",
  }),
});

type CheckOptions = s.Infer<typeof optionsSchema>;

const presetOptions: CheckOptions = {
  timeoutSeconds: 300,
  outputBytes: 4000,
  maxBlocks: 3,
  subagentStop: false,
  editTimeoutSeconds: 30,
  editOutputBytes: 1000,
};

/** Exit codes shells use for "command not found": 127 for sh, 9009 for cmd.exe. */
const notFoundExitCodes = new Set([127, 9009]);

function runCommandLine(command: string, cwd: string, timeoutSeconds: number, env: Environment): Promise<ProcessResult> {
  return env.processRunner.run(command, [], { cwd, env: env.env, shell: true, timeoutMs: timeoutSeconds * 1000 });
}

/** The fail-open warning when a command gave no pass/fail answer, or undefined when it did. */
function noAnswer(result: ProcessResult, chosen: string, timeoutSeconds: number, outcome: string): Decision | undefined {
  if (result.timedOut) return message(`${chosen} timed out after ${timeoutSeconds}s, so ${outcome}.`);
  if (result.spawnError !== undefined || result.exitCode === null || notFoundExitCodes.has(result.exitCode)) {
    const why = result.spawnError ?? (truncateOutput(result.stderr, 300) || `exit ${result.exitCode}`);
    return message(`could not run ${chosen} (${why}), so ${outcome}.`);
  }
  return undefined;
}

const output = (result: ProcessResult, budget: number) => truncateOutput(`${result.stdout}\n${result.stderr}`, budget);

async function onStop(event: HookEvent, options: CheckOptions, env: Environment, trust: ProjectTrust): Promise<Decision | undefined> {
  const detected = options.command === undefined ? detectCommand(event.cwd) : undefined;
  const command = options.command ?? detected?.command;
  if (command === undefined) return undefined;
  const chosen = detected ? `\`${command}\` (detected from ${detected.source})` : `\`${command}\``;
  // A configured command comes from the user config or a trusted repo config; the dispatcher withholds the rest.
  if (detected && !trust.mayRun(chosen)) return undefined;

  const state = new CheckState(join(env.stateDir, "check"));
  const session = event.sessionId ?? "";
  const fingerprint = await workingTreeFingerprint(env.processRunner, event.cwd, { env: env.env });
  if (fingerprint !== undefined && state.lastPass(event.cwd, command) === fingerprint) {
    state.setConsecutiveBlocks(session, event.name, 0);
    return undefined;
  }

  // Hosts that don't send the stop-hook-active signal keep counting.
  const blocks = event.stopHookActive === false ? 0 : state.consecutiveBlocks(session, event.name);
  if (blocks >= options.maxBlocks) {
    state.setConsecutiveBlocks(session, event.name, 0);
    return message(`${chosen} was still failing after ${blocks} attempts, so check let the Host stop. Run it to see the failures.`);
  }

  const result = await runCommandLine(command, event.cwd, options.timeoutSeconds, env);
  const unanswered = noAnswer(result, chosen, options.timeoutSeconds, "check let the Host stop unchecked");
  if (unanswered) return unanswered;
  if (result.exitCode === 0) {
    state.setConsecutiveBlocks(session, event.name, 0);
    state.recordPass(event.cwd, command, fingerprint);
    return detected ? message(`ran ${chosen}: passed.`) : undefined;
  }
  state.setConsecutiveBlocks(session, event.name, blocks + 1);
  state.recordPass(event.cwd, command, undefined);
  return block(
    `${chosen} failed (exit ${result.exitCode}). Fix the problems before finishing.\n\n${output(result, options.outputBytes)}`,
  );
}

/** `arg` quoted as one word for the platform shell. */
function shellQuote(arg: string, platform: NodeJS.Platform): string {
  // cmd.exe has no escape inside double quotes, but paths can't contain `"` on Windows.
  if (platform === "win32") return `"${arg}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function onEdit(event: HookEvent, options: CheckOptions, env: Environment): Promise<Decision | undefined> {
  const filePath = event.tool?.filePath;
  if (options.editCommand === undefined || filePath === undefined) return undefined;
  const file = shellQuote(isAbsolute(filePath) ? filePath : resolve(event.cwd, filePath), env.platform);
  const command = options.editCommand.includes("{file}")
    ? options.editCommand.replaceAll("{file}", () => file)
    : `${options.editCommand} ${file}`;

  const result = await runCommandLine(command, event.cwd, options.editTimeoutSeconds, env);
  const unanswered = noAnswer(result, `\`${command}\``, options.editTimeoutSeconds, "the edit was not checked");
  if (unanswered) return unanswered;
  if (result.exitCode === 0) return undefined;
  return addContext(
    `[hardhooks/check] \`${command}\` failed (exit ${result.exitCode}) after this edit:\n${output(result, options.editOutputBytes)}`,
  );
}

export const check = defineHook<CheckOptions>({
  name: "check",
  description: "Runs the project's checks when the Host tries to stop, and blocks the stop while they fail.",
  events: ["Stop", "SubagentStop", "PostToolUse"],
  tools: ["edit", "write"],
  failMode: "open",
  optionsSchema,
  commandOptions: ["command", "editCommand"],
  projectCommands(cwd, options) {
    const detected = options.command === undefined ? detectCommand(cwd) : undefined;
    return detected ? [`\`${detected.command}\` (detected from ${detected.source})`] : [];
  },
  defaults: {
    standard: { enabled: false, options: presetOptions },
    strict: { enabled: true, options: presetOptions },
  },
  run(event, options, env, trust) {
    if (event.name === "Stop") return onStop(event, options, env, trust);
    if (event.name === "SubagentStop") return options.subagentStop ? onStop(event, options, env, trust) : undefined;
    if (event.name === "PostToolUse") return onEdit(event, options, env);
    return undefined;
  },
});
