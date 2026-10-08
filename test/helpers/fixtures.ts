import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { HostResult } from "../../src/dispatcher";
import { observe, type ObservedDecision } from "./decisions";

/**
 * A fixture: a Host payload for one Event plus the Decision the Host should
 * see. Provisional format: #13 (`hardhooks test`) owns it and may extend it.
 */
export interface FixtureCase {
  /** File name, for test titles. */
  file: string;
  description: string;
  event: string;
  payload: Record<string, unknown>;
  expect: {
    decision: ObservedDecision["decision"];
    /** Regular expression (case-insensitive) the reason must match. */
    reason?: string;
    /** Regular expression (case-insensitive) the added context must match. */
    context?: string;
  };
}

/** Load every `*.json` fixture in a directory, e.g. `loadFixtures(new URL("./fixtures", import.meta.url))`. */
export function loadFixtures(dir: URL): FixtureCase[] {
  const path = fileURLToPath(dir);
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => ({ file, ...(JSON.parse(readFileSync(join(path, file), "utf8")) as Omit<FixtureCase, "file">) }));
}

export function expectFixture(result: HostResult, fixture: FixtureCase): void {
  expect(result.exitCode, result.stderr).toBe(0);
  const observed = observe(result);
  expect(observed.decision, result.stdout).toBe(fixture.expect.decision);
  if (fixture.expect.reason !== undefined) expect(observed.reason).toMatch(new RegExp(fixture.expect.reason, "i"));
  if (fixture.expect.context !== undefined) expect(observed.context).toMatch(new RegExp(fixture.expect.context, "i"));
}
