/**
 * session-context (fails open): at SessionStart, every source including
 * compact, tells the Host where it is: today's date and, in a git repo, the
 * branch, ahead/behind, dirty files and recent commits. The whole context is
 * hard-capped at `budgetBytes`, because it stays in the conversation and is
 * re-added after every compaction.
 */
import { addContext } from "../../decision";
import { gitStatus, recentCommitSubjects, type GitStatus } from "../../git";
import { defineHook } from "../hook";

/** Hard cap on the added context, in UTF-8 bytes. */
const budgetBytes = 1024;
const commitCount = 5;
/** Dirty paths named before the rest are only counted. */
const dirtyNamesShown = 10;
const maxPathBytes = 80;
const maxSubjectBytes = 80;

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
    const named = dirty.slice(0, dirtyNamesShown).map((path) => clip(path, maxPathBytes));
    const more = dirty.length > named.length ? ` (+${dirty.length - named.length} more)` : "";
    lines.push(`${dirty.length} uncommitted: ${named.join(", ")}${more}`);
  }
  if (subjects.length > 0) lines.push("Recent commits:", ...subjects.map((s) => `- ${clip(s, maxSubjectBytes)}`));
  return lines;
}

export const sessionContext = defineHook({
  name: "session-context",
  description: "Tells the Host the date, git branch, dirty files and recent commits when a session starts or compacts.",
  events: ["SessionStart"],
  failMode: "open",
  defaults: {
    standard: { enabled: true, options: {} },
    strict: { enabled: true, options: {} },
  },
  async run(event, _options, env) {
    const [status, subjects] = await Promise.all([
      gitStatus(env.processRunner, event.cwd),
      recentCommitSubjects(env.processRunner, event.cwd, commitCount),
    ]);
    const lines = [`Today: ${formatDate(env.clock.now())}`];
    if (status !== undefined) lines.push(...gitLines(status, subjects ?? []));
    return addContext(clip(lines.join("\n"), budgetBytes));
  },
});
