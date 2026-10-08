import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Write a file (creating parent dirs) relative to `dir`. Default content: its own path. */
export function writeProjectFile(dir: string, path: string, content = `${path}\n`): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
