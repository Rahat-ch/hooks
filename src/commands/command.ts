import type { Environment } from "../environment";

/** What a CLI command gets. Commands never touch `process` directly. */
export interface CommandContext {
  /** Arguments after the command name. */
  readonly args: readonly string[];
  readonly env: Environment;
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** A CLI command; resolves to the process exit code. */
export type Command = (context: CommandContext) => Promise<number>;
