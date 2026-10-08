/**
 * The dispatcher entry seam: one Host payload for one Event in, the
 * Host-visible result out. `hardhooks run <Event>` is a thin wrapper around
 * `dispatch`, and tests drive it directly.
 */
import { hookSettings, type PresetName, type ResolvedConfig } from "../config";
import { formatConfigError, loadConfig, type ConfigError } from "../config/load";
import { block, combineDecisions, type HookDecision, type Outcome } from "../decision";
import type { Environment } from "../environment";
import type { EventName, HookEvent } from "../event";
import type { Hook, HookRun } from "../hooks/hook";
import { hooks as registeredHooks } from "../hooks/registry";
import { parseClaudeCodePayload, renderClaudeCodeOutput } from "../hosts/claude-code";
import { capabilitiesOf } from "../hosts";

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

/** How long a Guard may take unless it declares its own `timeoutMs`. */
const GUARD_TIMEOUT_MS = 30_000;

/** Settle with `promise`, or reject once `ms` have passed. No limit when `ms` is undefined. */
function withTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    // Never keep the process alive just to time a Hook out.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Call `fn` in a microtask, timing the call itself. Hooks start one after
 * another, so timing the `await` around them would charge a synchronous Hook
 * for the Hooks after it; a Promise is timed until it settles.
 */
function timed<T>(fn: () => T | Promise<T>): { promise: Promise<T>; elapsed(): number } {
  let start: number | undefined;
  let end: number | undefined;
  const promise = Promise.resolve().then(() => {
    start = performance.now();
    let value: T | Promise<T>;
    try {
      value = fn();
    } catch (error) {
      end = performance.now();
      throw error;
    }
    if (value instanceof Promise) return value.finally(() => void (end = performance.now()));
    end = performance.now();
    return value;
  });
  return { promise, elapsed: () => (start === undefined ? 0 : (end ?? performance.now()) - start) };
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

  const started = performance.now();
  const stderr: string[] = [];
  let event: HookEvent;
  try {
    event = parseClaudeCodePayload(request.payload, eventName, env.cwd, env.env);
  } catch (error) {
    // We can't tell which tool this is, so every Guard on this Event fails closed.
    const decisions = enabled
      .filter((hook) => hook.failMode === "closed")
      .map((hook) => ({ hook: hook.name, decision: block(`Could not read the Host payload: ${errorMessage(error)}`) }));
    return finish(eventName, decisions, [`hardhooks: ${errorMessage(error)}`]);
  }

  const selected = enabled.filter((hook) => handlesTool(hook, event));

  const runs = await Promise.all(
    selected.map(async (hook): Promise<HookRun> => {
      const call = timed(() => hook.run(event, hookSettings(hook, config).options, env));
      try {
        const decision = await withTimeout(
          call.promise,
          hook.timeoutMs ?? (hook.failMode === "closed" ? GUARD_TIMEOUT_MS : undefined),
        );
        return { hook: hook.name, decision, durationMs: call.elapsed() };
      } catch (error) {
        const durationMs = call.elapsed();
        if (hook.failMode === "closed") {
          const decision = block(`${hook.name} failed, so it blocked to be safe: ${errorMessage(error)}`);
          return { hook: hook.name, decision, error: errorMessage(error), durationMs };
        }
        stderr.push(`hardhooks: ${hook.name} failed (ignored): ${errorMessage(error)}`);
        return { hook: hook.name, decision: undefined, error: errorMessage(error), durationMs };
      }
    }),
  );

  const decisions = runs.flatMap(({ hook, decision }): HookDecision[] => (decision ? [{ hook, decision }] : []));
  const outcome = askFallback(eventName, combineDecisions(decisions), event.host, config.preset);
  if (outcome.warning !== undefined) stderr.push(`hardhooks: ${outcome.warning}`);
  const result = render(eventName, outcome, stderr);

  // Observers (audit-log) see the final result; they can't change it, and their errors are ignored.
  const record = { event, config, runs, result, durationMs: performance.now() - started };
  for (const hook of selected) {
    if (hook.observe === undefined) continue;
    try {
      await hook.observe(record, hookSettings(hook, config).options, env);
    } catch {
      // Fail open, silently: an observer never changes what the Host sees.
    }
  }
  return result;
}

/**
 * Where the Host ignores `ask` (Cursor, Devin CLI, ...), an ask would let the
 * command run unconfirmed. Under `standard` it becomes an allow with a warning
 * to the user; under `strict` a block.
 */
function askFallback(eventName: EventName, outcome: Outcome, host: string, preset: PresetName): Outcome {
  if (eventName !== "PreToolUse" || outcome.permission !== "ask") return outcome;
  const { name, ask } = capabilitiesOf(host);
  if (ask) return outcome;
  if (preset === "strict") {
    return {
      ...outcome,
      permission: "block",
      reason: `${name} can't ask for confirmation, so the strict Preset blocks this instead:\n${outcome.reason ?? ""}`,
    };
  }
  return {
    ...outcome,
    permission: undefined,
    reason: undefined,
    warning: `${name} can't ask for confirmation, so this was allowed under the standard Preset. It needed confirmation because:\n${outcome.reason ?? ""}`,
  };
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
    event = parseClaudeCodePayload(request.payload, eventName, request.env.cwd, request.env.env);
  } catch {
    // Unknown tool: every Guard on this Event counts.
  }
  if (event !== undefined && !guards.some((hook) => handlesTool(hook, event))) return finish(eventName, [], stderr);

  const reason =
    "The hardhooks config is invalid, so Guards block until it is fixed: " + messages.join("; ");
  return finish(eventName, [{ hook: "config", decision: block(reason) }], stderr);
}

function finish(eventName: string, decisions: readonly HookDecision[], stderr: readonly string[]): HostResult {
  return render(eventName, combineDecisions(decisions), stderr);
}

function render(eventName: string, outcome: Outcome, stderr: readonly string[]): HostResult {
  const stdout = renderClaudeCodeOutput(eventName, outcome);
  return { stdout, stderr: stderr.map((line) => `${line}\n`).join(""), exitCode: 0 };
}
