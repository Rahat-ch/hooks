import { init, uninstall, type InstallMode, type InstallScope } from "../install";
import type { Command, CommandContext } from "./command";

/** Run init or uninstall with `[--user] [--dry-run] [--yes]` parsed from the arguments. */
async function install(action: typeof init, name: string, context: CommandContext): Promise<number> {
  let scope: InstallScope = "project";
  let mode: InstallMode = "prompt";
  for (const arg of context.args) {
    if (arg === "--user") scope = "user";
    else if (arg === "--dry-run") mode = "dry-run";
    else if ((arg === "--yes" || arg === "-y") && mode !== "dry-run") mode = "yes";
    else {
      context.stderr(`hardhooks ${name}: unknown argument ${JSON.stringify(arg)}\nusage: hardhooks ${name} [--user] [--dry-run] [--yes]\n`);
      return 1;
    }
  }
  return action({ ...context, scope, mode });
}

/** `hardhooks init [--user] [--dry-run] [--yes]`: write Host settings entries for the enabled Hooks. */
export const initCommand: Command = (context) => install(init, "init", context);

/** `hardhooks uninstall [--user] [--dry-run] [--yes]`: remove the entries init wrote. */
export const uninstallCommand: Command = (context) => install(uninstall, "uninstall", context);
