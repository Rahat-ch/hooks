/**
 * Is the config actually installed? Compares the entries `init` would write
 * for the resolved config (`wantedEntries`) with the hardhooks entries in the
 * Host settings files Claude Code merges: the user's, the project's and the
 * project's `.claude/settings.local.json`. Returns one warning per problem.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../config";
import type { Environment } from "../environment";
import type { EventName } from "../event";
import type { Hook } from "../hooks/hook";
import { localSettingsPath, projectRoot, settingsPath } from "../install";
import { isHardhooksHandler, isPortableBundleRef, wantedEntries } from "../install/entries";
import { toolKind } from "../hosts/claude-code";

/** The plugin's name in `enabledPlugins` keys (`<plugin>@<marketplace>`), from `.claude-plugin/plugin.json`. */
const pluginName = "hardhooks";

interface Installed {
  /** The installed matchers per Event (undefined: matches every tool). */
  readonly matchers: Map<string, (string | undefined)[]>;
  /** Bundle paths the entries run, per settings file and Event. */
  readonly bundles: { file: string; event: string; script: string }[];
  pluginEnabled: boolean;
  readonly warnings: string[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function readSettings(path: string, warnings: string[]): Json | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`could not read ${path}: ${(error as Error).message}`);
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text.replace(/^﻿/, ""));
    if (isObject(value)) return value;
    warnings.push(`could not read ${path}: not a JSON object`);
  } catch (error) {
    warnings.push(`could not read ${path}: ${(error as Error).message}`);
  }
  return undefined;
}

/** Read every settings file, lowest precedence first (later files override `enabledPlugins`). */
function readInstalled(files: readonly string[]): Installed {
  const installed: Installed = { matchers: new Map(), bundles: [], pluginEnabled: false, warnings: [] };
  for (const file of files) {
    const settings = readSettings(file, installed.warnings);
    if (settings === undefined) continue;
    if (isObject(settings.enabledPlugins)) {
      for (const [key, value] of Object.entries(settings.enabledPlugins)) {
        if (key.split("@")[0] === pluginName) installed.pluginEnabled = value === true;
      }
    }
    if (!isObject(settings.hooks)) continue;
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) continue;
        const ours = group.hooks.filter(isHardhooksHandler) as { args: unknown[] }[];
        if (ours.length === 0) continue;
        const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
        installed.matchers.set(event, [...(installed.matchers.get(event) ?? []), matcher]);
        for (const handler of ours) installed.bundles.push({ file, event, script: handler.args[0] as string });
      }
    }
  }
  return installed;
}

/** Whether a Claude Code matcher (exact names, `A|B`, a regex, or empty/`*` for all) matches a tool name. */
function matches(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return true; // Not ours to judge.
  }
}

/** The bundle path an entry runs, or undefined when it depends on a variable we can't resolve. */
function bundleFile(script: string, root: string): string | undefined {
  const path = script.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/g, root);
  return path.includes("$") ? undefined : resolve(root, path);
}

const isAre = (names: readonly string[]) => `${names.join(", ")} ${names.length === 1 ? "is" : "are"}`;

export function installWarnings(env: Environment, hooks: readonly Hook<any>[], config: ResolvedConfig): string[] {
  const root = projectRoot(env);
  const shared = settingsPath(env, "project");
  const files = [settingsPath(env, "user"), shared, localSettingsPath(env)];
  const installed = readInstalled(files);
  const warnings = [...installed.warnings];

  // A committed absolute path fails on teammates' machines with a non-blocking error: their Guards silently do nothing.
  const machineSpecific = installed.bundles.filter((b) => b.file === shared && !isPortableBundleRef(b.script));
  for (const script of new Set(machineSpecific.map((b) => b.script))) {
    const events = machineSpecific.filter((b) => b.script === script).map((b) => b.event);
    warnings.push(
      `${shared}: the hardhooks entries (${events.join(", ")}) run ${script}, a path on this machine only. Committed, they fail on teammates' machines and their Guards do nothing: re-run \`hardhooks init\` to move them to .claude/settings.local.json, or \`npm i -D hardhooks\` and \`npx hardhooks init\` to share them`,
    );
  }

  const seen = new Set<string>();
  for (const { file, script } of installed.bundles) {
    const path = bundleFile(script, root);
    if (path === undefined || seen.has(`${file}\0${path}`) || existsSync(path)) continue;
    seen.add(`${file}\0${path}`);
    const events = installed.bundles.filter((b) => b.file === file && bundleFile(b.script, root) === path).map((b) => b.event);
    warnings.push(
      `${file}: the hardhooks entries (${events.join(", ")}) run ${path}, which doesn't exist (moved, or installed under another Node version?): re-run \`hardhooks init\``,
    );
  }

  // The plugin's static hooks file runs the dispatcher for every Event and tool.
  if (installed.pluginEnabled) return warnings;
  const wanted = wantedEntries(hooks, config);
  if (wanted.length === 0) return warnings;
  if (installed.matchers.size === 0) {
    warnings.push(
      `hardhooks isn't installed in any Host settings (${files.join(", ")}), and the Claude Code plugin isn't enabled: run \`hardhooks init\``,
    );
    return warnings;
  }
  for (const entry of wanted) {
    const matchers = installed.matchers.get(entry.event as EventName);
    if (matchers === undefined) {
      warnings.push(
        `${isAre(entry.hooks)} enabled, but no hardhooks entry for ${entry.event} is installed in ${files.join(", ")}: run \`hardhooks init\` (with --user if you installed there)`,
      );
      continue;
    }
    const tools = entry.matcher === undefined ? [] : entry.matcher.split("|");
    const missing = tools.filter((tool) => !matchers.some((m) => matches(m, tool)));
    if (entry.matcher === undefined && !matchers.some((m) => matches(m, "AnyTool"))) missing.push("every tool");
    if (missing.length > 0) {
      const needing = hooks
        .filter((hook) => entry.hooks.includes(hook.name))
        .filter((hook) => hook.tools === undefined || missing.some((tool) => hook.tools!.includes(toolKind(tool))))
        .map((hook) => hook.name);
      warnings.push(
        `the ${entry.event} entry doesn't match ${missing.join(", ")} (needed by ${needing.join(", ")}): re-run \`hardhooks init\``,
      );
    }
  }
  return warnings;
}
