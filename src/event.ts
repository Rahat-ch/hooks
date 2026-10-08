/**
 * The Host-neutral Event a Hook receives. Host translators (src/hosts/*) build
 * it from a Host payload; Hooks must not read Host-specific payload fields
 * except through `payload` as a last resort.
 */

/** Event names follow Claude Code's (the canonical format, ADR-0003). */
export type EventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "SessionStart"
  | "SessionEnd"
  | "Notification"
  | "PreCompact";

/**
 * What kind of thing a tool does, independent of what the Host calls it.
 * Hooks match on kinds; each Host translator maps its tool names to kinds.
 */
export type ToolKind = "shell" | "read" | "edit" | "write" | "search" | "other";

export interface ToolCall {
  /** The Host's own tool name, e.g. "Bash". */
  readonly name: string;
  readonly kind: ToolKind;
  readonly input: Readonly<Record<string, unknown>>;
  /** For shell tools: the command line, when present. */
  readonly command?: string | undefined;
  /** For file tools: the target path, when present. */
  readonly filePath?: string | undefined;
}

export interface HookEvent {
  readonly name: EventName;
  /** Which Host sent the Event, e.g. "claude-code". */
  readonly host: string;
  /** The project directory the Host is working in. */
  readonly cwd: string;
  readonly sessionId?: string | undefined;
  /** The tool about to run (PreToolUse) or that just ran (PostToolUse). */
  readonly tool?: ToolCall | undefined;
  /** PostToolUse: the tool's result. */
  readonly toolResponse?: unknown;
  /** Stop/SubagentStop: the Host is already continuing because of a stop hook. */
  readonly stopHookActive?: boolean | undefined;
  /** SessionStart: startup, resume, clear or compact. */
  readonly source?: string | undefined;
  /** UserPromptSubmit: the prompt text. */
  readonly prompt?: string | undefined;
  /** Notification: the message shown to the user. */
  readonly message?: string | undefined;
  /** The raw Host payload. Escape hatch only; prefer the normalized fields. */
  readonly payload: Readonly<Record<string, unknown>>;
}
