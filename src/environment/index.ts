import { join } from "node:path";
import { nodeProcessRunner } from "./process-runner";

export { nodeProcessRunner } from "./process-runner";

export interface RunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  /** Kill the child after this many milliseconds; the result has `timedOut: true`. */
  timeoutMs?: number;
}

export interface ProcessResult {
  /** null when the process was killed or could not be started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError?: string;
}

/**
 * How Hooks run external programs (git, formatters, check commands, notifiers).
 * Injected so tests can record calls or run real tools in temp dirs.
 */
export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<ProcessResult>;
  /** Start a process that outlives the dispatcher (e.g. notify) without waiting for it. */
  spawnDetached(command: string, args: readonly string[], options?: RunOptions): void;
}

export interface Clock {
  now(): Date;
}

/**
 * Everything a Hook may learn about or do to the outside world. The
 * dispatcher passes it through; Hooks never read `process` directly.
 */
export interface Environment {
  /** Working directory of the dispatcher process. Prefer the Event's `cwd` for the project. */
  readonly cwd: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  /** Per-user directory for hardhooks state (audit logs, check fingerprints). May not exist yet. */
  readonly stateDir: string;
}

/** The platform's per-user state directory for hardhooks. */
export function defaultStateDir(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "hardhooks", "state");
  if (platform === "darwin") return join(home, "Library", "Application Support", "hardhooks", "state");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "hardhooks");
}

/** The real Environment of the current process. Used only by the CLI wrapper. */
export function nodeEnvironment(): Environment {
  const env = process.env;
  const home = env.HOME ?? env.USERPROFILE ?? process.cwd();
  return {
    cwd: process.cwd(),
    home,
    env,
    platform: process.platform,
    clock: { now: () => new Date() },
    processRunner: nodeProcessRunner,
    stateDir: defaultStateDir(process.platform, env, home),
  };
}
