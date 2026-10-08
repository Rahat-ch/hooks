/**
 * Runs once per vitest run (both projects), before any test file: builds the
 * bundle the tests spawn, finds the real `node` and `git` the sandboxes put
 * on PATH, and makes one temp directory every sandbox of the run lives in
 * (removed at the end, so tests need no per-test cleanup and can run
 * concurrently).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

export interface E2EContext {
  /** Absolute path of the freshly built `dist/hardhooks.mjs`. */
  bundle: string;
  /** The real node binary (the one running vitest). */
  node: string;
  /** The real git binary. */
  git: string;
  /** Directories that hold exactly node and git (POSIX: symlinks in one dir; Windows: their install dirs). */
  toolsPath: string[];
  /** Every sandbox of this run is created in here. */
  runRoot: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    hardhooksE2E: E2EContext;
  }
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The first `name` (plus `.exe` on Windows) on the developer's PATH. */
function which(name: string): string {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, file);
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  throw new Error(`e2e tests need ${file} on PATH`);
}

function build(): string {
  const tsup = createRequire(join(repoRoot, "package.json")).resolve("tsup/dist/cli-default.js");
  const result = spawnSync(process.execPath, [tsup], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`building the bundle failed:\n${result.stdout}\n${result.stderr}`);
  return join(repoRoot, "dist", "hardhooks.mjs");
}

export default function setup(project: TestProject) {
  const bundle = build();
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), "hardhooks-e2e-")));
  const node = realpathSync(process.execPath);
  const git = which("git");
  let toolsPath: string[];
  if (process.platform === "win32") {
    // Symlinks need privileges on Windows; these install dirs hold no notifiers or formatters.
    toolsPath = [...new Set([dirname(node), dirname(git)])];
  } else {
    const tools = join(runRoot, "tools");
    mkdirSync(tools);
    symlinkSync(node, join(tools, "node"));
    symlinkSync(git, join(tools, "git"));
    toolsPath = [tools];
  }
  project.provide("hardhooksE2E", { bundle, node, git, toolsPath, runRoot });
  return () => rmSync(runRoot, { recursive: true, force: true });
}
