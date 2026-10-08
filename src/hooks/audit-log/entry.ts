/**
 * One audit-log entry. It is a `hardhooks test` case (`src/testing/cases.ts`):
 * `payload` is the Host payload with `hook_event_name`, replayed as is, and
 * `expect` is the Decision the Host saw, so a line of the log replays
 * through the dispatcher to the same Decision. What happened lives under
 * `audit`, which case files ignore:
 *
 *     { "name": "PreToolUse Bash at 2026-01-01T09:00:00.000Z", "event": "PreToolUse", "host": "claude-code",
 *       "payload": { "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { ... }, ... },
 *       "expect": { "decision": "block" },
 *       "audit": { "time": "...", "project": "/path", "session": "...", "tool": "Bash", "ms": 4.2,
 *                  "hooks": [{ "hook": "git-guard", "decision": "block", "reason": "...", "ms": 1.3 }, ...] } }
 */
import type { Decision } from "../../decision";
import { redactSecretsDeep } from "../../secrets/redact";
import { observe } from "../../testing/observe";
import type { DispatchRecord, HookRun } from "../hook";

/** Milliseconds to one decimal. */
const ms = (value: number) => Math.round(value * 10) / 10;

function describeDecision(decision: Decision | undefined): Record<string, unknown> {
  if (decision === undefined) return { decision: "none" };
  switch (decision.kind) {
    case "block":
    case "ask":
      return { decision: decision.kind, reason: decision.reason };
    case "context":
    case "message":
      return { decision: decision.kind, text: decision.text };
    default:
      return { decision: decision.kind };
  }
}

function describeRun(run: HookRun): Record<string, unknown> {
  return {
    hook: run.hook,
    ...describeDecision(run.decision),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ms: ms(run.durationMs),
  };
}

export interface EntryContext {
  readonly time: Date;
  /** The project root the entry is filed under. */
  readonly project: string;
  /** The Host payload to log, already scrubbed around protected paths (`./scrub.ts`). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The entry for one dispatched Event, with token-like values redacted throughout. */
export function auditEntry(record: DispatchRecord, context: EntryContext): Record<string, unknown> {
  const { event } = record;
  const time = context.time.toISOString();
  return redactSecretsDeep({
    name: `${event.name}${event.tool ? ` ${event.tool.name}` : ""} at ${time}`,
    event: event.name,
    host: event.host,
    payload: context.payload,
    expect: { decision: observe(record.result).decision },
    audit: {
      time,
      project: context.project,
      ...(event.sessionId !== undefined ? { session: event.sessionId } : {}),
      ...(event.tool ? { tool: event.tool.name } : {}),
      ms: ms(record.durationMs),
      hooks: record.runs.filter((run) => run.hook !== "audit-log").map(describeRun),
    },
  });
}
