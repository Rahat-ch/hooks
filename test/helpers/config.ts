import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Environment } from "../../src/environment";

/** Write `.hardhooks.json` (an object, or raw text for malformed files) into the environment's project dir. */
export function writeRepoConfig(env: Environment, config: object | string, dir: string = env.cwd): string {
  return writeJson(join(dir, ".hardhooks.json"), config);
}

/**
 * Write the user-level config where the given Environment's platform keeps it:
 * `$XDG_CONFIG_HOME` or `~/.config` on Linux and macOS, `%APPDATA%` on Windows.
 */
export function writeUserConfig(env: Environment, config: object | string): string {
  const base =
    env.platform === "win32"
      ? (env.env.APPDATA ?? join(env.home, "AppData", "Roaming"))
      : env.env.XDG_CONFIG_HOME || join(env.home, ".config");
  return writeJson(join(base, "hardhooks", "config.json"), config);
}

function writeJson(path: string, content: object | string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}
