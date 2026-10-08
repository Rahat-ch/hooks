import type { HookSettings, PresetName } from "../config";
import type { ObjectSchema } from "../config/schema";
import type { Decision } from "../decision";
import type { Environment } from "../environment";
import type { EventName, HookEvent, ToolKind } from "../event";

/**
 * A Hook: one reusable unit hardhooks ships. Host-neutral: it sees a
 * normalized HookEvent and returns a Decision. It never writes stdout/stderr
 * or exits; the dispatcher does all talking to the Host.
 */
export interface Hook<Options = Record<string, never>> {
  /** kebab-case, matches its directory under src/hooks/ and its key in `.hardhooks.json`. */
  readonly name: string;
  readonly description: string;
  /** Events this Hook handles. */
  readonly events: readonly EventName[];
  /** Tool kinds it handles on tool Events (PreToolUse/PostToolUse). Omit to handle every tool. */
  readonly tools?: readonly ToolKind[];
  /**
   * `closed` for Guards: an error, timeout or bad input becomes a block with
   * the cause as reason. `open` for everything else: errors are swallowed and
   * the Hook contributes nothing (ADR-0004).
   */
  readonly failMode: "closed" | "open";
  /**
   * How long the dispatcher waits for `run` before giving up on this Hook. A
   * Guard that times out blocks; any other Hook is ignored. Defaults to
   * 30 s for Guards and no limit for other Hooks, which bound their own
   * external processes (formatters, check commands).
   */
  readonly timeoutMs?: number;
  /**
   * The options users may set under `hooks.<name>` in `.hardhooks.json`
   * (besides `enabled`), built with `src/config/schema`. Config files may set
   * any subset; the rest comes from `defaults`. It also generates the shipped
   * JSON Schema. Omit when the Hook takes no options: any option is then a
   * config error.
   */
  readonly optionsSchema?: ObjectSchema<Options>;
  /**
   * Enabled flag and a value for every option under each Preset. User and
   * repo config override these key by key (ADR-0002, #3).
   */
  readonly defaults: Readonly<Record<PresetName, HookSettings<Options>>>;
  /** Decide for one Event. Return undefined for "nothing to say". May be async. */
  run(event: HookEvent, options: Options, env: Environment): Decision | undefined | Promise<Decision | undefined>;
}

/** Identity helper that infers `Options` from `optionsSchema` and `defaults`, and checks they agree. */
export function defineHook<Options>(hook: Hook<Options>): Hook<Options> {
  return hook;
}
