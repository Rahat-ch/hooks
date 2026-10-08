import { expect } from "vitest";
import type { HostResult } from "../../src/dispatcher";

/**
 * What the Host would conclude from a hook's output, decoded independently of
 * our own renderer from Claude Code's documented protocol. Tests assert on
 * this, never on internals.
 */
export interface ObservedDecision {
  decision: "block" | "ask" | "allow" | "none";
  reason?: string;
  context?: string;
  /** Shown to the user only (Claude Code's `systemMessage`), never to the model. */
  message?: string;
}

export function observe(result: HostResult): ObservedDecision {
  if (result.exitCode === 2) return { decision: "block", reason: result.stderr };
  if (result.stdout.trim() === "") return { decision: "none" };

  const out = JSON.parse(result.stdout) as {
    decision?: string;
    reason?: string;
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
  if (out.systemMessage !== undefined) observed.message = out.systemMessage;
  return observed;
}

/** The Host sees a block (deny / decision:block) with a reason, via JSON on stdout and exit 0. */
export function expectBlocked(result: HostResult, reason?: RegExp): ObservedDecision {
  expect(result.exitCode, result.stderr).toBe(0);
  const observed = observe(result);
  expect(observed.decision, result.stdout).toBe("block");
  expect(observed.reason).toBeTruthy();
  if (reason) expect(observed.reason).toMatch(reason);
  return observed;
}

export function expectAsked(result: HostResult, reason?: RegExp): ObservedDecision {
  expect(result.exitCode, result.stderr).toBe(0);
  const observed = observe(result);
  expect(observed.decision, result.stdout).toBe("ask");
  if (reason) expect(observed.reason).toMatch(reason);
  return observed;
}

/** Nothing for the Host to act on: exit 0 and empty stdout, so the normal permission flow continues. */
export function expectNoDecision(result: HostResult): void {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
}

export function expectContext(result: HostResult, context: RegExp): ObservedDecision {
  expect(result.exitCode, result.stderr).toBe(0);
  const observed = observe(result);
  expect(observed.context).toMatch(context);
  return observed;
}

/** The user sees a message (`systemMessage`) matching `message`. */
export function expectMessage(result: HostResult, message: RegExp): ObservedDecision {
  expect(result.exitCode, result.stderr).toBe(0);
  const observed = observe(result);
  expect(observed.message, result.stdout).toMatch(message);
  return observed;
}
