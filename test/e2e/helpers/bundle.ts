/**
 * Copies of the built bundle, for tests about where hardhooks is installed:
 * `init` refers to the bundle it runs from (`import.meta.url`), so a
 * project-local install (`npm i -D hardhooks`) is a copy in
 * `<project>/node_modules/hardhooks`, and the built bundle (outside every
 * sandbox) stands for a global install. Run a copy with `box.run(args, { bundle })`.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

const packageJson = fileURLToPath(new URL("../../../package.json", import.meta.url));

/**
 * Install the built bundle as the package `packageDir` (e.g.
 * `<project>/node_modules/hardhooks`): `dist/hardhooks.mjs` plus
 * `package.json`. Returns the bundle's path.
 */
export function copyBundle(packageDir: string): string {
  const dist = join(packageDir, "dist");
  mkdirSync(dist, { recursive: true });
  const bundle = join(dist, "hardhooks.mjs");
  copyFileSync(inject("hardhooksE2E").bundle, bundle);
  copyFileSync(packageJson, join(packageDir, "package.json"));
  return bundle;
}
