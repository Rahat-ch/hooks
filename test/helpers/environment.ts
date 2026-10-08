import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import type { Environment, ProcessResult, ProcessRunner, RunOptions } from "../../src/environment";
import { nodeProcessRunner } from "../../src/environment";

export interface RecordedRun {
  command: string;
  args: readonly string[];
  options: RunOptions;
}

export interface RecordedSpawn {
  command: string;
  args: readonly string[];
  options: RunOptions;
}

/**
 * A ProcessRunner that records every call and answers from `respond`
 * (default: exit 0, no output). Use for OS notifications, webhooks and
 * anything else too slow or side-effectful to run for real.
 */
export interface RecordingProcessRunner extends ProcessRunner {
  readonly runs: RecordedRun[];
  readonly spawns: RecordedSpawn[];
}

export function recordingProcessRunner(
  respond: (command: string, args: readonly string[], options: RunOptions) => Partial<ProcessResult> = () => ({}),
): RecordingProcessRunner {
  const runs: RecordedRun[] = [];
  const spawns: RecordedSpawn[] = [];
  return {
    runs,
    spawns,
    async run(command, args, options = {}) {
      runs.push({ command, args, options });
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...respond(command, args, options) };
    },
    spawnDetached(command, args, options = {}) {
      spawns.push({ command, args, options });
    },
  };
}

export interface FakeEnvironmentOptions {
  /** ISO timestamp or Date for the injected clock. Default 2026-01-01T09:00:00Z. */
  now?: string | Date;
  /** "recording" (default) or "real" (spawns real processes, e.g. git in a temp repo), or your own runner. */
  processRunner?: "recording" | "real" | ProcessRunner;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

export interface FakeEnvironment extends Environment {
  /** The recording runner, when `processRunner` was "recording" (the default). */
  readonly recorder: RecordingProcessRunner | undefined;
}

/**
 * An Environment backed by fresh temp directories (cwd = a project dir, home,
 * stateDir), an injected clock and a recording process runner. Directories are
 * removed when the current test finishes.
 */
export function fakeEnvironment(options: FakeEnvironmentOptions = {}): FakeEnvironment {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hardhooks-test-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const stateDir = join(root, "state");
  for (const dir of [cwd, home, stateDir]) mkdirSync(dir, { recursive: true });

  const now = new Date(options.now ?? "2026-01-01T09:00:00Z");
  const recorder =
    options.processRunner === undefined || options.processRunner === "recording" ? recordingProcessRunner() : undefined;
  const processRunner =
    recorder ?? (options.processRunner === "real" ? nodeProcessRunner : (options.processRunner as ProcessRunner));

  return {
    cwd,
    home,
    stateDir,
    env: { HOME: home, ...options.env },
    platform: options.platform ?? process.platform,
    clock: { now: () => new Date(now) },
    processRunner,
    recorder,
  };
}
