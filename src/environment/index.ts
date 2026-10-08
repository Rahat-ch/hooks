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
  /**
   * Run `command` as a whole command line through the platform shell
   * (`/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows), as npm runs
   * scripts. For user-written command lines only; pass no `args`.
   */
  shell?: boolean;
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
 * The CLI runs real processes (`nodeProcessRunner`); `hardhooks test` swaps in
 * a sandbox that runs nothing (`src/testing/sandbox.ts`).
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

/**
 * The clock the CLI runs with: the real one, unless `HARDHOOKS_NOW` holds a
 * date (ISO 8601, e.g. `2026-01-01T09:00:00Z`), which then stands still.
 * A testing and debugging knob (ADR-0006), so tests of the real CLI get a
 * fixed "now" (the session-context date, notify's turn length, audit-log's
 * day). An unparseable value is ignored.
 */
export function processClock(env: Readonly<Record<string, string | undefined>>): Clock {
  const fixed = env.HARDHOOKS_NOW ? Date.parse(env.HARDHOOKS_NOW) : Number.NaN;
  if (Number.isNaN(fixed)) return { now: () => new Date() };
  return { now: () => new Date(fixed) };
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
    clock: processClock(env),
    processRunner: nodeProcessRunner,
    stateDir: defaultStateDir(process.platform, env, home),
  };
}
