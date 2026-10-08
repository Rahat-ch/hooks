/**
 * session-context (fails open): at SessionStart, every source including
 * compact, tells the Host where it is: today's date and, in a git repo, the
 * branch, ahead/behind, dirty files and recent commits, then any configured
 * extra files and command output. The whole context is hard-capped at `budgetBytes`, because it
 * stays in the conversation and is re-added after every compaction.
 *
 * Extra files go to the model, so they get protect-secrets' rules: a file
 * must be named relative to the project and stay inside it after following
 * symlinks, and a file protect-secrets protects (its resolved
 * `protect`/`allow`/`ignoreFiles`) is skipped with a one-line note. This
 * holds for `files` from any config: a repo config can't use it to pull in
 * `~/.aws/credentials`, and a user who wants an outside file in the context
 * can name a command in their own config instead.
 */
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { hookSettings, type ResolvedConfig } from "../../config";
import * as s from "../../config/schema";
import { addContext } from "../../decision";
import type { ProcessResult, ProcessRunner } from "../../environment";
import { gitStatus, recentCommitSubjects, type GitStatus } from "../../git";
import { secretsMatcher, type SecretsMatcher } from "../../secrets";
import { projectRoot } from "../../trust";
import { defineHook } from "../hook";
import { describeSource, protectSecrets } from "../protect-secrets";

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

function realpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/** Whether `path` is `root` or inside it (both absolute, same platform). */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Decides which configured files may enter the context: inside the project and not secret. */
interface FileGate {
  /** Why `path` must stay out, or undefined when it may be read. */
  refuse(path: string): string | undefined;
}

/**
 * A gate for the project containing `cwd`. A file must be named relative to
 * the project and stay inside it, also after following symlinks, and neither
 * its name nor its target may be protected by protect-secrets' patterns
 * (built-in, project ignore files, `protect`/`allow`), whatever config set
 * `files`: the context goes to the model, exactly what protect-secrets
 * keeps secrets out of.
 */
function fileGate(cwd: string, home: string, config: ResolvedConfig): FileGate {
  const root = projectRoot(cwd);
  const realRoot = realpath(root) ?? root;
  const secrets = hookSettings(protectSecrets, config).options;
  let matcher: SecretsMatcher | undefined;
  try {
    matcher = secretsMatcher({ projectDir: realRoot, home, ...secrets });
  } catch {
    matcher = undefined;
  }
  return {
    refuse(path) {
      if (isAbsolute(path)) return "not a path relative to the project";
      const full = resolve(cwd, path);
      const real = realpath(full);
      if (!inside(root, full) || (real !== undefined && !inside(realRoot, real))) return "outside the project";
      if (matcher === undefined) return "could not read the protect-secrets ignore files";
      const match = matcher.match(relative(root, full), realRoot) ?? (real === undefined ? undefined : matcher.match(real));
      return match && `protected by \`${match.pattern}\` (${describeSource(match)})`;
    },
  };
}

async function readExtraFile(cwd: string, path: string, gate: FileGate): Promise<string> {
  const refused = gate.refuse(path);
  if (refused !== undefined) return `${path}: (skipped: ${refused})`;
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
      "Files, relative to the project, whose contents are added after the git summary. They share its 1 KB budget. " +
      "A file outside the project (absolute, `..`, or a symlink out of it), or one protect-secrets protects, is left out with a note.",
  }),
  commands: s.array(s.array(s.string()), {
    description:
      'Commands whose output is added after the files, each an argument list run without a shell, e.g. ["gh", "pr", "list"]. They share the 1 KB budget. From a repo config, they run only once the project is trusted (`hardhooks trust`).',
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
  async run(event, options, env, _trust, config) {
    const gate = fileGate(event.cwd, env.home, config);
    const [status, subjects, files, commands] = await Promise.all([
      gitStatus(env, event.cwd),
      recentCommitSubjects(env, event.cwd, commitCount),
      Promise.all(options.files.map((path) => readExtraFile(event.cwd, path, gate))),
      Promise.all(options.commands.map((argv) => runExtraCommand(env.processRunner, event.cwd, argv))),
    ]);
    const lines = [`Today: ${formatDate(env.clock.now())}`];
    if (status !== undefined) lines.push(...gitLines(status, subjects ?? []));
    return addContext(withinBudget(lines.join("\n"), [...files, ...commands]));
  },
});
