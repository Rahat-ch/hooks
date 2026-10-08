import type { Environment } from "../environment";

/** What a CLI command gets. Commands never touch `process` directly. */
export interface CommandContext {
  /** Arguments after the command name. */
  readonly args: readonly string[];
  readonly env: Environment;
  readStdin(): Promise<string>;
  /** Whether stdin is a terminal, so a person (not a pipe) answers `confirm`. */
  readonly interactive: boolean;
  /** Ask the user a yes/no question (on stdout, answer from stdin); resolves true for yes. */
  confirm(question: string): Promise<boolean>;
  /** Absolute path of the running bundle (`dist/hardhooks.mjs`), which `init` points Host settings at. */
  readonly bundlePath: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** A CLI command; resolves to the process exit code. */
export type Command = (context: CommandContext) => Promise<number>;
