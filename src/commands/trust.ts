import { trust, type TrustAction, type TrustMode } from "../trust/command";
import type { Command } from "./command";

const usage = "usage: hardhooks trust [--yes | --revoke | --status]\n";

/** `hardhooks trust [--yes | --revoke | --status]`: let hardhooks run this project's own commands (ADR-0005). */
export const trustCommand: Command = (context) => {
  let action: TrustAction = "grant";
  let mode: TrustMode = "prompt";
  for (const arg of context.args) {
    if (arg === "--yes" || arg === "-y") mode = "yes";
    else if (arg === "--revoke" && action === "grant") action = "revoke";
    else if (arg === "--status" && action === "grant") action = "status";
    else {
      context.stderr(`hardhooks trust: unexpected argument ${JSON.stringify(arg)}\n${usage}`);
      return Promise.resolve(1);
    }
  }
  return trust({ ...context, action, mode });
};
