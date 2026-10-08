import type { Environment } from "../../src/environment";
import type { Hook } from "../../src/hooks/hook";
import { trust, type TrustAction, type TrustMode } from "../../src/trust/command";
import { fakeEnvironment } from "./environment";

export interface TrustRunOptions {
  env?: Environment;
  /** `--revoke`, `--status`, or (default) grant. */
  action?: TrustAction;
  /** `--yes`, or (default) show what will be trusted and ask. */
  mode?: TrustMode;
  /** How the fake user answers the confirmation prompt. Default: yes. */
  answer?: boolean;
  /** Whether stdin is a terminal. Default: true. */
  interactive?: boolean;
  hooks?: readonly Hook<any>[];
}

export interface TrustRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  prompts: string[];
  env: Environment;
}

/** Run `hardhooks trust` through its seam, as the CLI would, against a fake environment. */
export async function runTrust(options: TrustRunOptions = {}): Promise<TrustRun> {
  const env = options.env ?? fakeEnvironment();
  let stdout = "";
  let stderr = "";
  const prompts: string[] = [];
  const exitCode = await trust({
    env,
    action: options.action ?? "grant",
    mode: options.mode ?? "prompt",
    interactive: options.interactive ?? true,
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
