/**
 * What Guards (Hooks that fail closed, ADR-0004) share: findings that each
 * want a block or an ask, merged into one Decision, and the block for a
 * command line that couldn't be analysed.
 */
import { ask, block, type Decision } from "../decision";

/** One reason a Guard wants to stop an action. */
export interface Finding {
  readonly decision: "block" | "ask";
  readonly reason: string;
}

/**
 * One Decision for all of a Guard's findings: block when any finding blocks,
 * else ask; the reason joins the distinct reasons of that strength, one per
 * line. undefined when there are none.
 */
export function decide(findings: readonly Finding[]): Decision | undefined {
  const strongest = findings.some((f) => f.decision === "block") ? "block" : findings.length > 0 ? "ask" : undefined;
  if (strongest === undefined) return undefined;
  const reason = [...new Set(findings.filter((f) => f.decision === strongest).map((f) => f.reason))].join("\n");
  return strongest === "block" ? block(reason) : ask(reason);
}

/** The block for a shell command `analyzeShell()` couldn't parse: a Guard that can't see a command doesn't let it run. */
export function cannotAnalyse(guard: string, error: string): Decision {
  return block(
    `This command couldn't be analysed (${error}), so ${guard} blocked it to be safe. ` +
      "Fix the syntax or split it into simpler commands.",
  );
}
