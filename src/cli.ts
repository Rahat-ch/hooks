// Must stay the first import: it exits with a clear message on Node <20.
import "./node-version";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Command } from "./commands/command";
import { initCommand, uninstallCommand } from "./commands/init";
import { runCommand } from "./commands/run";
import { nodeEnvironment } from "./environment";

/** CLI commands. One entry per line, sorted, so parallel additions merge cleanly. */
const commands: Readonly<Record<string, Command>> = {
  init: initCommand,
  run: runCommand,
  uninstall: uninstallCommand,
};

const usage = `usage: hardhooks <command>

commands:
  init [--user] [--dry-run] [--yes]   write Host settings entries for the enabled Hooks
  run <Event>                         run the Hooks for one Event (reads the Host payload on stdin)
  uninstall [--user] [--dry-run] [--yes]
                                      remove the entries init wrote
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Ask on stdout and read one line from stdin; anything but y/yes, or no answer at all, is no. */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`${question} [y/N] `);
    const lines = createInterface({ input: process.stdin });
    let answered = false;
    lines.once("line", (line) => {
      answered = true;
      lines.close();
      // A piped answer isn't echoed; end the prompt line ourselves.
      if (!process.stdin.isTTY) process.stdout.write("\n");
      resolve(/^y(es)?$/i.test(line.trim()));
    });
    lines.once("close", () => {
      if (answered) return;
      process.stdout.write("\n");
      resolve(false);
    });
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;
  const command = name === undefined ? undefined : commands[name];
  if (command === undefined) {
    process.stderr.write(usage);
    return name === "--help" || name === "-h" ? 0 : 1;
  }
  return command({
    args,
    env: nodeEnvironment(),
    readStdin,
    confirm,
    // This file is the bundle (dist/hardhooks.mjs); Node resolves npm's bin symlink to it.
    bundlePath: fileURLToPath(import.meta.url),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // The dispatcher isolates Hooks, so this is a bug in hardhooks itself.
    process.stderr.write(`hardhooks: internal error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
