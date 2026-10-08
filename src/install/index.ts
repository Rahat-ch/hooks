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
import type { Hook } from "../hooks/hook";
import { hooks as registeredHooks } from "../hooks/registry";
import { projectRoot as projectRootOf } from "../trust";
import { untrustedNote } from "../trust/command";
import { unifiedDiff } from "./diff";
import { mergeEntries, wantedEntries, withoutHardhooks, type Entry, type JsonObject } from "./entries";

export type InstallScope = "project" | "user";
/** `prompt` shows the diff and asks; `yes` writes without asking; `dry-run` only prints the diff. */
export type InstallMode = "prompt" | "yes" | "dry-run";

export interface InstallRequest {
  env: Environment;
  /** `project`: `.claude/settings.json` in the project. `user` (`--user`): the user-level one. */
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



/** The project directory: the repository root above `env.cwd` (`.git` dir or file), else `env.cwd`. */
export function projectRoot(env: Environment): string {
  return projectRootOf(env.cwd);
}

/**
 * The settings file for a scope. `user`: `$CLAUDE_CONFIG_DIR/settings.json`,
 * default `~/.claude/settings.json`. `project`: `.claude/settings.json` at
 * the project root.
 */
export function settingsPath(env: Environment, scope: InstallScope): string {
  if (scope === "user") return join(env.env.CLAUDE_CONFIG_DIR || join(env.home, ".claude"), "settings.json");
  return join(projectRoot(env), ".claude", "settings.json");
}

/**
 * How a settings entry refers to the bundle. Project settings get committed,
 * so a bundle installed inside the project (`npm i -D hardhooks`) is referred
 * to as `${CLAUDE_PROJECT_DIR}/...`, which works on every teammate's machine.
 * Anything else (a global install, or user settings) gets the absolute path
 * of the running bundle; re-run init after moving it (e.g. a new Node version
 * under nvm, whose global packages are per version).
 */
export function bundleReference(env: Environment, scope: InstallScope, bundlePath: string): string {
  if (scope !== "project") return bundlePath;
  const slashes = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
  const fold = (path: string) => (env.platform === "win32" ? path.toLowerCase() : path);
  const root = slashes(projectRoot(env)) + "/";
  const bundle = slashes(bundlePath);
  if (!fold(bundle).startsWith(fold(root))) return bundlePath;
  return "${CLAUDE_PROJECT_DIR}/" + bundle.slice(root.length);
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
  next: JsonObject;
  /** Printed before the diff. */
  summary: readonly string[];
  /** Printed instead when there is nothing to change. */
  unchanged: string;
}

/**
 * Show the change to the settings file at `path`, then write it unless this
 * is a dry run or the user declines. Resolves to the exit code.
 */
async function apply(request: InstallRequest, path: string, change: (settings: JsonObject) => Change): Promise<number> {
  const { stdout } = request;
  let file: SettingsFile;
  try {
    file = readSettingsFile(path);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    request.stderr(`hardhooks: ${error.message}\n`);
    return 1;
  }
  const { next, summary, unchanged } = change(file.settings);
  if (JSON.stringify(next) === JSON.stringify(file.settings)) {
    stdout(`${unchanged}\n`);
    return 0;
  }
  const text = render(next, file);
  for (const line of summary) stdout(`${line}\n`);
  stdout(unifiedDiff(file.text, text, file.exists ? file.path : "/dev/null", file.path));

  if (request.mode === "dry-run") {
    stdout("Dry run: nothing written.\n");
    return 0;
  }
  if (request.mode === "prompt" && !(await request.confirm(`Write ${file.path}?`))) {
    stdout("Nothing written.\n");
    return 1;
  }
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, text);
  stdout(`Wrote ${file.path}\n`);
  return 0;
}

function describeEntry(entry: Entry): string {
  const tools = entry.matcher === undefined ? "" : ` [${entry.matcher}]`;
  return `  ${entry.event}${tools}: ${entry.hooks.join(", ")}`;
}

/** `hardhooks init`: write one entry per Event the enabled Hooks need. Resolves to the exit code. */
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
  const path = settingsPath(env, request.scope);
  const bundle = bundleReference(env, request.scope, request.bundlePath);
  const summary =
    entries.length === 0
      ? ["No enabled Hooks need Host settings entries."]
      : ["hardhooks entries (Event [tools]: Hooks):", ...entries.map(describeEntry)];
  if (entries.length > 0 && request.scope === "project" && bundle === request.bundlePath) {
    summary.push(
      `Note: ${bundle} is specific to this machine. To commit this file for a team, install hardhooks as a devDependency and re-run init.`,
    );
  }
  const code = await apply(request, path, (settings) => ({
    next: mergeEntries(settings, entries, bundle),
    summary,
    unchanged: `${path} is already up to date.`,
  }));
  for (const line of untrustedNote(env, hooks, loaded.config)) request.stdout(`${line}\n`);
  return code;
}

/** `hardhooks uninstall`: remove every entry hardhooks wrote, and nothing else. */
export async function uninstall(request: InstallRequest): Promise<number> {
  const path = settingsPath(request.env, request.scope);
  return apply(request, path, (settings) => ({
    next: withoutHardhooks(settings),
    summary: [],
    unchanged: `No hardhooks entries in ${path}.`,
  }));
}
