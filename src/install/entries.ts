/**
 * The Host settings entries hardhooks owns: what `init` wants for the enabled
 * Hooks, how to recognise ours among the user's, and how to merge or remove
 * them without touching anything else. Pure: no file I/O.
 *
 * Settings shape (Claude Code, read natively by Copilot CLI, Cursor, Devin CLI
 * and Continue): `hooks.<Event>` is a list of matcher groups, each
 * `{ matcher?, hooks: [handler, ...] }`. https://code.claude.com/docs/en/hooks
 */
import { hookSettings, type ResolvedConfig } from "../config";
import type { EventName, ToolKind } from "../event";
import type { Hook } from "../hooks/hook";
import { claudeCodeTools } from "../hosts/claude-code";

/** Every Event, in the order init adds them to a settings file. */
export const eventOrder: readonly EventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "PreCompact",
  "Stop",
  "SubagentStop",
  "SessionEnd",
];

/** Events whose matcher filters on the tool name. */
const toolEvents = new Set<EventName>(["PreToolUse", "PostToolUse"]);

/** File name of the bundle; the mark of a hardhooks-owned handler. */
export const bundleFileName = "hardhooks.mjs";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** One matcher group hardhooks wants under `hooks.<Event>`. */
export interface Entry {
  readonly event: EventName;
  /** Tool names joined with `|`; undefined to match every tool (or an Event without tools). */
  readonly matcher: string | undefined;
  /** The enabled Hooks this entry runs, for the summary. */
  readonly hooks: readonly string[];
}

/** The matcher covering every tool the given Hooks handle, or undefined if one of them handles every tool. */
function toolMatcher(hooks: readonly Hook<any>[]): string | undefined {
  const kinds = new Set<ToolKind>();
  for (const hook of hooks) {
    if (hook.tools === undefined || hook.tools.includes("other")) return undefined;
    for (const kind of hook.tools) kinds.add(kind);
  }
  const names = Object.entries(claudeCodeTools).flatMap(([kind, tools]) => (kinds.has(kind as ToolKind) ? tools : []));
  return names.join("|");
}

/** One entry per Event that at least one enabled Hook handles. */
export function wantedEntries(hooks: readonly Hook<any>[], config: ResolvedConfig): Entry[] {
  const enabled = hooks.filter((hook) => hookSettings(hook, config).enabled);
  return eventOrder.flatMap((event) => {
    const handling = enabled.filter((hook) => hook.events.includes(event));
    if (handling.length === 0) return [];
    return [
      {
        event,
        matcher: toolEvents.has(event) ? toolMatcher(handling) : undefined,
        hooks: handling.map((hook) => hook.name),
      },
    ];
  });
}

/**
 * The handler for one Event: `node <bundle> run <Event>` in exec form (`args`
 * set), so no shell parses the path and it works on every OS. Never `npx`.
 */
function handler(bundleRef: string, event: EventName): JsonObject {
  return { type: "command", command: "node", args: [bundleRef, "run", event] };
}

function group(entry: Entry, bundleRef: string): JsonObject {
  return {
    ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
    hooks: [handler(bundleRef, entry.event)],
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a handler is one hardhooks wrote: a command whose `args` are
 * `[<path ending in hardhooks.mjs>, "run", ...]`. Recognised by shape rather
 * than an extra marker key, so settings stay valid for every Host and a moved
 * bundle (new Node version, Windows path) is still ours.
 */
export function isHardhooksHandler(value: unknown): boolean {
  if (!isObject(value) || value.type !== "command" || !Array.isArray(value.args)) return false;
  const [script, verb] = value.args;
  return typeof script === "string" && script.split(/[\\/]/).pop() === bundleFileName && verb === "run";
}

/**
 * Settings with every hardhooks handler removed, and matcher groups, Event
 * lists and the `hooks` object removed if that left them empty. Everything
 * else is kept as is. Returns the same object when there was nothing to remove.
 */
export function withoutHardhooks(settings: JsonObject): JsonObject {
  return mergeEntries(settings, [], "");
}

/**
 * Settings with exactly `entries` as hardhooks' handlers: an existing
 * hardhooks group is replaced in place (so re-running init produces no diff),
 * new Events are appended, and hardhooks handlers for other Events removed.
 */
export function mergeEntries(settings: JsonObject, entries: readonly Entry[], bundleRef: string): JsonObject {
  const before = isObject(settings.hooks) ? settings.hooks : undefined;
  const hooks: JsonObject = { ...before };
  const wanted = new Map(entries.map((entry) => [entry.event, entry]));

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const entry = wanted.get(event as EventName);
    wanted.delete(event as EventName);
    let placed = entry === undefined;
    const next: Json[] = [];
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g.hooks) || !g.hooks.some(isHardhooksHandler)) {
        next.push(g);
        continue;
      }
      const others = g.hooks.filter((h) => !isHardhooksHandler(h));
      if (others.length > 0) next.push({ ...g, hooks: others });
      if (!placed) {
        next.push(group(entry!, bundleRef));
        placed = true;
      }
    }
    if (!placed) next.push(group(entry!, bundleRef));
    if (next.length > 0) hooks[event] = next;
    else delete hooks[event];
  }
  for (const entry of wanted.values()) hooks[entry.event] = [group(entry, bundleRef)];

  const result: JsonObject = { ...settings };
  if (Object.keys(hooks).length > 0 || (before !== undefined && Object.keys(before).length === 0)) {
    result.hooks = hooks;
  } else {
    delete result.hooks;
  }
  return result;
}
