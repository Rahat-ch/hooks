import type { HookSettings, PresetName, ResolvedConfig } from "../config";
import type { ObjectSchema } from "../config/schema";
import type { Decision } from "../decision";
import type { HostResult } from "../dispatcher";
import type { Environment } from "../environment";
import type { EventName, HookEvent, ToolKind } from "../event";

/** What a Hook asks before running a command that comes from the project itself (ADR-0005). */
export interface ProjectTrust {
  /**
   * Whether the Hook may run `what`: a command it autodetected from the
   * project's files (a package.json script, a project formatter, ...),
   * described for the user, e.g. "`npm run lint` (detected from package.json)".
   * False until the user runs `hardhooks trust` in the project, or after the
   * files it covers change; the dispatcher then tells the user what was
   * skipped, once per session.
   */
  mayRun(what: string): boolean;
}

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
  /**
   * The subset of `events` it handles with these resolved options, when an
   * Event is opt-in (e.g. check's SubagentStop). Omit when it always handles
   * all of them. `init` installs, and the dispatcher runs the Hook for, only
   * these Events; see `activeEvents()`.
   */
  activeEvents?(options: Options): readonly EventName[];
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
   * Options whose values are commands hardhooks runs. Set in the repo's
   * `.hardhooks.json`, they apply only in a trusted project (`hardhooks
   * trust`, ADR-0005); elsewhere the dispatcher withholds them and tells the
   * user. The user config's values always apply.
   */
  readonly commandOptions?: readonly (keyof Options & string)[];
  /**
   * What this Hook would autodetect and run in the project at `cwd` with
   * these options, one line each, for `hardhooks trust` to show before the
   * user decides. Omit when the Hook autodetects nothing.
   */
  projectCommands?(cwd: string, options: Options): readonly string[];
  /**
   * Enabled flag and a value for every option under each Preset. User and
   * repo config override these key by key (ADR-0002, #3).
   */
  readonly defaults: Readonly<Record<PresetName, HookSettings<Options>>>;
  /**
   * Decide for one Event. Return undefined for "nothing to say". May be async.
   * Before running a command it autodetected from the project's files, a Hook
   * asks `trust.mayRun` (ADR-0005). `config` is the whole resolved config, for
   * a Hook that must honour another Hook's options (session-context checks
   * files against protect-secrets' patterns); read your own from `options`.
   */
  run(
    event: HookEvent,
    options: Options,
    env: Environment,
    trust: ProjectTrust,
    config: ResolvedConfig,
  ): Decision | undefined | Promise<Decision | undefined>;
  /**
   * Optional: called once every selected Hook has decided and the Host output
   * is final, with what happened (e.g. audit-log). It can't change the
   * Decision; errors are ignored. Runs only when the Hook itself was selected
   * for the Event.
   */
  observe?(record: DispatchRecord, options: Options, env: Environment): void | Promise<void>;
}

/** One selected Hook's part in handling an Event. */
export interface HookRun {
  readonly hook: string;
  /** What it contributed to the merge (for a failed Guard, its fail-closed block); undefined for nothing. */
  readonly decision: Decision | undefined;
  /** Why it failed or timed out, if it did. */
  readonly error?: string | undefined;
  /** How long its `run` took. */
  readonly durationMs: number;
}

/** Everything the dispatcher did for one Event, handed to `Hook.observe`. */
export interface DispatchRecord {
  readonly event: HookEvent;
  readonly config: ResolvedConfig;
  /** Every Hook selected for the Event, in registry order. */
  readonly runs: readonly HookRun[];
  /** What the Host sees. */
  readonly result: HostResult;
  /** From reading the payload to the final output. */
  readonly durationMs: number;
}

/** The Events a Hook handles with these options: its `activeEvents`, limited to `events`, else all of `events`. */
export function activeEvents<Options>(hook: Hook<Options>, options: Options): readonly EventName[] {
  if (hook.activeEvents === undefined) return hook.events;
  const active = hook.activeEvents(options);
  return hook.events.filter((event) => active.includes(event));
}

/** Identity helper that infers `Options` from `optionsSchema` and `defaults`, and checks they agree. */
export function defineHook<Options>(hook: Hook<Options>): Hook<Options> {
  return hook;
}
