/**
 * Claude Code's command-hook protocol: payload in, JSON out.
 * https://code.claude.com/docs/en/hooks
 *
 * Copilot CLI, Cursor, Devin CLI and Continue read the same settings and
 * speak the same format (ADR-0003), so this is the only Host translator in v1.
 */
import type { Outcome } from "../decision";
import type { EventName, HookEvent, ToolKind } from "../event";

/** Claude Code tool names by Host-neutral kind. `init` derives matchers from this. */
export const claudeCodeTools: Readonly<Record<Exclude<ToolKind, "other">, readonly string[]>> = {
  shell: ["Bash"],
  read: ["Read"],
  edit: ["Edit", "MultiEdit", "NotebookEdit"],
  write: ["Write"],
  search: ["Grep", "Glob"],
};

export function toolKind(toolName: string): ToolKind {
  for (const [kind, names] of Object.entries(claudeCodeTools)) {
    if (names.includes(toolName)) return kind as ToolKind;
  }
  return "other";
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export class InvalidPayloadError extends Error {}

/** Parse a Claude Code hook payload (stdin) into a Host-neutral Event. */
export function parseClaudeCodePayload(raw: string, eventName: EventName, fallbackCwd: string): HookEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new InvalidPayloadError(`payload is not valid JSON (${(error as Error).message})`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new InvalidPayloadError("payload is not a JSON object");
  }
  const p = payload as Record<string, unknown>;

  const toolName = str(p.tool_name);
  const toolInput =
    typeof p.tool_input === "object" && p.tool_input !== null ? (p.tool_input as Record<string, unknown>) : {};
  const tool =
    toolName === undefined
      ? undefined
      : {
          name: toolName,
          kind: toolKind(toolName),
          input: toolInput,
          command: str(toolInput.command),
          filePath: str(toolInput.file_path) ?? str(toolInput.notebook_path) ?? str(toolInput.path),
        };

  return {
    name: eventName,
    host: "claude-code",
    cwd: str(p.cwd) ?? fallbackCwd,
    sessionId: str(p.session_id),
    tool,
    toolResponse: p.tool_response,
    stopHookActive: typeof p.stop_hook_active === "boolean" ? p.stop_hook_active : undefined,
    source: str(p.source),
    prompt: str(p.prompt),
    message: str(p.message),
    payload: p,
  };
}

/** Events whose block is a top-level `decision: "block"` with a `reason`. */
const topLevelBlockEvents = new Set<string>(["PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop"]);
/** Events that accept `hookSpecificOutput.additionalContext`. */
const contextEvents = new Set<string>([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
]);

/**
 * Render an Outcome as Claude Code's JSON hook output. Returns "" when there
 * is nothing for the Host to act on: an `allow` is never emitted, because a
 * Hook allowing something must not bypass the Host's own permission prompts.
 */
export function renderClaudeCodeOutput(eventName: string, outcome: Outcome): string {
  const out: Record<string, unknown> = {};
  const specific: Record<string, unknown> = { hookEventName: eventName };

  if (outcome.permission === "block" || outcome.permission === "ask") {
    if (eventName === "PreToolUse") {
      specific.permissionDecision = outcome.permission === "block" ? "deny" : "ask";
      specific.permissionDecisionReason = outcome.reason;
    } else if (topLevelBlockEvents.has(eventName)) {
      // These Events have no `ask`; asking to continue is treated as blocking.
      out.decision = "block";
      out.reason = outcome.reason;
    } else if (outcome.reason !== undefined) {
      // The Event cannot be blocked; surface the reason to the user instead.
      out.systemMessage = outcome.reason;
    }
  }
  if (outcome.context !== undefined && contextEvents.has(eventName)) specific.additionalContext = outcome.context;
  // Universal field: the Host writes it to its terminal, on every Event (interactive sessions only).
  if (outcome.terminalSequence !== undefined) out.terminalSequence = outcome.terminalSequence;

  if (Object.keys(specific).length > 1) out.hookSpecificOutput = specific;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
}
