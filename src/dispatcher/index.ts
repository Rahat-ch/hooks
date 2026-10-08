/**
 * The dispatcher entry seam: one Host payload for one Event in, the
 * Host-visible result out. `hardhooks run <Event>` is a thin wrapper around
 * `dispatch`, and tests drive it directly.
 */
import type { HookSettings, ResolvedConfig } from "../config";
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
  config: ResolvedConfig;
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

function settingsFor(hook: Hook<any>, config: ResolvedConfig): HookSettings<unknown> {
  return config.hooks[hook.name] ?? hook.defaults[config.preset];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function dispatch(request: DispatchRequest): Promise<HostResult> {
  const { config, env } = request;
  const eventName = request.event as EventName;
  const enabled = (request.hooks ?? registeredHooks).filter(
    (hook) => hook.events.includes(eventName) && settingsFor(hook, config).enabled,
  );
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

  const selected = enabled.filter(
    (hook) => event.tool === undefined || hook.tools === undefined || hook.tools.includes(event.tool.kind),
  );

  const results = await Promise.all(
    selected.map(async (hook): Promise<HookDecision | undefined> => {
      try {
        const decision = await hook.run(event, settingsFor(hook, config).options, env);
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

function finish(eventName: string, decisions: readonly HookDecision[], stderr: readonly string[]): HostResult {
  const stdout = renderClaudeCodeOutput(eventName, combineDecisions(decisions));
  return { stdout, stderr: stderr.map((line) => `${line}\n`).join(""), exitCode: 0 };
}
