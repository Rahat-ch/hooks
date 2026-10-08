/**
 * check (fails open): when the Host tries to stop, run the project's check
 * command and block the stop with the failure output if it fails, so the Host
 * can't claim "done" while checks are red.
 */
import { join } from "node:path";
import { block, message } from "../../decision";
import { workingTreeFingerprint } from "../../git/fingerprint";
import * as s from "../../config/schema";
import { defineHook } from "../hook";
import { detectCommand } from "./detect";
import { truncateOutput } from "./output";
import { CheckState } from "./state";

const optionsSchema = s.object({
  command: s.optional(
    s.string({
      description:
        "Command line to run, through the platform shell (sh -c on POSIX, cmd.exe /d /s /c on Windows). Omit to autodetect.",
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
    description: "Most bytes of failure output to put in the block reason, which enters the Host's context.",
  }),
  maxBlocks: s.number({
    integer: true,
    minimum: 1,
    description:
      "Consecutive Stop blocks before check gives up and lets the Host stop. Keep it below Claude Code's own cap (8).",
  }),
});

type CheckOptions = s.Infer<typeof optionsSchema>;

const presetOptions: CheckOptions = { timeoutSeconds: 300, outputBytes: 4000, maxBlocks: 3 };

/** Exit codes shells use for "command not found": 127 for sh, 9009 for cmd.exe. */
const notFoundExitCodes = new Set([127, 9009]);

export const check = defineHook<CheckOptions>({
  name: "check",
  description: "Runs the project's checks when the Host tries to stop, and blocks the stop while they fail.",
  events: ["Stop"],
  failMode: "open",
  optionsSchema,
  defaults: {
    standard: { enabled: false, options: presetOptions },
    strict: { enabled: true, options: presetOptions },
  },
  async run(event, options, env) {
    const detected = options.command === undefined ? detectCommand(event.cwd) : undefined;
    const command = options.command ?? detected?.command;
    if (command === undefined) return undefined;
    const chosen = detected ? `\`${command}\` (detected from ${detected.source})` : `\`${command}\``;

    const state = new CheckState(join(env.stateDir, "check"));
    const session = event.sessionId ?? "";
    const fingerprint = await workingTreeFingerprint(env.processRunner, event.cwd, { env: env.env });
    if (fingerprint !== undefined && state.lastPass(event.cwd, command) === fingerprint) {
      state.setConsecutiveBlocks(session, event.name, 0);
      return undefined;
    }
    // A fresh stop (the Host isn't continuing because of a stop hook) starts a
    // new run of blocks. Hosts that don't send the signal keep counting.
    const blocks = event.stopHookActive === false ? 0 : state.consecutiveBlocks(session, event.name);
    if (blocks >= options.maxBlocks) {
      state.setConsecutiveBlocks(session, event.name, 0);
      return message(`${chosen} was still failing after ${blocks} attempts, so check let the Host stop. Run it to see the failures.`);
    }

    const result = await env.processRunner.run(command, [], {
      cwd: event.cwd,
      env: env.env,
      shell: true,
      timeoutMs: options.timeoutSeconds * 1000,
    });
    // Fail open (ADR-0004): a check that can't give an answer never holds the Host.
    if (result.timedOut) {
      return message(`${chosen} timed out after ${options.timeoutSeconds}s, so check let the Host stop unchecked.`);
    }
    if (result.spawnError !== undefined || result.exitCode === null || notFoundExitCodes.has(result.exitCode)) {
      const why = result.spawnError ?? (truncateOutput(result.stderr, 300) || `exit ${result.exitCode}`);
      return message(`could not run ${chosen} (${why}), so check let the Host stop unchecked.`);
    }
    if (result.exitCode === 0) {
      state.setConsecutiveBlocks(session, event.name, 0);
      state.recordPass(event.cwd, command, fingerprint);
      return detected ? message(`ran ${chosen}: passed.`) : undefined;
    }
    state.setConsecutiveBlocks(session, event.name, blocks + 1);
    state.recordPass(event.cwd, command, undefined);
    const output = truncateOutput(`${result.stdout}\n${result.stderr}`, options.outputBytes);
    return block(`${chosen} failed (exit ${result.exitCode}). Fix the problems before finishing.\n\n${output}`);
  },
});
