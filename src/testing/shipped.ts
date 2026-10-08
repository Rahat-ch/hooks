/**
 * The fixtures hardhooks ships, for `hardhooks test`.
 *
 * From source (vitest, `tsx`) this reads `src/hooks/<hook>/fixtures/*.json`.
 * The build replaces this whole module with the same files inlined as data
 * (see `inlineShippedFixtures` in tsup.config.ts), so the bundle stays one
 * self-contained file (ADR-0001) and never has to find JSON files beside
 * itself at run time.
 */
import { fileURLToPath } from "node:url";
import { collectFixtureFiles, type FixtureFile } from "./fixture-files";

export function shippedFixtureFiles(): readonly FixtureFile[] {
  return collectFixtureFiles(fileURLToPath(new URL("../hooks", import.meta.url)));
}
