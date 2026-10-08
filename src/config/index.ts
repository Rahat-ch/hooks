/**
 * Resolved configuration as the dispatcher consumes it, and how a Hook's
 * settings are resolved from it. Loading `.hardhooks.json` and the user config
 * lives in `./load`; the schema DSL Hooks declare options with in `./schema`.
 *
 * Resolution order: built-in defaults, then Preset, then user config, then
 * repo config (repo wins). A Hook's `defaults[preset]` supplies the first two;
 * `ResolvedConfig.hooks` holds the user and repo overrides already merged.
 */
import type { Hook } from "../hooks/hook";

export const presetNames = ["standard", "strict"] as const;
export type PresetName = (typeof presetNames)[number];

export interface HookSettings<Options = Record<string, unknown>> {
  enabled: boolean;
  options: Options;
}

/** One Hook's overrides from config files. Anything left out comes from the Hook's Preset defaults. */
export interface HookOverrides {
  enabled?: boolean;
  /** Replace these options key by key; arrays and nested objects are replaced whole, not merged. */
  options?: Readonly<Record<string, unknown>>;
}

export interface ResolvedConfig {
  preset: PresetName;
  /** Per-Hook overrides by Hook name. A Hook with no entry uses its own `defaults[preset]`. */
  hooks: Readonly<Record<string, HookOverrides | undefined>>;
}

/** No config files: the `standard` Preset with no overrides. */
export function defaultConfig(): ResolvedConfig {
  return { preset: "standard", hooks: {} };
}

/** A Hook's effective settings: its Preset defaults with config overrides on top. */
export function hookSettings<Options>(hook: Hook<Options>, config: ResolvedConfig): HookSettings<Options> {
  const defaults = hook.defaults[config.preset];
  const overrides = config.hooks[hook.name];
  return {
    enabled: overrides?.enabled ?? defaults.enabled,
    options: { ...defaults.options, ...overrides?.options } as Options,
  };
}
