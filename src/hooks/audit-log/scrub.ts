/**
 * Making a Host payload safe and small enough to log:
 *
 * - When the tool touches a protected path (by the protect-secrets patterns:
 *   built-in, project ignore files, and protect-secrets' `protect`/`allow`
 *   options), whatever went into or came out of it is redacted: every tool
 *   input string except the path and the command, and the whole tool output.
 *   The path itself stays, so the entry replays to the same Decision.
 * - Tool output is cut to `maxBytes` (UTF-8), shared by its strings in
 *   order; so are the tool input's strings, except the path and the command,
 *   which Decisions depend on. A cut string ends `…[truncated N bytes]`; the
 *   JSON shape (keys, numbers, booleans) is kept.
 *
 * Token-like values anywhere are redacted separately, by `redactSecrets`
 * over the whole entry.
 */
import type { ResolvedConfig } from "../../config";
import type { Environment } from "../../environment";
import type { HookEvent } from "../../event";
import { secretsMatcher, type SecretsMatcher } from "../../secrets";
import { redacted } from "../../secrets/redact";

/** Tool input fields never redacted or cut: they name the target, and Guards decide on them. */
const keptInputFields = new Set(["file_path", "notebook_path", "path", "command"]);

interface ProtectSecretsOptions {
  protect?: string[];
  allow?: string[];
  ignoreFiles?: string[];
}

/**
 * The protect-secrets matcher for this project, with protect-secrets'
 * configured `protect`, `allow` and `ignoreFiles` (already validated). An
 * unreadable ignore file falls back to the other patterns.
 */
export function matcherFor(project: string, config: ResolvedConfig, env: Environment): SecretsMatcher {
  const configured = (config.hooks["protect-secrets"]?.options ?? {}) as ProtectSecretsOptions;
  const options = { projectDir: project, home: env.home, ...configured };
  try {
    return secretsMatcher(options);
  } catch {
    return secretsMatcher({ ...options, ignoreFiles: [] });
  }
}

/** Words of a command line that might be paths: split at whitespace, quotes and shell operators. */
function shellWords(command: string): string[] {
  return command.split(/[\s"'`;&|<>()=]+/).filter((word) => word !== "" && !word.startsWith("-"));
}

/** Whether the Event's tool reads, writes or searches a protected path. */
function touchesSecret(event: HookEvent, matcher: SecretsMatcher): boolean {
  const tool = event.tool;
  if (tool === undefined) return false;
  const matches = (path: string) => matcher.match(path, event.cwd) !== undefined;
  if (tool.filePath !== undefined && matches(tool.filePath)) return true;
  if (typeof tool.input.glob === "string" && matcher.matchGlob(tool.input.glob, event.cwd) !== undefined) return true;
  return tool.command !== undefined && shellWords(tool.command).some(matches);
}

/** A copy of a JSON value with every string passed through `edit`, in order. */
function mapStrings(value: unknown, edit: (text: string) => string): unknown {
  if (typeof value === "string") return edit(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, edit));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, edit)]));
  }
  return value;
}

/** Applies `edit` to every top-level field of a tool input except the kept ones. */
function mapInput(input: Readonly<Record<string, unknown>>, edit: (value: unknown) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, keptInputFields.has(key) ? value : edit(value)]));
}

/** A string editor that keeps the first `maxBytes` bytes of all the strings it sees, together. */
function truncator(maxBytes: number): (text: string) => string {
  let budget = maxBytes;
  return (text) => {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= budget) {
      budget -= bytes.length;
      return text;
    }
    // Drop a multi-byte character split by the cut.
    const kept = bytes.subarray(0, budget).toString("utf8").replace(/�$/, "");
    budget = 0;
    return `${kept}…[truncated ${bytes.length - Buffer.byteLength(kept, "utf8")} bytes]`;
  };
}

/** The payload to log: redacted around protected paths, tool input and output cut to `maxBytes`. */
export function scrubPayload(event: HookEvent, matcher: SecretsMatcher, maxBytes: number): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...event.payload };
  const secret = touchesSecret(event, matcher);
  const redactAll = (value: unknown) => mapStrings(value, () => redacted);
  if (event.tool !== undefined && typeof payload.tool_input === "object" && payload.tool_input !== null) {
    const cut = truncator(maxBytes);
    payload.tool_input = mapInput(event.tool.input, (value) => (secret ? redactAll(value) : mapStrings(value, cut)));
  }
  if ("tool_response" in payload) {
    payload.tool_response = secret ? redactAll(payload.tool_response) : mapStrings(payload.tool_response, truncator(maxBytes));
  }
  return payload;
}
