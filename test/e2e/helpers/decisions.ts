import { expect } from "vitest";
import type { HostResult } from "../../../src/dispatcher";
import { observe, type ObservedDecision } from "../../../src/testing/observe";

/**
 * What the Host would conclude from a hook's output, decoded independently of
 * our own renderer from Claude Code's documented protocol. Tests assert on
 * this, never on internals. One decoder serves these tests and `hardhooks test`.
 */
export { observe, type ObservedDecision } from "../../../src/testing/observe";

/**
 * The Host proceeds without a permission Decision (its own prompts apply) but
 * shows the user a warning (`systemMessage`).
 */
export function expectAllowedWithWarning(result: HostResult, warning?: RegExp): ObservedDecision {
  expect(result.exitCode, result.stderr).toBe(0);
  const observed = observe(result);
  expect(observed.decision, result.stdout).toBe("none");
  expect(observed.message, result.stdout).toBeTruthy();
  if (warning) expect(observed.message).toMatch(warning);
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
