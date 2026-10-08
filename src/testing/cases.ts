/**
 * The test case format: one format for the fixtures hardhooks ships
 * (`src/hooks/<hook>/fixtures/*.json`) and the case files users write for
 * `hardhooks test`. A file holds one case object or an array of them.
 *
 * Shipped fixture (a captured Host payload, sent exactly as is):
 *
 *     { "description": "Force-push to main is blocked", "event": "PreToolUse",
 *       "payload": { "hook_event_name": "PreToolUse", "tool_name": "Bash", ... },
 *       "expect": { "decision": "block", "reason": "force" } }
 *
 * User case (the payload is built from the Event and tool):
 *
 *     { "name": "force-push to main is blocked", "bash": "git push --force origin main", "expect": "block" }
 */
import { resolve } from "node:path";
import { presetNames, type PresetName } from "../config";
import type { EventName } from "../event";
import { hostCapabilities, type HostId } from "../hosts";
import { eventOrder } from "../install/entries";
import type { Expectation, ExpectedDecision } from "./observe";

export interface TestCase {
  /** The case's `name` (user cases) or `description` (fixtures). */
  readonly name: string;
  /** The file it came from. */
  readonly source: string;
  /** Passed as `hardhooks run <Event>`. */
  readonly event: EventName;
  readonly host: HostId;
  /** Environment variables the dispatcher sees for this case, so it detects `host` (env-detected Hosts only). */
  readonly hostEnv?: Readonly<Record<string, string>> | undefined;
  /** The complete Host payload sent on stdin. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly expect: Expectation;
  /** Shipped fixtures only: the config they assume; skipped when the resolved config differs. */
  readonly assumes?: Assumptions | undefined;
}

export interface Assumptions {
  readonly preset?: PresetName | undefined;
  /** Options of the fixture's own Hook, compared with its resolved options. */
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

export type CaseKind = "fixture" | "case";

export interface ParseContext {
  /** `fixture` (shipped: may declare `assumes`) or `case` (a user's case file). */
  readonly kind: CaseKind;
  /** Directory that built payloads use as `cwd`, and relative paths resolve against. */
  readonly cwd: string;
}

export type ParsedCases = { readonly ok: true; readonly cases: TestCase[] } | { readonly ok: false; readonly errors: string[] };

const decisions: readonly ExpectedDecision[] = ["block", "ask", "allow", "none"];
const hosts = Object.keys(hostCapabilities) as HostId[];

/**
 * What makes the dispatcher detect each Host (`detectionRules` in
 * `src/hosts/index.ts`): fields over a built payload (`undefined` drops one),
 * and environment variables for Hosts it detects from the environment.
 * A complete `payload` is sent as is, so it must carry its own Host's fields.
 */
function hostSignals(host: HostId, cwd: string): { payload: Json; env?: Record<string, string> } {
  const noClaudeCode = { transcript_path: undefined, permission_mode: undefined };
  const timestamp = "2026-01-01T00:00:00.000Z";
  switch (host) {
    case "claude-code":
      return { payload: {} };
    case "cursor":
      return { payload: { cursor_version: "hardhooks-test", workspace_roots: [cwd] } };
    case "continue-cli":
      return { payload: { transcript_path: "" } };
    case "copilot-cli":
      return { payload: { ...noClaudeCode, timestamp } };
    case "copilot-cloud":
      return { payload: { ...noClaudeCode, timestamp }, env: { COPILOT_AGENT_PROMPT: "hardhooks test" } };
    case "devin-cli":
      // Cursor's env rule comes first, so clear a CURSOR_VERSION leaked from the user's terminal.
      return { payload: noClaudeCode, env: { CURSOR_VERSION: "", DEVIN_PROJECT_DIR: cwd } };
  }
}

class CaseError extends Error {}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function optionalString(c: Json, key: string): string | undefined {
  const value = c[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new CaseError(`"${key}" must be a non-empty string`);
  return value;
}

function regex(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CaseError(`"expect.${key}" must be a string (a regular expression)`);
  try {
    new RegExp(value, "i");
  } catch (error) {
    throw new CaseError(`"expect.${key}" is not a valid regular expression: ${(error as Error).message}`);
  }
  return value;
}

function parseExpect(value: unknown): Expectation {
  const decisionError = `must be one of ${decisions.join(", ")}`;
  if (typeof value === "string") {
    if (!decisions.includes(value as ExpectedDecision)) throw new CaseError(`"expect" ${decisionError}, or an object`);
    return { decision: value as ExpectedDecision };
  }
  if (!isObject(value)) throw new CaseError(`"expect" is required: ${decisions.join(", ")} or { decision?, reason?, context? }`);
  for (const key of Object.keys(value)) {
    if (!["decision", "reason", "context"].includes(key)) throw new CaseError(`unknown key "expect.${key}" (known: decision, reason, context)`);
  }
  const { decision } = value;
  if (decision !== undefined && !decisions.includes(decision as ExpectedDecision)) {
    throw new CaseError(`"expect.decision" ${decisionError}`);
  }
  if (Object.keys(value).length === 0) throw new CaseError(`"expect" must name a decision, reason or context`);
  return { decision: decision as ExpectedDecision | undefined, reason: regex(value.reason, "reason"), context: regex(value.context, "context") };
}

function parseAssumes(value: unknown): Assumptions {
  if (!isObject(value)) throw new CaseError(`"assumes" must be an object: { preset?, options? }`);
  for (const key of Object.keys(value)) {
    if (key !== "preset" && key !== "options") throw new CaseError(`unknown key "assumes.${key}" (known: preset, options)`);
  }
  const { preset, options } = value;
  if (preset !== undefined && !presetNames.includes(preset as PresetName)) {
    throw new CaseError(`"assumes.preset" must be one of ${presetNames.join(", ")}`);
  }
  if (options !== undefined && !isObject(options)) throw new CaseError(`"assumes.options" must be an object of the Hook's options`);
  return { preset: preset as PresetName | undefined, options };
}

/**
 * Tool shorthands: `{ "bash": "git push --force" }` is the Bash tool with that
 * command; `read`/`write`/`edit` take a file path (relative to the case's cwd).
 */
const shorthands: Record<string, { tool: string; input: (arg: string, cwd: string) => Json }> = {
  bash: { tool: "Bash", input: (command) => ({ command }) },
  read: { tool: "Read", input: (path, cwd) => ({ file_path: resolve(cwd, path) }) },
  write: { tool: "Write", input: (path, cwd) => ({ file_path: resolve(cwd, path), content: "" }) },
  edit: { tool: "Edit", input: (path, cwd) => ({ file_path: resolve(cwd, path), old_string: "", new_string: "" }) },
};

const toolEvents: readonly EventName[] = ["PreToolUse", "PostToolUse"];

/** Fields Claude Code sends for each Event besides the common ones, with neutral values. */
const eventFields: Partial<Record<EventName, Json>> = {
  PostToolUse: { tool_response: {} },
  Stop: { stop_hook_active: false },
  SubagentStop: { stop_hook_active: false },
  SessionStart: { source: "startup" },
  UserPromptSubmit: { prompt: "" },
  Notification: { message: "" },
  PreCompact: { trigger: "manual", custom_instructions: "" },
  SessionEnd: { reason: "other" },
};

const commonKeys = ["name", "description", "event", "host", "cwd", "tool", "input", ...Object.keys(shorthands), "payload", "expect"];
const knownKeys: Record<CaseKind, readonly string[]> = {
  fixture: [...commonKeys, "assumes"],
  case: commonKeys,
};

/** The tool call a case names, if any: `tool` + `input`, or one shorthand. */
function parseTool(c: Json, cwd: string): { name: string; input: Json } | undefined {
  const given = ["tool", ...Object.keys(shorthands)].filter((key) => c[key] !== undefined);
  if (given.length > 1) throw new CaseError(`give one of "tool", ${Object.keys(shorthands).map((k) => `"${k}"`).join(", ")}, not ${given.join(" and ")}`);
  if (c.input !== undefined && c.tool === undefined) throw new CaseError(`"input" needs "tool" (e.g. "tool": "Bash")`);
  const key = given[0];
  if (key === undefined) return undefined;
  const arg = optionalString(c, key);
  if (key === "tool") {
    if (c.input !== undefined && !isObject(c.input)) throw new CaseError(`"input" must be a JSON object (the tool input)`);
    return { name: arg!, input: (c.input as Json | undefined) ?? {} };
  }
  const shorthand = shorthands[key]!;
  return { name: shorthand.tool, input: shorthand.input(arg!, cwd) };
}

function parseCase(value: unknown, context: ParseContext): Omit<TestCase, "source"> {
  if (!isObject(value)) throw new CaseError("a case must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!knownKeys[context.kind].includes(key)) throw new CaseError(`unknown key "${key}" (known: ${knownKeys[context.kind].join(", ")})`);
  }
  const name = optionalString(value, "name") ?? optionalString(value, "description");
  if (name === undefined) throw new CaseError(`"name" is required`);

  const host = (optionalString(value, "host") ?? "claude-code") as HostId;
  if (!hosts.includes(host)) throw new CaseError(`unknown "host" ${JSON.stringify(host)} (known: ${hosts.join(", ")})`);

  const { payload } = value;
  if (payload !== undefined && !isObject(payload)) throw new CaseError(`"payload" must be a JSON object`);
  // A payload naming its Event is a complete Host payload (a captured fixture or an audit-log entry): sent as is.
  const complete = typeof payload?.hook_event_name === "string";

  const cwd = resolve(context.cwd, optionalString(value, "cwd") ?? ".");
  const tool = parseTool(value, cwd);
  if (complete && (tool !== undefined || value.cwd !== undefined)) {
    throw new CaseError(`a complete "payload" (one with hook_event_name) is sent as is; leave out "cwd", "tool" and its shorthands`);
  }

  const eventName =
    optionalString(value, "event") ?? (complete ? (payload!.hook_event_name as string) : tool !== undefined ? "PreToolUse" : undefined);
  if (eventName === undefined) throw new CaseError(`"event" is required (one of ${eventOrder.join(", ")})`);
  if (!eventOrder.includes(eventName as EventName)) {
    throw new CaseError(`unknown "event" ${JSON.stringify(eventName)} (known: ${eventOrder.join(", ")})`);
  }
  const event = eventName as EventName;
  if (tool !== undefined && !toolEvents.includes(event)) {
    throw new CaseError(`a tool only applies to ${toolEvents.join(" and ")}, not ${event}`);
  }

  const signals = hostSignals(host, cwd);
  return {
    name,
    event,
    host,
    ...(signals.env !== undefined ? { hostEnv: signals.env } : {}),
    payload: complete ? payload! : buildPayload(event, cwd, tool, { ...signals.payload, ...payload }),
    expect: parseExpect(value.expect),
    ...(value.assumes !== undefined ? { assumes: parseAssumes(value.assumes) } : {}),
  };
}

/** A Claude Code payload for the Event, with the Host's and then the case's `payload` fields on top. */
function buildPayload(event: EventName, cwd: string, tool: { name: string; input: Json } | undefined, extra: Json): Json {
  return {
    session_id: "hardhooks-test",
    // Non-empty, or the dispatcher would take it for Continue CLI, which can't ask.
    transcript_path: resolve(cwd, ".hardhooks-test", "transcript.jsonl"),
    cwd,
    permission_mode: "default",
    hook_event_name: event,
    ...(tool !== undefined ? { tool_name: tool.name, tool_input: tool.input, tool_use_id: "toolu_hardhooks_test" } : {}),
    ...eventFields[event],
    ...extra,
  };
}

/** Parse one case file's text. Errors name the file, the case and the problem. */
export function parseCaseFile(text: string, source: string, context: ParseContext): ParsedCases {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return { ok: false, errors: [`${source}: invalid JSON: ${(error as Error).message}`] };
  }
  const items = Array.isArray(value) ? value : [value];
  const cases: TestCase[] = [];
  const errors: string[] = [];
  items.forEach((item, index) => {
    const at = Array.isArray(value) ? `${source}[${index}]` : source;
    try {
      cases.push({ source, ...parseCase(item, context) });
    } catch (error) {
      if (!(error instanceof CaseError)) throw error;
      const label = isObject(item) && typeof (item.name ?? item.description) === "string" ? ` (${String(item.name ?? item.description)})` : "";
      errors.push(`${at}${label}: ${error.message}`);
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, cases };
}
