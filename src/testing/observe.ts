/**
 * What the Host concludes from the dispatcher's output, decoded from Claude
 * Code's documented hook protocol (independently of our own renderer), and
 * whether that matches a test case's expectation. `hardhooks test` and the
 * project's own tests judge results with this one module.
 */
import type { HostResult } from "../dispatcher";

export interface ObservedDecision {
  decision: "block" | "ask" | "allow" | "none";
  reason?: string;
  context?: string;
  /** A terminal escape sequence (e.g. an OSC 9 notification) the Host writes to its terminal for us. */
  terminalSequence?: string;
  /**
   * Shown to the user only (Claude Code's `systemMessage`), never to the model:
   * Hooks' messages and the dispatcher's warnings (e.g. the ask fallback), joined.
   */
  message?: string;
}

export function observe(result: HostResult): ObservedDecision {
  if (result.exitCode === 2) return { decision: "block", reason: result.stderr };
  if (result.stdout.trim() === "") return { decision: "none" };

  const out = JSON.parse(result.stdout) as {
    decision?: string;
    reason?: string;
    terminalSequence?: string;
    systemMessage?: string;
    hookSpecificOutput?: {
      permissionDecision?: string;
      permissionDecisionReason?: string;
      additionalContext?: string;
    };
  };
  const specific = out.hookSpecificOutput ?? {};
  const observed: ObservedDecision = { decision: "none" };

  if (out.decision === "block") {
    observed.decision = "block";
    if (out.reason !== undefined) observed.reason = out.reason;
  } else if (specific.permissionDecision !== undefined) {
    const map: Record<string, ObservedDecision["decision"]> = { deny: "block", ask: "ask", allow: "allow" };
    observed.decision = map[specific.permissionDecision] ?? "none";
    if (specific.permissionDecisionReason !== undefined) observed.reason = specific.permissionDecisionReason;
  }
  if (specific.additionalContext !== undefined) observed.context = specific.additionalContext;
  if (out.terminalSequence !== undefined) observed.terminalSequence = out.terminalSequence;
  if (out.systemMessage !== undefined) observed.message = out.systemMessage;
  return observed;
}

/** The Decision a case expects; `allow` and `none` both mean the Host goes ahead (neither blocked nor asked). */
export type ExpectedDecision = "block" | "ask" | "allow" | "none";

export interface Expectation {
  readonly decision?: ExpectedDecision | undefined;
  /** Case-insensitive regular expression the reason must match. */
  readonly reason?: string | undefined;
  /** Case-insensitive regular expression the added context must match. */
  readonly context?: string | undefined;
}

/** Whether one test case passed: its expectation against what the Host saw. */
export interface CaseResult {
  readonly pass: boolean;
  /** What went wrong, one line each; empty when the case passed. */
  readonly problems: readonly string[];
  readonly observed: ObservedDecision | undefined;
}

const proceeds = (decision: ObservedDecision["decision"]) => decision === "allow" || decision === "none";

function matches(pattern: string, text: string | undefined): boolean {
  return text !== undefined && new RegExp(pattern, "i").test(text);
}

/** Judge one dispatcher result against an expectation. */
export function judge(result: HostResult, expectation: Expectation): CaseResult {
  const problems: string[] = [];
  if (result.exitCode !== 0 && result.exitCode !== 2) problems.push(`exit code ${result.exitCode}`);
  let observed: ObservedDecision | undefined;
  try {
    observed = observe(result);
  } catch (error) {
    problems.push(`unreadable Host output: ${(error as Error).message}`);
    return { pass: false, problems, observed };
  }
  const { decision, reason, context } = expectation;
  if (decision !== undefined) {
    const ok = proceeds(decision) ? proceeds(observed.decision) : observed.decision === decision;
    if (!ok) {
      const why = observed.reason === undefined ? "" : `: ${observed.reason.replace(/\s*\n\s*/g, " ")}`;
      problems.push(`decision: expected ${decision}, got ${observed.decision}${why}`);
    }
  }
  if (reason !== undefined && !matches(reason, observed.reason)) {
    problems.push(`reason: expected to match /${reason}/i, got ${JSON.stringify(observed.reason ?? "")}`);
  }
  if (context !== undefined && !matches(context, observed.context)) {
    problems.push(`context: expected to match /${context}/i, got ${JSON.stringify(observed.context ?? "")}`);
  }
  return { pass: problems.length === 0, problems, observed };
}
