/**
 * notify (fails open): alerts the user when the Host needs them, without ever
 * delaying the Host.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { terminalSequence, type Decision } from "../../decision";
import type { Environment } from "../../environment";
import type { HookEvent } from "../../event";
import * as s from "../../config/schema";
import { defineHook } from "../hook";
import { desktopCommand, type Command, type Notification } from "./desktop";
import { webhookCommand } from "./webhook";

const optionsSchema = s.object({
  thresholdSeconds: s.number({
    minimum: 0,
    description: "Notify at Stop only when the turn ran longer than this many seconds.",
  }),
  sound: s.boolean({ description: "Play the platform's notification sound with desktop notifications." }),
  webhook: s.optional(
    s.object(
      {
        url: s.string({ description: "The ntfy topic URL (e.g. https://ntfy.sh/my-topic) or Slack incoming-webhook URL." }),
        kind: s.oneOf(["ntfy", "slack"]),
      },
      { description: "Also post each notification to this webhook (opt-in)." },
    ),
  ),
});

type Options = s.Infer<typeof optionsSchema>;

/** Where the start of the session's current turn is kept. */
function turnFile(env: Environment, event: HookEvent): string {
  const session = (event.sessionId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(env.stateDir, "notify", "turns", `${session}.json`);
}

function recordTurnStart(event: HookEvent, env: Environment): void {
  const file = turnFile(env, event);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ startedAt: env.clock.now().toISOString() }));
}

/** Seconds since the current turn started, or undefined when no start was recorded. */
function turnSeconds(event: HookEvent, env: Environment): number | undefined {
  const file = turnFile(env, event);
  if (!existsSync(file)) return undefined;
  const { startedAt } = JSON.parse(readFileSync(file, "utf8")) as { startedAt: string };
  return (env.clock.now().getTime() - Date.parse(startedAt)) / 1000;
}

/**
 * An OSC 9 desktop notification (iTerm2, WezTerm, Windows Terminal, ConEmu),
 * minus control characters so the text can't end the sequence early or smuggle
 * in another one; the Host rejects anything outside its allowlist.
 */
function osc9(notification: Notification): string {
  const text = `${notification.title}: ${notification.body}`.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return `\u001b]9;${text}\u0007`;
}

function start({ command, args, env }: Command, environment: Environment): void {
  environment.processRunner.spawnDetached(command, args, env ? { env } : {});
}

/**
 * Start a native notification, and the webhook if configured, each in a
 * detached process. Without a native notifier, fall back to OSC 9: hooks have
 * no controlling terminal (`/dev/tty` fails), so the Host writes the sequence
 * to its own terminal from our `terminalSequence` output.
 */
function deliver(notification: Notification, options: Options, env: Environment): Decision | undefined {
  const native = desktopCommand(notification, options.sound, env);
  if (native) start(native, env);
  if (options.webhook) start(webhookCommand(notification, options.webhook), env);
  return native ? undefined : terminalSequence(osc9(notification));
}

export const notify = defineHook({
  name: "notify",
  description: "Desktop notification when the Host needs input, or finishes a long turn.",
  events: ["Notification", "Stop", "UserPromptSubmit"],
  failMode: "open",
  optionsSchema,
  defaults: {
    standard: { enabled: false, options: { thresholdSeconds: 30, sound: true } },
    strict: { enabled: true, options: { thresholdSeconds: 30, sound: true } },
  },
  run(event, options, env) {
    const title = basename(event.cwd);
    if (event.name === "UserPromptSubmit") {
      recordTurnStart(event, env);
      return undefined;
    }
    if (event.name === "Stop") {
      const seconds = turnSeconds(event, env);
      if (seconds === undefined || seconds <= options.thresholdSeconds) return undefined;
      return deliver({ title, body: `Finished after ${Math.round(seconds)}s` }, options, env);
    }
    return deliver({ title, body: event.message ?? "Needs your attention" }, options, env);
  },
});
