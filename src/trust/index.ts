/**
 * Trust (ADR-0005): whether hardhooks may run commands that come from a
 * project itself, as opposed to the user's own config. Those are the command
 * options in the repo's `.hardhooks.json` and the commands Hooks autodetect
 * from the project's files (package.json scripts, formatters, ruff, go vet,
 * cargo check). Like `direnv allow`, `hardhooks trust` records a hash of the
 * project root path plus the files that choose what runs; until the user
 * trusts the project, and again after any of those files change, Hooks skip
 * such commands and the user is told once per session.
 *
 * State, in the user state dir (never the repo):
 *
 *   trust/projects/<sha256(root)>.json   { root, hash, inputs: { file: digest }, trustedAt }
 *   trust/notices/<sha256(root, session, Hook)>   the untrusted notice was shown this session
 *
 * Reading trust never throws: unreadable state reads as untrusted.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findRepoConfig } from "../config/load";
import type { Environment } from "../environment";

/** The project a directory belongs to: the nearest ancestor with `.git` (dir or file), else the directory itself. */
export function projectRoot(dir: string): string {
  const start = resolve(dir);
  for (let current = start; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return start;
  }
}

/** How much of a file the trust hash covers. */
type Coverage =
  /** The whole file. */
  | "content"
  /** Only whether it exists. */
  | "presence"
  /** package.json: the fields hardhooks reads to choose commands. */
  | "package.json fields";

const prettierConfigs = [
  ".prettierrc",
  ...["json", "yaml", "yml", "json5", "js", "cjs", "mjs", "ts", "cts", "mts", "toml"].map((ext) => `.prettierrc.${ext}`),
  ...["js", "cjs", "mjs", "ts", "cts", "mts"].map((ext) => `prettier.config.${ext}`),
];

/**
 * The files at the project root that choose what hardhooks runs, besides the
 * repo config. Whole files where they are small and can themselves load code
 * (formatter configs: prettier and dprint plugins); package.json only for
 * the fields read (`scripts` for check, `prettier` for format-on-edit), so a
 * dependency bump doesn't ask again; and only presence for files that merely
 * switch a tool on (lockfiles pick the package manager; pyproject.toml,
 * go.mod and Cargo.toml turn on ruff/black, go vet and cargo check).
 */
const projectInputs: readonly (readonly [string, Coverage])[] = [
  ["package.json", "package.json fields"],
  ...prettierConfigs.map((file) => [file, "content"] as const),
  ...["biome.json", "biome.jsonc", "dprint.json", ".dprint.json", "dprint.jsonc", ".dprint.jsonc"].map(
    (file) => [file, "content"] as const,
  ),
  ...["ruff.toml", ".ruff.toml", "rustfmt.toml", ".rustfmt.toml"].map((file) => [file, "content"] as const),
  ...["pyproject.toml", "go.mod", "Cargo.toml", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].map(
    (file) => [file, "presence"] as const,
  ),
];

/** The package.json fields the hash covers. */
const packageJsonFields = ["scripts", "prettier"] as const;

/** One file the trust hash covers. */
export interface TrustInput {
  /** Relative to the project root, with forward slashes. */
  readonly file: string;
  readonly coverage: Coverage;
  readonly exists: boolean;
  /** sha256 of what is covered. */
  readonly digest: string;
}

export type TrustState =
  /** Trusted, and nothing covered has changed since. */
  | "trusted"
  /** Never trusted (or revoked). */
  | "untrusted"
  /** Trusted once, but a covered file changed since. */
  | "changed";

export interface TrustStatus {
  readonly root: string;
  readonly state: TrustState;
  /** The repo config that applies here, relative to the root; undefined when there is none. */
  readonly repoConfig: string | undefined;
  /** Every covered file, present or not. */
  readonly inputs: readonly TrustInput[];
  /** When `changed`: the covered files that differ from when the project was trusted. */
  readonly changed: readonly string[];
}

const sha256 = (...parts: readonly string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function canonical(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
}

const slashes = (path: string) => path.split(sep).join("/");

function covered(root: string, file: string, coverage: Coverage): TrustInput {
  const text = readText(join(root, file));
  let value: string;
  if (text === undefined) value = "absent";
  else if (coverage === "presence") value = "present";
  else if (coverage === "content") value = text;
  else {
    let pkg: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      pkg = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      pkg = undefined;
    }
    // Unparseable: hash it whole, so any edit counts.
    value = pkg === undefined ? text : JSON.stringify(packageJsonFields.map((field) => pkg[field] ?? null));
  }
  return { file: slashes(file), coverage, exists: text !== undefined, digest: sha256(coverage, value) };
}

/** The files the hash covers for the project containing `dir`, the repo config first. */
function inputsFor(env: Environment, root: string, dir: string): { repoConfig: string | undefined; inputs: TrustInput[] } {
  const configPath = findRepoConfig({ ...env, cwd: dir });
  const repoConfig = configPath === undefined ? undefined : slashes(relative(root, canonical(configPath)));
  const inputs = [covered(root, repoConfig ?? ".hardhooks.json", "content")];
  for (const [file, coverage] of projectInputs) inputs.push(covered(root, file, coverage));
  return { repoConfig, inputs };
}

const projectHash = (root: string, inputs: readonly TrustInput[]) =>
  sha256("hardhooks-trust-v1", root, ...inputs.map((input) => `${input.file}=${input.digest}`));

interface TrustRecord {
  root: string;
  hash: string;
  inputs: Record<string, string>;
  trustedAt: string;
}

const recordPath = (env: Environment, root: string) => join(env.stateDir, "trust", "projects", `${sha256(root)}.json`);

function readRecord(env: Environment, root: string): TrustRecord | undefined {
  const text = readText(recordPath(env, root));
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<TrustRecord>;
    if (value.root !== root || typeof value.hash !== "string") return undefined;
    return { root, hash: value.hash, inputs: value.inputs ?? {}, trustedAt: String(value.trustedAt ?? "") };
  } catch {
    return undefined;
  }
}

/** Whether the project containing `dir` is trusted, and what its trust covers. Never throws. */
export function trustStatus(env: Environment, dir: string): TrustStatus {
  const root = canonical(projectRoot(dir));
  const { repoConfig, inputs } = inputsFor(env, root, dir);
  const record = readRecord(env, root);
  if (record === undefined) return { root, state: "untrusted", repoConfig, inputs, changed: [] };
  if (record.hash === projectHash(root, inputs)) return { root, state: "trusted", repoConfig, inputs, changed: [] };
  const files = new Set([...inputs.map((input) => input.file), ...Object.keys(record.inputs)]);
  const digests = new Map(inputs.map((input) => [input.file, input.digest]));
  const changed = [...files].filter((file) => record.inputs[file] !== digests.get(file));
  return { root, state: "changed", repoConfig, inputs, changed };
}

/** Trust the project containing `dir` as its files are now. Throws if the state dir can't be written. */
export function grantTrust(env: Environment, dir: string): TrustStatus {
  const status = trustStatus(env, dir);
  const record: TrustRecord = {
    root: status.root,
    hash: projectHash(status.root, status.inputs),
    inputs: Object.fromEntries(status.inputs.map((input) => [input.file, input.digest])),
    trustedAt: env.clock.now().toISOString(),
  };
  const path = recordPath(env, status.root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { ...status, state: "trusted", changed: [] };
}

/** Stop trusting the project containing `dir`. Resolves to whether it was trusted (or changed) before. */
export function revokeTrust(env: Environment, dir: string): boolean {
  const root = canonical(projectRoot(dir));
  const path = recordPath(env, root);
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return existed;
}

/** Why a command was skipped, for the one-line notice: "this project isn't trusted" or what changed. */
export function untrustedReason(status: Pick<TrustStatus, "state" | "changed">): string {
  if (status.state === "changed") {
    return `this project changed since you trusted it (${status.changed.join(", ")}). Run \`hardhooks trust\` to review and allow it again`;
  }
  return "this project is not trusted. Run `hardhooks trust` to review and allow its commands";
}

/**
 * Whether to show the untrusted notice for this Hook now: once per session
 * (every time when the Host sends no session id). Records that it was shown.
 */
export function noticeDue(env: Environment, root: string, sessionId: string | undefined, hook: string): boolean {
  if (sessionId === undefined) return true;
  const path = join(env.stateDir, "trust", "notices", sha256(root, sessionId, hook));
  if (existsSync(path)) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  } catch {
    // Best-effort: at worst the notice repeats.
  }
  return true;
}
