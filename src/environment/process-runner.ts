import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessResult, ProcessRunner, RunOptions } from "./index";

function childEnv(env: RunOptions["env"]): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

/** Runs real processes with node:child_process. No shell is involved. */
export const nodeProcessRunner: ProcessRunner = {
  run(command, args, options = {}) {
    return new Promise<ProcessResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, [...args], {
          cwd: options.cwd,
          env: childEnv(options.env),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        // Some failures throw instead of emitting "error", e.g. EINVAL for a .cmd/.bat on Windows.
        resolve({ exitCode: null, stdout, stderr, timedOut, spawnError: (error as Error).message });
        return;
      }
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
              // Don't wait for "close": a grandchild that inherited stdout/stderr (e.g. a native
              // binary behind an npm wrapper) would hold the pipes open past the kill.
              child.stdout.destroy();
              child.stderr.destroy();
              finish({ exitCode: null, stdout, stderr, timedOut });
            }, options.timeoutMs);

      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error) =>
        finish({ exitCode: null, stdout, stderr, timedOut, spawnError: error.message }),
      );
      child.on("close", (code) => finish({ exitCode: code, stdout, stderr, timedOut }));
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
    });
  },

  spawnDetached(command, args, options = {}) {
    try {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: childEnv(options.env),
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.on("error", () => {});
      child.unref();
    } catch {
      // Detached side effects are best-effort by definition.
    }
  },
};
