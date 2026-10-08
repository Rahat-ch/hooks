import type { ResolvedConfig } from "../../src/config";
import type { Environment } from "../../src/environment";
import type { HostResult } from "../../src/dispatcher";
import { dispatch } from "../../src/dispatcher";
import type { Hook } from "../../src/hooks/hook";
import type { ClaudeCodePayload } from "./payloads";
import { fakeEnvironment } from "./environment";

export interface RunEventOptions {
  /**
   * A ready-resolved config. Omit it to load config files through `env`
   * exactly as `hardhooks run` does (write them with `writeRepoConfig` /
   * `writeUserConfig`); a fresh environment has none, so `standard` applies.
   */
  config?: ResolvedConfig;
  env?: Environment;
  /** Replace the built-in registry, e.g. with test-only Hooks. */
  hooks?: readonly Hook<any>[];
  /** Event name passed as `hardhooks run <Event>`. Defaults to the payload's hook_event_name. */
  event?: string;
}

/**
 * Feed a Host payload through the dispatcher entry seam, exactly as
 * `hardhooks run <Event>` would, and return what the Host sees.
 * The payload's `cwd` is pointed at the environment's project dir unless the
 * payload sets one explicitly via a string payload.
 */
export async function runEvent(payload: ClaudeCodePayload | string, options: RunEventOptions = {}): Promise<HostResult> {
  const env = options.env ?? fakeEnvironment();
  const raw = typeof payload === "string" ? payload : JSON.stringify({ ...payload, cwd: env.cwd });
  const event = options.event ?? (typeof payload === "string" ? "PreToolUse" : payload.hook_event_name);
  return dispatch({
    event,
    payload: raw,
    env,
    ...(options.config ? { config: options.config } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
}
