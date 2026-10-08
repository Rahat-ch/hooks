/**
 * Finding and parsing the user's case files: every `*.json` (or `*.jsonl`, one
 * case per line, such as an audit-log day file) in
 * `.hardhooks/tests/` at the project root, or the file or directory given
 * with `--cases <path>`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { Environment } from "../environment";
import { projectRoot } from "../project";
import { parseCaseFile, type TestCase } from "./cases";

/** Where `hardhooks test` looks for case files without `--cases`. */
export function defaultCasesDir(env: Environment): string {
  return join(projectRoot(env.cwd), ".hardhooks", "tests");
}

export type UserCases =
  | { readonly ok: true; readonly cases: TestCase[]; /** For the report header. */ readonly location: string }
  | { readonly ok: false; readonly errors: string[] };

export function loadUserCases(env: Environment, casesPath: string | undefined): UserCases {
  const root = projectRoot(env.cwd);
  const path = casesPath === undefined ? defaultCasesDir(env) : resolve(env.cwd, casesPath);
  const location = relative(env.cwd, path) || ".";

  let files: string[];
  try {
    files = statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((name) => name.endsWith(".json") || name.endsWith(".jsonl"))
          .sort()
          .map((name) => join(path, name))
      : [path];
  } catch (error) {
    if (casesPath === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, cases: [], location };
    return { ok: false, errors: [`${location}: ${(error as Error).message}`] };
  }

  const cases: TestCase[] = [];
  const errors: string[] = [];
  for (const file of files) {
    // Relative to the location in the report header (which is the file itself for `--cases <file>`).
    const source = relative(path, file) || basename(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      errors.push(`${source}: ${(error as Error).message}`);
      continue;
    }
    // A `.jsonl` file (an audit-log day file) holds one case per line.
    if (file.endsWith(".jsonl")) text = `[${text.split(/\r?\n/).filter((line) => line.trim() !== "").join(",")}]`;
    // Built payloads run in the project root, so cases mean the same wherever the command runs.
    const parsed = parseCaseFile(text, source, { kind: "case", cwd: root });
    if (parsed.ok) cases.push(...parsed.cases);
    else errors.push(...parsed.errors);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, cases, location };
}
