import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { HostResult } from "../../src/dispatcher";
import { parseCaseFile, type TestCase } from "../../src/testing/cases";
import { readFixtureDir } from "../../src/testing/fixture-files";
import { judge } from "../../src/testing/observe";

/**
 * A fixture: a Host payload for one Event plus the Decision the Host should
 * see. The format lives in `src/testing/cases.ts`, shared with `hardhooks test`.
 */
export interface FixtureCase extends TestCase {
  /** File name, for test titles. */
  file: string;
  /** Same as `name`, for test titles. */
  description: string;
}

/** Load every `*.json` fixture in a directory, e.g. `loadFixtures(new URL("./fixtures", import.meta.url))`. */
export function loadFixtures(dir: URL): FixtureCase[] {
  const path = fileURLToPath(dir);
  const hook = basename(dirname(path));
  return readFixtureDir(hook, path).flatMap(({ file, text }) => {
    const parsed = parseCaseFile(text, `${hook}/fixtures/${file}`, { kind: "fixture", cwd: "/home/user/demo" });
    if (!parsed.ok) throw new Error(`invalid fixture:\n${parsed.errors.join("\n")}`);
    return parsed.cases.map((testCase) => ({ ...testCase, file, description: testCase.name }));
  });
}

/** Judge a dispatcher result exactly as `hardhooks test` does. */
export function expectFixture(result: HostResult, fixture: TestCase): void {
  const verdict = judge(result, fixture.expect);
  expect(verdict.problems, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toEqual([]);
}
