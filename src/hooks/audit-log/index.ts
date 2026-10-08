/**
 * audit-log (fails open): records every Event as one JSONL line in the user
 * state directory, never in the repo. Opt-in under `standard`, on under
 * `strict`.
 *
 * It decides nothing itself (`run` returns nothing). It is an observer: the
 * dispatcher calls `observe` once every Hook has decided, with each Hook's
 * Decision and timing and the final Host output. Then:
 *
 * - `./scrub.ts` redacts around protected paths and cuts tool input and
 *   output to `maxOutputBytes`;
 * - `./entry.ts` builds the entry (a `hardhooks test` case that replays to
 *   the same Decision) and redacts token-like values throughout;
 * - `./store.ts` appends it to `<stateDir>/audit-log/<project>/<day>.jsonl`
 *   and, on the first entry of a day, deletes files past `retentionDays`.
 *
 * Every error is swallowed: nothing is logged, and the Host sees nothing.
 */
import * as s from "../../config/schema";
import { defineHook } from "../hook";
import { auditEntry } from "./entry";
import { matcherFor, scrubPayload } from "./scrub";
import { appendEntry, logFile, projectRoot, prune } from "./store";

const optionsSchema = s.object({
  maxOutputBytes: s.number({
    integer: true,
    minimum: 0,
    description: "Keep at most this many bytes of a tool's output (and of its input, except the command and path) per entry.",
  }),
  retentionDays: s.number({
    integer: true,
    minimum: 1,
    description: "Delete day files older than this many days (checked on each project's first entry of the day).",
  }),
});

const options = { maxOutputBytes: 4096, retentionDays: 30 };

export const auditLog = defineHook({
  name: "audit-log",
  description: "Log every Event, tool input and each Hook's Decision and timing as JSONL in the user state directory.",
  events: ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop", "SessionStart", "SessionEnd", "Notification", "PreCompact"],
  failMode: "open",
  optionsSchema,
  defaults: {
    standard: { enabled: false, options },
    strict: { enabled: true, options },
  },
  run: () => undefined,
  observe(record, options, env) {
    try {
      const { event } = record;
      const time = env.clock.now();
      const project = projectRoot(event.cwd);
      const file = logFile(env, project, time);
      if (file === undefined) return;
      const payload = scrubPayload(event, matcherFor(project, record.config, env), options.maxOutputBytes);
      // Prune once per project and day, not on every Event.
      if (appendEntry(file, auditEntry(record, { time, project, payload }))) prune(env, time, options.retentionDays);
    } catch {
      // Never bother the Host, not even on stderr (ADR-0004).
    }
  },
});
