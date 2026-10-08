import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Environment } from "../../src/environment";
import type { Hook } from "../../src/hooks/hook";
import { init, uninstall, type InstallMode, type InstallScope } from "../../src/install";
import { fakeEnvironment } from "./environment";

export interface InstallRunOptions {
  env?: Environment;
  /** `--user`: target the user-level settings file instead of the project's. */
  user?: boolean;
  /** `--dry-run`, `--yes`, or (default) show the diff and ask. */
  mode?: InstallMode;
  /** How the fake user answers the confirmation prompt. Default: yes. */
  answer?: boolean;
  /** Where the running hardhooks bundle lives. Default: a global-install-like path under the fake home. */
  bundlePath?: string;
  /** Replace the built-in registry, e.g. with test-only Hooks. */
  hooks?: readonly Hook<any>[];
}

export interface InstallRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Every confirmation question asked, in order. */
  prompts: string[];
  env: Environment;
}

/** Where `runInit` puts the bundle unless told otherwise. */
export function fakeBundlePath(env: Environment): string {
  return join(env.home, "global", "lib", "node_modules", "hardhooks", "dist", "hardhooks.mjs");
}

async function run(action: typeof init, options: InstallRunOptions): Promise<InstallRun> {
  const env = options.env ?? fakeEnvironment();
  let stdout = "";
  let stderr = "";
  const prompts: string[] = [];
  const scope: InstallScope = options.user ? "user" : "project";
  const exitCode = await action({
    env,
    scope,
    mode: options.mode ?? "prompt",
    bundlePath: options.bundlePath ?? fakeBundlePath(env),
    confirm: async (question) => {
      prompts.push(question);
      return options.answer ?? true;
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  return { stdout, stderr, exitCode, prompts, env };
}

/** `hardhooks init` at the install seam, against the Environment's temp project and home dirs. */
export function runInit(options: InstallRunOptions = {}): Promise<InstallRun> {
  return run(init, options);
}

/** `hardhooks uninstall` at the install seam. */
export function runUninstall(options: InstallRunOptions = {}): Promise<InstallRun> {
  return run(uninstall, options);
}

/** The project settings file init writes by default (the fake project has no `.git`, so it is under `env.cwd`). */
export function projectSettingsPath(env: Environment): string {
  return join(env.cwd, ".claude", "settings.json");
}

/** The user-level settings file `init --user` writes. */
export function userSettingsPath(env: Environment): string {
  return join(env.home, ".claude", "settings.json");
}

/** Parse a settings file; undefined when it doesn't exist. */
export function readSettings(path: string): any {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return JSON.parse(text);
}

/** Write a settings file (an object, or raw text to control formatting). */
export function writeSettings(path: string, settings: object | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2) + "\n");
}
