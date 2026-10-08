// Must stay the first import: it exits with a clear message on Node <20.
import "./node-version";
import type { Command } from "./commands/command";
import { runCommand } from "./commands/run";
import { nodeEnvironment } from "./environment";

/** CLI commands. One entry per line, sorted, so parallel additions merge cleanly. */
const commands: Readonly<Record<string, Command>> = {
  run: runCommand,
};

const usage = `usage: hardhooks <command>

commands:
  run <Event>   run the Hooks for one Event (reads the Host payload on stdin)
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
