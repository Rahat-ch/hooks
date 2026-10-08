/**
 * How every git query in hardhooks runs git: through the injected
 * ProcessRunner, with the Environment's variables, and with optional locks
 * off (`--no-optional-locks`), so a query never takes `index.lock` from
 * under the user's own git (`git status` would otherwise refresh and rewrite
 * the index). Read-only queries only.
 */
import type { Environment, ProcessResult } from "../environment";

/** What running git needs from the Environment. */
export type GitEnvironment = Pick<Environment, "processRunner" | "env">;

export interface GitRunOptions {
  /** Kill git after this long; the result has `timedOut: true`. Default: no limit. */
  readonly timeoutMs?: number | undefined;
  /** Written to git's stdin. */
  readonly input?: string | undefined;
}

/** Run `git <args>` in `cwd`. Rejects only if the ProcessRunner does. */
export function runGit(
  env: GitEnvironment,
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<ProcessResult> {
  return env.processRunner.run("git", ["--no-optional-locks", ...args], {
    cwd,
    env: env.env,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/** stdout of `git <args>` when it exits 0; undefined on any failure, timeout included. */
export async function gitOutput(
  env: GitEnvironment,
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<string | undefined> {
  try {
    const result = await runGit(env, cwd, args, options);
    return result.exitCode === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}
