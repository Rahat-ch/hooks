/**
 * notify (fails open): alerts the user when the Host needs them, without ever
 * delaying the Host.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Environment } from "../../environment";
import type { HookEvent } from "../../event";
import * as s from "../../config/schema";
import { defineHook } from "../hook";
import { desktopCommand } from "./desktop";

const optionsSchema = s.object({
  thresholdSeconds: s.number({
    minimum: 0,
    description: "Notify at Stop only when the turn ran longer than this many seconds.",
  }),
});

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

function deliver(title: string, body: string, env: Environment): void {
  const native = desktopCommand({ title, body }, env);
  if (native) env.processRunner.spawnDetached(native.command, native.args, native.env ? { env: native.env } : {});
}

export const notify = defineHook({
  name: "notify",
  description: "Desktop notification when the Host needs input, or finishes a long turn.",
  events: ["Notification", "Stop", "UserPromptSubmit"],
  failMode: "open",
  optionsSchema,
  defaults: {
    standard: { enabled: false, options: { thresholdSeconds: 30 } },
    strict: { enabled: true, options: { thresholdSeconds: 30 } },
  },
  run(event, options, env) {
    const title = basename(event.cwd);
    if (event.name === "UserPromptSubmit") {
      recordTurnStart(event, env);
    } else if (event.name === "Stop") {
      const seconds = turnSeconds(event, env);
      if (seconds !== undefined && seconds > options.thresholdSeconds) {
        deliver(title, `Finished after ${Math.round(seconds)}s`, env);
      }
    } else {
      deliver(title, event.message ?? "Needs your attention", env);
    }
    return undefined;
  },
});
