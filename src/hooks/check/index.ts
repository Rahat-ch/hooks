/**
 * check (fails open): when the Host tries to stop, run the project's check
 * command and block the stop with the failure output if it fails, so the Host
 * can't claim "done" while checks are red.
 */
import { block, message } from "../../decision";
import * as s from "../../config/schema";
import { defineHook } from "../hook";
import { detectCommand } from "./detect";
import { truncateOutput } from "./output";

const optionsSchema = s.object({
  command: s.optional(
    s.string({
      description:
        "Command line to run, through the platform shell (sh -c on POSIX, cmd.exe /d /s /c on Windows). Omit to autodetect.",
    }),
  ),
  outputBytes: s.number({
    integer: true,
    minimum: 200,
    maximum: 9000,
    description: "Most bytes of failure output to put in the block reason, which enters the Host's context.",
  }),
});

type CheckOptions = s.Infer<typeof optionsSchema>;

const presetOptions: CheckOptions = { outputBytes: 4000 };

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

    const result = await env.processRunner.run(command, [], { cwd: event.cwd, env: env.env, shell: true });
    if (result.exitCode === 0) return detected ? message(`ran ${chosen}: passed.`) : undefined;
    const output = truncateOutput(`${result.stdout}\n${result.stderr}`, options.outputBytes);
    return block(`${chosen} failed (exit ${result.exitCode}). Fix the problems before finishing.\n\n${output}`);
  },
});
