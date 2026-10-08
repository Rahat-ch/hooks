/**
 * Fake programs for the real CLI to run: notifiers, formatters, check
 * commands, a git that hangs. Each records every call to a JSONL file and
 * answers with a chosen exit code, output and delay.
 *
 * How the product finds a program decides which fake works where:
 *
 * - Bare name, no shell (`git`, `notify-send`, `osascript`, `gofmt`,
 *   `rustfmt`, `ruff`/`black` from PATH, `powershell.exe`): POSIX only. The
 *   fake is a `#!/bin/sh` script on PATH. On Windows a spawn without a shell
 *   finds only `.exe` files, which we can't fake, so such tests use
 *   `it.skipIf(process.platform === "win32")` with a comment.
 * - Command lines run through the platform shell (check's `command`,
 *   autodetected `npm run …`): every OS. On Windows `cmd.exe` finds the
 *   `<name>.cmd` shim written beside the POSIX script.
 * - Node formatters (`prettier`, `biome`, `dprint`) run as
 *   `node <node_modules/<pkg>/<bin script>>`: every OS, via `fakeNodePackage`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

export interface FakeResponse {
  /** Default 0. */
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Wait this long (after recording the call) before answering and exiting. */
  delayMs?: number;
}

/** Answer with this instead (unset fields default: exit 0, no output) when the arguments, joined with spaces, match `match`. */
export interface FakeRule extends FakeResponse {
  match: RegExp;
}

export interface FakeBehaviour extends FakeResponse {
  /** Checked in order; the first match wins. Unmatched calls get the top-level response. */
  rules?: readonly FakeRule[];
}

/** One call the fake received. */
export interface FakeCall {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  /** `Date.now()` when the call started. */
  time: number;
}

export interface FakeProgram {
  /** The file the product runs (POSIX script, or the bin script of a fake Node package). */
  readonly path: string;
  /** Every call so far, in order. */
  calls(): FakeCall[];
  /** Poll until at least `count` calls arrived (e.g. from a detached notifier); rejects after `timeoutMs`. */
  waitForCalls(count?: number, timeoutMs?: number): Promise<FakeCall[]>;
}

const stub = fileURLToPath(new URL("./fake-program.cjs", import.meta.url));
let counter = 0;

/** Write the spec and record file for one fake under `stateDir`; returns the spec path and the FakeProgram. */
function prepare(stateDir: string, path: string, behaviour: FakeBehaviour): { spec: string; program: FakeProgram } {
  const dir = join(stateDir, `${++counter}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const record = join(dir, "calls.jsonl");
  appendFileSync(record, "");
  const { rules = [], ...response } = behaviour;
  const spec = join(dir, "spec.json");
  writeFileSync(
    spec,
    JSON.stringify({
      record,
      response,
      rules: rules.map(({ match, ...answer }) => ({ match: match.source, flags: match.flags.replace("g", ""), ...answer })),
    }),
  );
  const calls = () =>
    readFileSync(record, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as FakeCall);
  const program: FakeProgram = {
    path,
    calls,
    async waitForCalls(count = 1, timeoutMs = 10_000) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const seen = calls();
        if (seen.length >= count) return seen;
        if (performance.now() > deadline) throw new Error(`${path}: expected ${count} call(s), got ${seen.length}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
  return { spec, program };
}

const shQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * A fake program at exactly `path` (POSIX `#!/bin/sh` script; on Windows also
 * `<path>.cmd`, which only a shell finds). Use for programs the product looks
 * up in a fixed place, e.g. `.venv/bin/ruff`. `fakesDir` holds its records.
 */
export function writeFakeProgram(path: string, behaviour: FakeBehaviour, fakesDir: string): FakeProgram {
  const { node } = inject("hardhooksE2E");
  const { spec, program } = prepare(fakesDir, path, behaviour);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexec ${shQuote(node)} ${shQuote(stub)} ${shQuote(spec)} "$@"\n`, { mode: 0o755 });
  if (process.platform === "win32") writeFileSync(`${path}.cmd`, `@"${node}" "${stub}" "${spec}" %*\r\n`);
  return program;
}

/**
 * A fake Node package `pkg` in `dir/node_modules`, whose `bin` entry `bin`
 * is a fake program; the product runs it as `node <script>` on every OS
 * (prettier, @biomejs/biome, dprint).
 */
export function writeFakeNodePackage(dir: string, pkg: string, bin: string, behaviour: FakeBehaviour, fakesDir: string): FakeProgram {
  const pkgDir = join(dir, "node_modules", ...pkg.split("/"));
  const script = join(pkgDir, "fake-bin.cjs");
  const { spec, program } = prepare(fakesDir, script, behaviour);
  mkdirSync(pkgDir, { recursive: true });
  if (!existsSync(join(pkgDir, "package.json"))) {
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: "0.0.0-fake", bin: { [bin]: "fake-bin.cjs" } }));
  }
  writeFileSync(script, `process.argv.splice(2, 0, ${JSON.stringify(spec)});\nrequire(${JSON.stringify(stub)});\n`);
  return program;
}
