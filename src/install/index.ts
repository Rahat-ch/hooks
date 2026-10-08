/**
 * The install seam: `hardhooks init` and `hardhooks uninstall`. They read and
 * write Host settings files through the injected Environment (project dir,
 * home) and ask for confirmation through `confirm`, so tests run them against
 * temp dirs. The CLI commands only parse flags and call these.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatConfigError, loadConfig } from "../config/load";
import type { Environment } from "../environment";
import { isGitIgnored } from "../git";
import type { Hook } from "../hooks/hook";
import { hooks as registeredHooks } from "../hooks/registry";
import { pathUnder } from "../paths";
import { projectRoot } from "../project";
import { untrustedNote } from "../trust/command";
import { unifiedDiff } from "./diff";
import {
  hardhooksHandlers,
  isPortableBundleRef,
  mergeEntries,
  wantedEntries,
  withoutHardhooks,
  type Entry,
  type JsonObject,
} from "./entries";

export type InstallScope = "project" | "user";
/** `prompt` shows the diff and asks; `yes` writes without asking; `dry-run` only prints the diff. */
export type InstallMode = "prompt" | "yes" | "dry-run";

export interface InstallRequest {
  env: Environment;
  /**
   * `project`: the project's `.claude/settings.json`, or `.claude/settings.local.json`
   * for a bundle outside the project (see `init`). `user` (`--user`): the user-level one.
   */
  scope: InstallScope;
  mode: InstallMode;
  /** Absolute path of the running bundle (`dist/hardhooks.mjs`); the entries run it with `node`. */
  bundlePath: string;
  /** Ask the user a yes/no question; resolves true for yes. */
  confirm(question: string): Promise<boolean>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Hooks to consider. Defaults to the built-in registry; tests may inject their own. */
  hooks?: readonly Hook<any>[];
}



/**
 * The settings file for a scope. `user`: `$CLAUDE_CONFIG_DIR/settings.json`,
 * default `~/.claude/settings.json`. `project`: `.claude/settings.json` at
 * the project root.
 */
export function settingsPath(env: Environment, scope: InstallScope): string {
  if (scope === "user") return join(env.env.CLAUDE_CONFIG_DIR || join(env.home, ".claude"), "settings.json");
  return join(projectRoot(env.cwd), ".claude", "settings.json");
}

/**
 * The project's per-machine settings file, `.claude/settings.local.json`:
 * Claude Code applies it over `.claude/settings.json` and merges their hooks,
 * and Copilot CLI, Cursor, Devin CLI and Continue read it too. It isn't meant
 * to be committed (Claude Code git-ignores it when it creates it).
 */
export function localSettingsPath(env: Environment): string {
  return join(projectRoot(env.cwd), ".claude", "settings.local.json");
}

/**
 * How a settings entry refers to the bundle. In project scope, a bundle
 * installed inside the project (`npm i -D hardhooks`) is referred to as
 * `${CLAUDE_PROJECT_DIR}/...`, which works on every teammate's machine.
 * Anything else (a global install, or user settings) gets the absolute path
 * of the running bundle; re-run init after moving it (e.g. a new Node version
 * under nvm, whose global packages are per version).
 */
export function bundleReference(env: Environment, scope: InstallScope, bundlePath: string): string {
  if (scope !== "project") return bundlePath;
  const inProject = pathUnder(bundlePath, projectRoot(env.cwd), env.platform);
  return inProject === undefined ? bundlePath : "${CLAUDE_PROJECT_DIR}/" + inProject;
}

class SettingsError extends Error {}

interface SettingsFile {
  path: string;
  /** The file's text; "" when it doesn't exist. */
  text: string;
  exists: boolean;
  settings: JsonObject;
}

function readSettingsFile(path: string): SettingsFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: "", exists: false, settings: {} };
    throw new SettingsError(`could not read ${path}: ${(error as Error).message}`);
  }
  let settings: unknown;
  try {
    settings = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new SettingsError(`${path} is not valid JSON (${(error as Error).message}); fix it by hand first`);
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new SettingsError(`${path} is not a JSON object; fix it by hand first`);
  }
  // Rewriting a malformed `hooks` could lose the user's intent, so leave it to them.
  const { hooks } = settings as { hooks?: unknown };
  if (hooks !== undefined) {
    if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
      throw new SettingsError(`${path}: "hooks" is not an object; fix it by hand first`);
    }
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) {
        throw new SettingsError(`${path}: hooks.${event} is not a list of matcher groups; fix it by hand first`);
      }
    }
  }
  return { path, text, exists: true, settings: settings as JsonObject };
}

/** Serialize like the existing file: same indentation, trailing newline. */
function render(settings: JsonObject, file: SettingsFile): string {
  const indent = /^([ \t]+)\S/m.exec(file.text)?.[1] ?? "  ";
  return JSON.stringify(settings, null, indent) + "\n";
}

interface Change {
  /** The new settings for each file, in the order of the paths given to `apply`. */
  next: readonly JsonObject[];
  /** Printed before the diffs. */
  summary: readonly string[];
  /** Printed instead when there is nothing to change. */
  unchanged: string;
}

/**
 * Show the change to the settings files at `paths` (one diff each), then
 * write them unless this is a dry run or the user declines; one question
 * covers every file. `plan` returns a string instead to refuse with that
 * message, writing nothing. Resolves to the exit code.
 */
async function apply(
  request: InstallRequest,
  paths: readonly string[],
  plan: (settings: readonly JsonObject[]) => Change | string,
): Promise<number> {
  const { stdout } = request;
  let files: SettingsFile[];
  try {
    files = paths.map(readSettingsFile);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    request.stderr(`hardhooks: ${error.message}\n`);
    return 1;
  }
  const change = plan(files.map((file) => file.settings));
  if (typeof change === "string") {
    request.stderr(`hardhooks: ${change}\n`);
    return 1;
  }
  const writes = files.flatMap((file, i) => {
    const next = change.next[i]!;
    return JSON.stringify(next) === JSON.stringify(file.settings) ? [] : [{ file, text: render(next, file) }];
  });
  if (writes.length === 0) {
    stdout(`${change.unchanged}\n`);
    return 0;
  }
  for (const line of change.summary) stdout(`${line}\n`);
  for (const { file, text } of writes) {
    stdout(unifiedDiff(file.text, text, file.exists ? file.path : "/dev/null", file.path));
  }

  if (request.mode === "dry-run") {
    stdout("Dry run: nothing written.\n");
    return 0;
  }
  const targets = writes.map(({ file }) => file.path).join(" and ");
  if (request.mode === "prompt" && !(await request.confirm(`Write ${targets}?`))) {
    stdout("Nothing written.\n");
    return 1;
  }
  for (const { file, text } of writes) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, text);
    stdout(`Wrote ${file.path}\n`);
  }
  return 0;
}

function describeEntry(entry: Entry): string {
  const tools = entry.matcher === undefined ? "" : ` [${entry.matcher}]`;
  return `  ${entry.event}${tools}: ${entry.hooks.join(", ")}`;
}

/**
 * `hardhooks init`: write one entry per Event the enabled Hooks need. Resolves to the exit code.
 *
 * In project scope the entries go where they work for everyone who reads that
 * file (ADR-0004: a Guard that silently does nothing is the worst outcome).
 * A project-local install is referred to through `${CLAUDE_PROJECT_DIR}`, so
 * its entries go in the shared `.claude/settings.json`. Any other bundle is an
 * absolute path that only exists on this machine: committed, it would fail on
 * a teammate's machine with a non-blocking error, leaving their Guards off. So
 * those entries go in the per-machine `.claude/settings.local.json`. Either
 * way, hardhooks entries are removed from the other file so nothing runs twice.
 */
export async function init(request: InstallRequest): Promise<number> {
  const { env, stderr } = request;
  const hooks = request.hooks ?? registeredHooks;
  const loaded = loadConfig(env, hooks);
  if (!loaded.ok) {
    for (const error of loaded.errors) stderr(`hardhooks: invalid config: ${formatConfigError(error)}\n`);
    stderr("hardhooks: fix the config, then re-run init.\n");
    return 1;
  }
  const entries = wantedEntries(hooks, loaded.config);
  const bundle = bundleReference(env, request.scope, request.bundlePath);
  const summary =
    entries.length === 0
      ? ["No enabled Hooks need Host settings entries."]
      : ["hardhooks entries (Event [tools]: Hooks):", ...entries.map(describeEntry)];

  let code: number;
  if (request.scope === "user") {
    const path = settingsPath(env, "user");
    code = await apply(request, [path], ([settings]) => ({
      next: [mergeEntries(settings!, entries, bundle)],
      summary,
      unchanged: `${path} is already up to date.`,
    }));
  } else if (isPortableBundleRef(bundle)) {
    const [shared, local] = [settingsPath(env, "project"), localSettingsPath(env)];
    code = await apply(request, [shared, local], ([sharedSettings, localSettings]) => ({
      next: [mergeEntries(sharedSettings!, entries, bundle), withoutHardhooks(localSettings!)],
      summary,
      unchanged: `${shared} is already up to date.`,
    }));
  } else {
    code = await initLocal(request, entries, bundle, summary);
  }
  for (const line of untrustedNote(env, hooks, loaded.config)) request.stdout(`${line}\n`);
  return code;
}

/** Project-scope init for a bundle outside the project: entries in `.claude/settings.local.json`. */
async function initLocal(request: InstallRequest, entries: readonly Entry[], bundle: string, summary: readonly string[]) {
  const { env } = request;
  const [shared, local] = [settingsPath(env, "project"), localSettingsPath(env)];
  let refused = false;
  const code = await apply(request, [shared, local], ([sharedSettings, localSettings]) => {
    // Machine-specific entries an older init (or a teammate) left in the shared file move here.
    const sharedNext = withoutHardhooks(sharedSettings!, (script) => !isPortableBundleRef(script));
    const team = hardhooksHandlers(sharedNext)[0];
    if (team !== undefined) {
      refused = true;
      return (
        `${shared} already runs hardhooks from the project (${team.script}) for the whole team, ` +
        `and adding this machine's copy (${bundle}) would run every Hook twice. ` +
        "Update the shared entries with the project's own copy instead: `npm install`, then `npx hardhooks init`."
      );
    }
    return {
      next: [sharedNext, mergeEntries(localSettings!, entries, bundle)],
      summary: [
        ...summary,
        ...(entries.length === 0
          ? []
          : [
              `hardhooks isn't installed in this project, so these entries run ${bundle}, which only exists on this machine. ` +
                `They go in ${local} (just you, in this project) rather than the shared .claude/settings.json, ` +
                "where they would fail on teammates' machines and leave their Guards off. " +
                "To give the whole team the Guards, run `npm i -D hardhooks`, then `npx hardhooks init`.",
            ]),
      ],
      unchanged: `${local} is already up to date.`,
    };
  });
  if (!refused && entries.length > 0) {
    const ignored = await isGitIgnored(env, projectRoot(env.cwd), local);
    if (ignored === false) {
      request.stdout(
        `Warning: git doesn't ignore ${local}. Add \`.claude/settings.local.json\` to .gitignore so this machine's path isn't committed.\n`,
      );
    }
  }
  return code;
}

/** `hardhooks uninstall`: remove every entry hardhooks wrote, and nothing else. */
export async function uninstall(request: InstallRequest): Promise<number> {
  const { env } = request;
  // In project scope, from the shared and the per-machine file alike: init may have used either.
  const paths =
    request.scope === "user" ? [settingsPath(env, "user")] : [settingsPath(env, "project"), localSettingsPath(env)];
  return apply(request, paths, (settings) => ({
    next: settings.map((s) => withoutHardhooks(s)),
    summary: [],
    unchanged: `No hardhooks entries in ${paths.join(" or ")}.`,
  }));
}
