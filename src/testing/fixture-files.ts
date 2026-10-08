/**
 * Finding shipped fixture files on disk: `src/hooks/<hook>/fixtures/*.json`.
 * Used at run time from source (vitest) and at build time by the tsup plugin
 * that inlines them into the bundle, so both see exactly the same files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One fixture file's raw text, labelled with the Hook whose directory it is in. */
export interface FixtureFile {
  /** The Hook the fixture belongs to: its directory name under `src/hooks/`. */
  readonly hook: string;
  /** File name, e.g. `force-push-blocked.json`. */
  readonly file: string;
  readonly text: string;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Every `*.json` file in a directory, sorted by name. */
export function readFixtureDir(hook: string, dir: string): FixtureFile[] {
  return list(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ hook, file, text: readFileSync(join(dir, file), "utf8") }));
}

/** Every Hook's fixture files under `hooksDir` (`src/hooks`), by Hook then file name. */
export function collectFixtureFiles(hooksDir: string): FixtureFile[] {
  return list(hooksDir).flatMap((hook) => readFixtureDir(hook, join(hooksDir, hook, "fixtures")));
}
