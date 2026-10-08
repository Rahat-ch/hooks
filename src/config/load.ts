/**
 * Loading and validating config files through the injected Environment:
 * the repo's `.hardhooks.json` and the optional user-level config.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Environment } from "../environment";
import type { Hook } from "../hooks/hook";
import { presetNames, type HookOverrides, type PresetName, type ResolvedConfig } from "./index";
import * as s from "./schema";

export const repoConfigFileName = ".hardhooks.json";

/** Where editors fetch the JSON Schema from (`$schema`). The same file ships in the package. */
export const schemaUrl = "https://unpkg.com/hardhooks/hardhooks.schema.json";

/** One problem with a config file: which file, where in it (JSON path), and what is wrong. */
export interface ConfigError {
  readonly file: string;
  /** e.g. `hooks.git-guard.enabled`; undefined when the whole file is unreadable. */
  readonly path?: string | undefined;
  readonly message: string;
}

export type LoadedConfig =
  | { readonly ok: true; readonly config: ResolvedConfig }
  | { readonly ok: false; readonly errors: readonly ConfigError[] };

export function formatConfigError(error: ConfigError): string {
  return error.path === undefined
    ? `${error.file}: ${error.message}`
    : `${error.file}: ${error.path}: ${error.message}`;
}

/**
 * The user-level config file: `$XDG_CONFIG_HOME/hardhooks/config.json`
 * (default `~/.config/hardhooks/config.json`) on Linux and macOS, and
 * `%APPDATA%\hardhooks\config.json` on Windows. macOS uses `~/.config` rather
 * than `~/Library/Application Support` because it is a hand-edited dotfile.
 */
export function userConfigPath(env: Environment): string {
  if (env.platform === "win32") {
    return join(env.env.APPDATA || join(env.home, "AppData", "Roaming"), "hardhooks", "config.json");
  }
  return join(env.env.XDG_CONFIG_HOME || join(env.home, ".config"), "hardhooks", "config.json");
}

/**
 * The repo config: the nearest `.hardhooks.json` from `env.cwd` upwards,
 * stopping at the repository root (the first directory containing `.git`).
 */
export function findRepoConfig(env: Environment): string | undefined {
  let dir = resolve(env.cwd);
  for (;;) {
    const candidate = join(dir, repoConfigFileName);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** What a config file may contain, after validation. */
interface ConfigFile {
  $schema?: string;
  preset?: PresetName;
  hooks?: Record<string, ({ enabled?: boolean } & Record<string, unknown>) | undefined>;
}

/** The schema of a config file, built from every Hook's options schema. */
export function configFileSchema(hooks: readonly Hook<any>[]): s.ObjectSchema<ConfigFile> {
  const names = hooks.map((hook) => hook.name).sort();
  const hookEntries = Object.fromEntries(
    [...hooks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((hook) => {
        const options = hook.optionsSchema ? s.partial(hook.optionsSchema).properties : {};
        const entry = s.object(
          {
            enabled: s.optional(s.boolean({ description: "Run this Hook. The default comes from the Preset." })),
            ...options,
          },
          {
            description: hook.description,
            unknownKey: (key) => `unknown option ${JSON.stringify(key)} for Hook ${JSON.stringify(hook.name)}`,
          },
        );
        return [hook.name, s.optional(entry)];
      }),
  );
  return s.object(
    {
      $schema: s.optional(s.string({ description: "JSON Schema for editor autocomplete." })),
      preset: s.optional(
        s.oneOf(presetNames, {
          description: "`standard` (default): Guards, format-on-edit and session-context on. `strict`: every Hook on, Guards tightened.",
        }),
      ),
      hooks: s.optional(
        s.object(hookEntries, {
          description: "Per-Hook overrides: `enabled` plus that Hook's options. Anything left out comes from the Preset.",
          unknownKey: (key) => `unknown Hook ${JSON.stringify(key)} (known Hooks: ${names.join(", ")})`,
        }),
      ),
    },
    { description: "hardhooks configuration (.hardhooks.json or the user-level config.json)." },
  ) as unknown as s.ObjectSchema<ConfigFile>;
}

type FileResult = { file: string; config: ConfigFile } | { errors: ConfigError[] } | undefined;

function readConfigFile(file: string, schema: s.ObjectSchema<ConfigFile>): FileResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return { errors: [{ file, message: `could not read the file: ${(error as Error).message}` }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return { errors: [{ file, message: `invalid JSON: ${(error as Error).message}` }] };
  }
  const issues = schema.validate(value, []);
  if (issues.length > 0) {
    return { errors: issues.map((i) => ({ file, path: s.formatPath(i.path), message: i.message })) };
  }
  return { file, config: value as ConfigFile };
}

function overridesFrom(file: ConfigFile): Record<string, HookOverrides> {
  const result: Record<string, HookOverrides> = {};
  for (const [name, entry] of Object.entries(file.hooks ?? {})) {
    if (entry === undefined) continue;
    const { enabled, ...options } = entry;
    result[name] = { ...(enabled !== undefined ? { enabled } : {}), options };
  }
  return result;
}

/**
 * Load the user config and the repo config, validate both against the given
 * Hooks' schemas and merge them: repo values win over user values, which win
 * over the Preset defaults (applied later, per Hook, by `hookSettings`).
 */
export function loadConfig(env: Environment, hooks: readonly Hook<any>[]): LoadedConfig {
  const schema = configFileSchema(hooks);
  const repoFile = findRepoConfig(env);
  const files = [readConfigFile(userConfigPath(env), schema), repoFile && readConfigFile(repoFile, schema)];

  const errors = files.flatMap((f) => (f && "errors" in f ? f.errors : []));
  if (errors.length > 0) return { ok: false, errors };

  // Lowest precedence first.
  const layers = files.flatMap((f) => (f && "config" in f ? [f.config] : []));
  let preset: PresetName = "standard";
  const merged: Record<string, HookOverrides> = {};
  for (const layer of layers) {
    if (layer.preset !== undefined) preset = layer.preset;
    for (const [name, overrides] of Object.entries(overridesFrom(layer))) {
      const below = merged[name];
      const enabled = overrides.enabled ?? below?.enabled;
      merged[name] = {
        ...(enabled !== undefined ? { enabled } : {}),
        options: { ...below?.options, ...overrides.options },
      };
    }
  }
  return { ok: true, config: { preset, hooks: merged } };
}
