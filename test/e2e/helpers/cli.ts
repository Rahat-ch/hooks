import { spawn } from "node:child_process";
import { inject } from "vitest";

/** What the Host sees from one run of the CLI. Structurally a `HostResult`, so the `expect*` helpers take it. */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Wall time of the child process, spawn to exit. */
  durationMs: number;
}

export type Env = Record<string, string | undefined>;

export interface CliOptions {
  /** Written to stdin, which is then closed. Default: empty. */
  stdin?: string;
  /** The child's working directory (the Host runs hooks in the project). */
  cwd: string;
  /**
   * The child's whole environment. Nothing is inherited from the test
   * process; undefined values are left out. `Sandbox.run` builds a hermetic one.
   */
  env: Env;
  /** Kill the child and fail after this long. Default 20 s. */
  timeoutMs?: number;
}

/** The bundle under test, built once per run by the e2e globalSetup. */
export function bundlePath(): string {
  return inject("hardhooksE2E").bundle;
}

/**
 * Run `node dist/hardhooks.mjs <args>` exactly as a Host does: no shell,
 * stdin piped and closed, the given cwd and env. Resolves when the process
 * exits; rejects if it can't start or outlives `timeoutMs`.
 */
export function hardhooks(args: readonly string[], options: CliOptions): Promise<CliResult> {
  const { node, bundle } = inject("hardhooksE2E");
  const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(node, [bundle, ...args], { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hardhooks ${args.join(" ")} did not exit within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = performance.now() - started;
      if (code === null) reject(new Error(`hardhooks ${args.join(" ")} was killed by ${signal}\nstderr: ${stderr}`));
      else resolve({ stdout, stderr, exitCode: code, durationMs });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });
}
