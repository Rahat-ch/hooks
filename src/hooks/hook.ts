import type { HookSettings, PresetName } from "../config";
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
  /** Enabled flag and options under each Preset. Config (#3) overrides these. */
  readonly defaults: Readonly<Record<PresetName, HookSettings<Options>>>;
  /** Decide for one Event. Return undefined for "nothing to say". May be async. */
  run(event: HookEvent, options: Options, env: Environment): Decision | undefined | Promise<Decision | undefined>;
}

/** Identity helper that infers `Options` from `defaults`. */
export function defineHook<Options>(hook: Hook<Options>): Hook<Options> {
  return hook;
}
