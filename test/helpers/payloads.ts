/**
 * Builders for Claude Code hook payloads (what a Host writes to the hook's
 * stdin), one per Event. Shapes follow https://code.claude.com/docs/en/hooks.
 * Every builder accepts overrides so tests can add or replace any field.
 */

export type ClaudeCodePayload = Record<string, unknown> & { hook_event_name: string };

const common = {
  session_id: "test-session",
  transcript_path: "/tmp/hardhooks-test/transcript.jsonl",
  cwd: "/tmp/hardhooks-test/project",
  permission_mode: "default",
};

function payload(event: string, fields: Record<string, unknown>): ClaudeCodePayload {
  return { ...common, hook_event_name: event, ...fields };
}

export const claudeCode = {
  preToolUse(tool_name: string, tool_input: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return payload("PreToolUse", { tool_name, tool_input, tool_use_id: "toolu_test", ...overrides });
  },

  /** PreToolUse for the Bash tool running `command`. */
  bash(command: string, overrides: Record<string, unknown> = {}) {
    return claudeCode.preToolUse("Bash", { command, description: "test command" }, overrides);
  },

  postToolUse(
    tool_name: string,
    tool_input: Record<string, unknown>,
    tool_response: unknown = {},
    overrides: Record<string, unknown> = {},
  ) {
    return payload("PostToolUse", { tool_name, tool_input, tool_response, tool_use_id: "toolu_test", ...overrides });
  },

  stop(overrides: Record<string, unknown> = {}) {
    return payload("Stop", { stop_hook_active: false, ...overrides });
  },

  subagentStop(overrides: Record<string, unknown> = {}) {
    return payload("SubagentStop", { stop_hook_active: false, ...overrides });
  },

  /** `source` is one of startup, resume, clear, compact. */
  sessionStart(source = "startup", overrides: Record<string, unknown> = {}) {
    return payload("SessionStart", { source, ...overrides });
  },

  userPromptSubmit(prompt: string, overrides: Record<string, unknown> = {}) {
    return payload("UserPromptSubmit", { prompt, ...overrides });
  },

  notification(message: string, overrides: Record<string, unknown> = {}) {
    return payload("Notification", { message, ...overrides });
  },
};

/**
 * Payload fields that identify Hosts other than Claude Code, merged into a
 * Claude Code payload: `claudeCode.bash("ls", hostPayloadFields.cursor)`.
 * Synthetic, from each Host's docs (see src/hosts/index.ts); captured
 * payloads replace them as fixtures (#15).
 */
export const hostPayloadFields = {
  cursor: {
    conversation_id: "test-conversation",
    generation_id: "test-generation",
    cursor_version: "1.7.2",
    workspace_roots: ["/tmp/hardhooks-test/project"],
  },
  copilotCli: { timestamp: "2026-01-01T09:00:00.000Z", transcript_path: undefined, permission_mode: undefined },
  continueCli: { transcript_path: "" },
} as const;
