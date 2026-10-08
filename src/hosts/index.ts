/**
 * Which Host spawned us, and what it can do with our output.
 *
 * Every Host in v1 runs our Claude Code-format settings entry (ADR-0003) and
 * reads Claude Code's output, but not every Host honours every Decision: some
 * ignore `permissionDecision: "ask"`. The dispatcher infers the Host from the
 * payload and environment with the rules below, then looks up its
 * capabilities. An unknown Host is treated as Claude Code.
 *
 * The rules come from each Host's docs (researched 2026-10-08, sources inline)
 * and are data so captured fixtures (#15) can refine them. Payload signals
 * come first: environment variables leak from a parent process (Claude Code
 * sets `CLAUDECODE=1` in every child, IDE terminals included), so env alone
 * only decides when the payload says nothing distinctive.
 */

export type HostId = "claude-code" | "copilot-cli" | "copilot-cloud" | "cursor" | "devin-cli" | "continue-cli";

export interface HostCapabilities {
  /** Display name for messages. */
  readonly name: string;
  /** PreToolUse `permissionDecision: "ask"` prompts the user. */
  readonly ask: boolean;
}

export const hostCapabilities: Readonly<Record<HostId, HostCapabilities>> = {
  // "`"ask"` prompts the user to confirm." https://code.claude.com/docs/en/hooks
  "claude-code": { name: "Claude Code", ask: true },
  // Decisions "allow", "deny", "ask"; changelog 1.0.4: "Hooks can now request user confirmation
  // before tool execution with 'ask' permission decision".
  // https://docs.github.com/en/copilot/reference/hooks-reference
  "copilot-cli": { name: "Copilot CLI", ask: true },
  // Cloud agent: "`ask` is treated as `deny`".
  // https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/use-hooks
  "copilot-cloud": { name: "Copilot cloud agent", ask: false },
  // "`"ask"` is accepted by the schema but not enforced for `preToolUse` today."
  // https://cursor.com/docs/reference/third-party-hooks
  cursor: { name: "Cursor", ask: false },
  // Only `decision: "approve" | "block"` is documented; no permissionDecision.
  // https://docs.devin.ai/cli/extensibility/hooks/overview.md
  "devin-cli": { name: "Devin CLI", ask: false },
  // hookRunner.ts acts only on `permissionDecision === "deny"`.
  // https://github.com/continuedev/continue/tree/main/extensions/cli/src/hooks
  "continue-cli": { name: "Continue CLI", ask: false },
};

type Payload = Readonly<Record<string, unknown>>;
type Env = Readonly<Record<string, string | undefined>>;

export interface DetectionRule {
  readonly host: HostId;
  readonly matches: (payload: Payload, env: Env) => boolean;
}

const has = (payload: Payload, key: string) => payload[key] !== undefined;
const set = (env: Env, key: string) => env[key] !== undefined && env[key] !== "";

/** Checked in order; the first match wins. */
export const detectionRules: readonly DetectionRule[] = [
  // Payload: `cursor_version` ("Cursor application version"), `workspace_roots`,
  // `conversation_id`, `generation_id`. https://cursor.com/docs/hooks
  {
    host: "cursor",
    matches: (p) => has(p, "cursor_version") || has(p, "workspace_roots") || (has(p, "conversation_id") && has(p, "generation_id")),
  },
  // fireHook.ts: `transcript_path: "", // We don't have a transcript file like Claude Code`.
  { host: "continue-cli", matches: (p) => p.transcript_path === "" },
  // Copilot payloads carry `timestamp: string // ISO 8601` (Claude Code's don't); the cloud
  // agent also sets COPILOT_AGENT_PROMPT. https://docs.github.com/en/copilot/reference/hooks-reference
  { host: "copilot-cloud", matches: (p, env) => typeof p.timestamp === "string" && set(env, "COPILOT_AGENT_PROMPT") },
  { host: "copilot-cli", matches: (p) => typeof p.timestamp === "string" },
  // Claude Code's own payload shape: a transcript file and a permission mode.
  // https://code.claude.com/docs/en/hooks
  {
    host: "claude-code",
    matches: (p) => typeof p.transcript_path === "string" && p.transcript_path !== "" && typeof p.permission_mode === "string",
  },
  // Environment only from here on.
  // CURSOR_VERSION is set for every hook. https://cursor.com/docs/hooks ("Environment Variables")
  { host: "cursor", matches: (_, env) => set(env, "CURSOR_VERSION") },
  // "The `DEVIN_PROJECT_DIR` environment variable is automatically set to the project root directory."
  // https://docs.devin.ai/cli/extensibility/hooks/overview.md
  { host: "devin-cli", matches: (_, env) => set(env, "DEVIN_PROJECT_DIR") },
  // hookRunner.ts: `env = { ...process.env, CLAUDE_PROJECT_DIR: cwd, CONTINUE_PROJECT_DIR: cwd }`.
  { host: "continue-cli", matches: (_, env) => set(env, "CONTINUE_PROJECT_DIR") },
  { host: "copilot-cloud", matches: (_, env) => set(env, "COPILOT_AGENT_PROMPT") },
  // Changelog 0.0.421: "Git hooks can detect Copilot CLI subprocesses via the COPILOT_CLI=1
  // environment variable". https://github.com/github/copilot-cli/blob/main/changelog.md
  { host: "copilot-cli", matches: (_, env) => env.COPILOT_CLI === "1" },
];

/** The Host that sent this payload; Claude Code when nothing matches. */
export function detectHost(payload: Payload, env: Env, rules: readonly DetectionRule[] = detectionRules): HostId {
  return rules.find((rule) => rule.matches(payload, env))?.host ?? "claude-code";
}

export function capabilitiesOf(host: string): HostCapabilities {
  return hostCapabilities[host as HostId] ?? hostCapabilities["claude-code"];
}
