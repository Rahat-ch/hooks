import { runTests } from "../testing";
import type { Command } from "./command";

const usage = "usage: hardhooks test [--cases <path>]\n";

/** `hardhooks test [--cases <path>]`: run the shipped fixtures and the user's cases against the resolved config. */
export const testCommand: Command = async ({ args, env, stdout, stderr }) => {
  let casesPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--cases" && args[i + 1] !== undefined) casesPath = args[++i];
    else if (arg.startsWith("--cases=") && arg.length > "--cases=".length) casesPath = arg.slice("--cases=".length);
    else {
      stderr(`hardhooks test: unexpected argument ${JSON.stringify(arg)}\n${usage}`);
      return 1;
    }
  }
  return runTests({ env, stdout, stderr, ...(casesPath !== undefined ? { casesPath } : {}) });
};
