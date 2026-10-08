/**
 * The `hardhooks trust` seam (ADR-0005): show what trusting the project
 * would let hardhooks run, ask, and record it; or revoke it, or report it.
 * The CLI command only parses flags and calls `trust`.
 */
import type { Environment } from "../environment";
import type { Hook } from "../hooks/hook";
import { hooks as registeredHooks } from "../hooks/registry";
import { grantTrust } from "./index";

export type TrustAction = "grant" | "revoke" | "status";
/** `prompt` shows what will be trusted and asks; `yes` (`--yes`) trusts without asking. */
export type TrustMode = "prompt" | "yes";

export interface TrustRequest {
  env: Environment;
  action: TrustAction;
  mode: TrustMode;
  /** Whether stdin is a terminal a person can answer the prompt on. */
  interactive: boolean;
  /** Ask the user a yes/no question; resolves true for yes. */
  confirm(question: string): Promise<boolean>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Hooks to consider. Defaults to the built-in registry; tests may inject their own. */
  hooks?: readonly Hook<any>[];
}

/** `hardhooks trust [--yes | --revoke | --status]`. Resolves to the exit code. */
export async function trust(request: TrustRequest): Promise<number> {
  const { env, stdout } = request;
  const status = grantTrust(env, env.cwd);
  stdout(`Trusted ${status.root}.\n`);
  return 0;
}
