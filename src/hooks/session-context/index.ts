/**
 * session-context (fails open): at SessionStart, every source including
 * compact, tells the Host where it is: today's date and, in a git repo, the
 * branch, ahead/behind, dirty files and recent commits, then any configured
 * extra files and command output. The whole context is hard-capped at `budgetBytes`, because it
 * stays in the conversation and is re-added after every compaction.
 */
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import * as s from "../../config/schema";
import { addContext } from "../../decision";
import type { ProcessResult, ProcessRunner } from "../../environment";
import { gitStatus, recentCommitSubjects, type GitStatus } from "../../git";
import { defineHook } from "../hook";

/** Hard cap on the added context, in UTF-8 bytes. */
const budgetBytes = 1024;
const commitCount = 5;
/**
 * Per-part caps keep the git summary under about 850 bytes even in a busy
 * repo, so configured extras always get some of the budget.
 */
const maxDirtyLineBytes = 300;
const maxPathBytes = 80;
const maxSubjectBytes = 72;
/** An extra is left out when less than this much budget remains for it. */
const minExtraBytes = 16;
/** SessionStart delays Claude's first response, so extra commands get little time. */
const commandTimeoutMs = 3000;

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The local calendar date, e.g. `2026-03-14 (Saturday)`. */
function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} (${weekdays[date.getDay()]})`;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** `text` cut to at most `maxBytes` UTF-8 bytes on a character boundary, ending in "…" when cut. */
function clip(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  const ellipsis = "…";
  let out = "";
  let used = bytes(ellipsis);
  for (const char of text) {
    used += bytes(char);
    if (used > maxBytes) break;
    out += char;
  }
  return out + ellipsis;
}

function gitLines(status: GitStatus, subjects: readonly string[]): string[] {
  let branch = `Branch: ${status.branch ?? `(detached at ${status.head ?? "?"})`}`;
  const { upstream } = status;
  if (upstream !== undefined) branch += ` (ahead ${upstream.ahead}, behind ${upstream.behind} of ${upstream.name})`;
  const lines = [branch];

  const { dirty } = status;
  if (dirty.length > 0) {
    // Name paths while the line stays short, then only count the rest.
    let line = `${dirty.length} uncommitted:`;
    let named = 0;
    for (const path of dirty) {
      const next = `${line}${named === 0 ? " " : ", "}${clip(path, maxPathBytes)}`;
      if (bytes(next) > maxDirtyLineBytes) break;
      line = next;
      named++;
    }
    if (named < dirty.length) line += ` (+${dirty.length - named} more)`;
    lines.push(line);
  }
  if (subjects.length > 0) lines.push("Recent commits:", ...subjects.map((s) => `- ${clip(s, maxSubjectBytes)}`));
  return lines;
}

/** Reads at most `maxBytes` of a file, so a huge file is never loaded whole. */
async function readHead(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

async function readExtraFile(cwd: string, path: string): Promise<string> {
  try {
    return `${path}:\n${(await readHead(resolve(cwd, path), budgetBytes + 4)).trimEnd()}`;
  } catch (error) {
    return `${path}: (could not read: ${(error as NodeJS.ErrnoException).code ?? "error"})`;
  }
}

async function runExtraCommand(runner: ProcessRunner, cwd: string, argv: readonly string[]): Promise<string | undefined> {
  const [command, ...args] = argv;
  if (command === undefined) return undefined;
  const header = `$ ${argv.join(" ")}`;
  let result: ProcessResult;
  try {
    result = await runner.run(command, args, { cwd, timeoutMs: commandTimeoutMs });
  } catch (error) {
    return `${header}: (could not run: ${error instanceof Error ? error.message : String(error)})`;
  }
  if (result.spawnError !== undefined) return `${header}: (could not run: ${result.spawnError})`;
  if (result.timedOut) return `${header}: (timed out after ${commandTimeoutMs} ms)`;
  if (result.exitCode !== 0) return `${header}: (failed with exit code ${result.exitCode})`;
  return `${header}\n${result.stdout.trimEnd()}`;
}

/** The core summary, then each extra while budget remains, clipping the one that crosses it. */
function withinBudget(core: string, extras: readonly (string | undefined)[]): string {
  let text = clip(core, budgetBytes);
  for (const extra of extras) {
    if (extra === undefined) continue;
    const remaining = budgetBytes - bytes(text) - 1;
    if (remaining < minExtraBytes) break;
    text += `\n${clip(extra, remaining)}`;
  }
  return text;
}

const optionsSchema = s.object({
  files: s.array(s.string(), {
    description:
      "Files, relative to the project, whose contents are added after the git summary. They share its 1 KB budget.",
  }),
  commands: s.array(s.array(s.string()), {
    description:
      'Commands whose output is added after the files, each an argument list run without a shell, e.g. ["gh", "pr", "list"]. They share the 1 KB budget.',
  }),
});

export const sessionContext = defineHook({
  name: "session-context",
  description: "Tells the Host the date, git branch, dirty files and recent commits when a session starts or compacts.",
  events: ["SessionStart"],
  failMode: "open",
  optionsSchema,
  commandOptions: ["commands"],
  defaults: {
    standard: { enabled: true, options: { files: [], commands: [] } },
    strict: { enabled: true, options: { files: [], commands: [] } },
  },
  async run(event, options, env) {
    const [status, subjects, files, commands] = await Promise.all([
      gitStatus(env.processRunner, event.cwd),
      recentCommitSubjects(env.processRunner, event.cwd, commitCount),
      Promise.all(options.files.map((path) => readExtraFile(event.cwd, path))),
      Promise.all(options.commands.map((argv) => runExtraCommand(env.processRunner, event.cwd, argv))),
    ]);
    const lines = [`Today: ${formatDate(env.clock.now())}`];
    if (status !== undefined) lines.push(...gitLines(status, subjects ?? []));
    return addContext(withinBudget(lines.join("\n"), [...files, ...commands]));
  },
});
