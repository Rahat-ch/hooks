/**
 * The dispatcher entry seam: one Host payload for one Event in, the
 * Host-visible result out. `hardhooks run <Event>` is a thin wrapper around
 * `dispatch`, and tests drive it directly.
 */
import { hookSettings, type ResolvedConfig } from "../config";
import { formatConfigError, loadConfig, type ConfigError } from "../config/load";
import { block, combineDecisions, type HookDecision } from "../decision";
import type { Environment } from "../environment";
import type { EventName, HookEvent } from "../event";
import type { Hook } from "../hooks/hook";
import { hooks as registeredHooks } from "../hooks/registry";
import { parseClaudeCodePayload, renderClaudeCodeOutput } from "../hosts/claude-code";

export interface DispatchRequest {
  /** The Event named on the command line: `hardhooks run <Event>`. */
  event: string;
  /** The raw Host payload, exactly as read from stdin. */
  payload: string;
  /**
   * The resolved config. Omit it to load `.hardhooks.json` and the user config
   * through `env`, as `hardhooks run` does.
   */
  config?: ResolvedConfig;
  env: Environment;
  /** Hooks to consider. Defaults to the built-in registry; tests may inject their own. */
  hooks?: readonly Hook<any>[];
}

/** What the Host sees: stdout, stderr and the process exit code. */
export interface HostResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a Hook handles this Event's tool (every Hook handles tool-less Events). */
function handlesTool(hook: Hook<any>, event: HookEvent): boolean {
  return event.tool === undefined || hook.tools === undefined || hook.tools.includes(event.tool.kind);
}

export async function dispatch(request: DispatchRequest): Promise<HostResult> {
  const { env } = request;
  const eventName = request.event as EventName;
  const hooks = request.hooks ?? registeredHooks;
  const loaded = request.config ? { ok: true as const, config: request.config } : loadConfig(env, hooks);
  if (!loaded.ok) return invalidConfig(eventName, request, hooks, loaded.errors);
  const { config } = loaded;

  const enabled = hooks.filter((hook) => hook.events.includes(eventName) && hookSettings(hook, config).enabled);
  // Fast path: the plugin's static hooks file calls us for every Event.
  if (enabled.length === 0) return { stdout: "", stderr: "", exitCode: 0 };

  const stderr: string[] = [];
  let event: HookEvent;
  try {
    event = parseClaudeCodePayload(request.payload, eventName, env.cwd);
  } catch (error) {
    // We can't tell which tool this is, so every Guard on this Event fails closed.
    const decisions = enabled
      .filter((hook) => hook.failMode === "closed")
      .map((hook) => ({ hook: hook.name, decision: block(`Could not read the Host payload: ${errorMessage(error)}`) }));
    return finish(eventName, decisions, [`hardhooks: ${errorMessage(error)}`]);
  }

  const selected = enabled.filter((hook) => handlesTool(hook, event));

  const results = await Promise.all(
    selected.map(async (hook): Promise<HookDecision | undefined> => {
      try {
        const decision = await hook.run(event, hookSettings(hook, config).options, env);
        return decision === undefined ? undefined : { hook: hook.name, decision };
      } catch (error) {
        if (hook.failMode === "closed") {
          return { hook: hook.name, decision: block(`${hook.name} failed, so it blocked to be safe: ${errorMessage(error)}`) };
        }
        stderr.push(`hardhooks: ${hook.name} failed (ignored): ${errorMessage(error)}`);
        return undefined;
      }
    }),
  );

  return finish(
    eventName,
    results.filter((r): r is HookDecision => r !== undefined),
    stderr,
  );
}

/**
 * The config can't be loaded (ADR-0004): block wherever a Guard would have
 * run, naming the errors, so a typo never silently disables protection. Allow
 * everywhere else. The errors always go to stderr.
 */
function invalidConfig(
  eventName: EventName,
  request: DispatchRequest,
  hooks: readonly Hook<any>[],
  errors: readonly ConfigError[],
): HostResult {
  const messages = errors.map(formatConfigError);
  const stderr = messages.map((message) => `hardhooks: invalid config: ${message}`);
  const guards = hooks.filter((hook) => hook.failMode === "closed" && hook.events.includes(eventName));
  if (guards.length === 0) return finish(eventName, [], stderr);

  let event: HookEvent | undefined;
  try {
    event = parseClaudeCodePayload(request.payload, eventName, request.env.cwd);
  } catch {
    // Unknown tool: every Guard on this Event counts.
  }
  if (event !== undefined && !guards.some((hook) => handlesTool(hook, event))) return finish(eventName, [], stderr);

  const reason =
    "The hardhooks config is invalid, so Guards block until it is fixed: " + messages.join("; ");
  return finish(eventName, [{ hook: "config", decision: block(reason) }], stderr);
}

function finish(eventName: string, decisions: readonly HookDecision[], stderr: readonly string[]): HostResult {
  const stdout = renderClaudeCodeOutput(eventName, combineDecisions(decisions));
  return { stdout, stderr: stderr.map((line) => `${line}\n`).join(""), exitCode: 0 };
}
