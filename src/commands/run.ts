import { dispatch } from "../dispatcher";
import type { Command } from "./command";

/** `hardhooks run <Event>`: the dispatcher, reading the Host payload from stdin. */
export const runCommand: Command = async ({ args, env, readStdin, stdout, stderr }) => {
  const event = args[0];
  if (event === undefined) {
    stderr("usage: hardhooks run <Event>\n");
    return 1;
  }
  const result = await dispatch({
    event,
    payload: await readStdin(),
    // No `config`: the dispatcher loads .hardhooks.json and the user config through `env`.
    env,
  });
  if (result.stdout) stdout(result.stdout);
  if (result.stderr) stderr(result.stderr);
  return result.exitCode;
};
