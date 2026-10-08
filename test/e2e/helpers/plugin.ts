/**
 * The Claude Code plugin as users get it, for plugin tests: a marketplace
 * install fetches the npm package (an `npm` plugin source, with no build
 * step), so `installPlugin` rebuilds the plugin root in a sandbox from
 * `npm pack`'s file list (with the bundle globalSetup built), and
 * `runPluginHook` runs a command from its static hooks file the way Claude
 * Code does: exec form, `${CLAUDE_PLUGIN_ROOT}` substituted, the payload on
 * stdin, the project as cwd.
 */
import { exec, spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { EventName } from "../../../src/event";
import type { CliResult } from "./cli";
import { claudeCode, type ClaudeCodePayload } from "./payloads";
import type { Sandbox } from "./sandbox";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * A payload for every Event. A Record keyed by EventName fails typecheck when
 * an Event is added to or removed from src/event.ts, so this list (and the
 * check that hooks.json registers exactly these) can't silently drift.
 */
export const everyEvent: Record<EventName, ClaudeCodePayload> = {
  PreToolUse: claudeCode.bash("ls"),
  PostToolUse: claudeCode.postToolUse("Bash", { command: "ls" }, { stdout: "", stderr: "" }),
  UserPromptSubmit: claudeCode.userPromptSubmit("hello"),
  Stop: claudeCode.stop(),
  SubagentStop: claudeCode.subagentStop(),
  SessionStart: claudeCode.sessionStart("startup"),
  SessionEnd: { ...claudeCode.stop(), hook_event_name: "SessionEnd", reason: "exit" },
  Notification: claudeCode.notification("Claude is waiting for your input"),
  PreCompact: { ...claudeCode.stop(), hook_event_name: "PreCompact", trigger: "auto" },
};

export interface CommandHook {
  type: string;
  command: string;
  args: string[];
}
export interface MatcherGroup {
  matcher?: string;
  hooks: CommandHook[];
}
export interface HooksFile {
  hooks: Record<string, MatcherGroup[]>;
}

let packing: Promise<string[]> | undefined;

/** The files `npm publish` would ship, i.e. what an `npm` plugin source unpacks. Read once: they don't change during a run. */
function packedFiles(): Promise<string[]> {
  // Through a shell because npm is a .cmd shim on Windows; the command is a constant.
  packing ??= promisify(exec)("npm pack --dry-run --json --ignore-scripts", { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }).then(
    ({ stdout }) => {
      const [pack] = JSON.parse(stdout) as { files: { path: string }[] }[];
      return pack!.files.map((file) => file.path.replaceAll("\\", "/")).sort();
    },
  );
  return packing;
}

export interface InstalledPlugin {
  root: string;
  files: string[];
  hooksFile: HooksFile;
  /** Read a JSON file from the installed plugin. */
  json(path: string): any;
}

/** Unpack the plugin into the sandbox, as an `npm` plugin source would. */
export async function installPlugin(box: Sandbox): Promise<InstalledPlugin> {
  const files = await packedFiles();
  const root = join(box.root, "plugin");
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(root, file));
  }
  const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
  return { root, files, hooksFile: json("hooks/hooks.json") as HooksFile, json };
}

/** Spawn a program as a Host does: no shell, stdin piped and closed. */
export function spawnAsHost(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string | undefined>; stdin: string }): Promise<CliResult> {
  const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1, durationMs: performance.now() - started }));
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin);
  });
}

/** Run the installed hooks file's command for `event`, as Claude Code does in exec form. */
export function runPluginHook(box: Sandbox, plugin: InstalledPlugin, event: string, payload: ClaudeCodePayload): Promise<CliResult> {
  const [hook] = plugin.hooksFile.hooks[event]![0]!.hooks;
  const substitute = (value: string) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin.root);
  return spawnAsHost(substitute(hook!.command), hook!.args.map(substitute), {
    cwd: box.project,
    env: { ...box.env, CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PROJECT_DIR: box.project },
    stdin: JSON.stringify({ ...payload, cwd: box.project }),
  });
}
