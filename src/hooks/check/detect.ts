/** Finding a check command when none is configured. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DetectedCommand {
  /** A command line for the platform shell. */
  readonly command: string;
  /** Where it came from, for the announcement: "package.json scripts lint, test". */
  readonly source: string;
}

/** package.json scripts that make a check, in the order they run. */
const checkScripts = ["lint", "typecheck", "test"] as const;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The package manager the lockfile names; npm without one. */
function packageManager(cwd: string): string {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function fromPackageJson(cwd: string): DetectedCommand | undefined {
  const pkg = readJson(join(cwd, "package.json")) as { scripts?: Record<string, unknown> } | undefined;
  const scripts = pkg?.scripts;
  if (typeof scripts !== "object" || scripts === null) return undefined;
  const present = checkScripts.filter((name) => {
    const script = scripts[name];
    // `npm init`'s placeholder test script always fails; it isn't a check.
    return typeof script === "string" && script.trim() !== "" && !/no test specified/.test(script);
  });
  if (present.length === 0) return undefined;
  const pm = packageManager(cwd);
  return {
    command: present.map((name) => `${pm} run ${name}`).join(" && "),
    source: `package.json scripts ${present.join(", ")}`,
  };
}

/**
 * The first match, in order: package.json `lint`/`typecheck`/`test` scripts
 * (all that exist, run in that order), ruff, `go vet`, `cargo check`.
 */
export function detectCommand(cwd: string): DetectedCommand | undefined {
  return fromPackageJson(cwd) ?? fromRuff(cwd) ?? fromFile(cwd, "go.mod", "go vet ./...") ?? fromFile(cwd, "Cargo.toml", "cargo check");
}

function fromRuff(cwd: string): DetectedCommand | undefined {
  for (const name of ["ruff.toml", ".ruff.toml"]) {
    const found = fromFile(cwd, name, "ruff check .");
    if (found) return found;
  }
  try {
    if (/^\[tool\.ruff[\].]/m.test(readFileSync(join(cwd, "pyproject.toml"), "utf8"))) {
      return { command: "ruff check .", source: "pyproject.toml [tool.ruff]" };
    }
  } catch {
    // No pyproject.toml.
  }
  return undefined;
}

function fromFile(cwd: string, name: string, command: string): DetectedCommand | undefined {
  return existsSync(join(cwd, name)) ? { command, source: name } : undefined;
}
