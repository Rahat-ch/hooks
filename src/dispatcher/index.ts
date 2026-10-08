/**
 * The dispatcher entry seam: one Host payload for one Event in, the
 * Host-visible result out. `hardhooks run <Event>` is a thin wrapper around
 * `dispatch`, and tests drive it directly.
 */
import { hookSettings, type PresetName, type ResolvedConfig } from "../config";
import { formatConfigError, loadConfig, type ConfigError } from "../config/load";
import { block, combineDecisions, message, type HookDecision, type Outcome } from "../decision";
import type { Environment } from "../environment";
import type { EventName, HookEvent } from "../event";
import type { Hook, HookRun } from "../hooks/hook";
import { hooks as registeredHooks } from "../hooks/registry";
import { parseClaudeCodePayload, renderClaudeCodeOutput } from "../hosts/claude-code";
import { capabilitiesOf } from "../hosts";
import { noticeDue, trustStatus, untrustedReason, type TrustStatus } from "../trust";

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
  /**
   * Whether the project's own commands may run (ADR-0005). Omit to look it up
   * as `hardhooks trust` recorded it in `env.stateDir`, for the Event's project.
   */
  trusted?: boolean;
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
  const trust = lazyTrust(request, event);

  const handled = await Promise.all(
    selected.map(async (hook): Promise<{ run: HookRun; notice?: HookDecision }> => {
      const skipped: string[] = [];
      let settings = hookSettings(hook, config);
      const withheld = config.repoCommands?.[hook.name] ?? [];
      if (withheld.length > 0 && !trust.trusted()) {
        settings = hookSettings(hook, { preset: config.preset, hooks: config.untrustedHooks ?? {} });
        skipped.push(...withheld.map((option) => `${hook.name}.${option} from .hardhooks.json`));
      }
      const projectTrust = {
        mayRun(what: string) {
          if (trust.trusted()) return true;
          skipped.push(what);
          return false;
        },
      };
      const run = await runHook(hook, () => hook.run(event, settings.options, env, projectTrust));
      if (skipped.length > 0 && noticeDue(env, trust.status().root, event.sessionId, hook.name)) {
        const notice = message(`skipped ${skipped.join(", ")}: ${untrustedReason(trust.status())}.`);
        return { run, notice: { hook: hook.name, decision: notice } };
      }
      return { run };
    }),
  );
  const runs = handled.map(({ run }) => run);

  async function runHook(hook: Hook<any>, invoke: () => ReturnType<Hook<any>["run"]>): Promise<HookRun> {
    const call = timed(invoke);
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
  }

  const decisions = handled.flatMap(({ run, notice }): HookDecision[] => [
    ...(run.decision ? [{ hook: run.hook, decision: run.decision }] : []),
    ...(notice ? [notice] : []),
  ]);
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
 * The Event's project trust (ADR-0005), looked up at most once and only when
 * a Hook needs it, so Events without project commands pay nothing.
 */
function lazyTrust(request: DispatchRequest, event: HookEvent) {
  let status: TrustStatus | undefined;
  const lookup = () => (status ??= trustStatus(request.env, event.cwd));
  return {
    trusted: () => request.trusted ?? lookup().state === "trusted",
    status: lookup,
  };
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
