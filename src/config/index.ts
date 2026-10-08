/**
 * Resolved configuration as the dispatcher consumes it. Loading and validating
 * `.hardhooks.json`, user config and Presets is #3; this is the minimal shape
 * that work will produce.
 */

export type PresetName = "standard" | "strict";

export interface HookSettings<Options = Record<string, unknown>> {
  enabled: boolean;
  options: Options;
}

export interface ResolvedConfig {
  preset: PresetName;
  /**
   * Per-Hook settings by Hook name. A Hook with no entry uses its own
   * `defaults[preset]`.
   */
  hooks: Readonly<Record<string, HookSettings<unknown> | undefined>>;
}

export function defaultConfig(): ResolvedConfig {
  return { preset: "standard", hooks: {} };
}
