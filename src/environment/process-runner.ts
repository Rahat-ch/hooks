import { spawn } from "node:child_process";
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

      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: childEnv(options.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
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
