/**
 * The Claude Code plugin (issue #14) as users get it. A marketplace install
 * fetches the npm package (an `npm` plugin source, with no build step), so
 * each test rebuilds the plugin root from `npm pack`'s file list (with the
 * bundle globalSetup built) and runs the commands in its static hooks file the
 * way Claude Code does: exec form, `${CLAUDE_PLUGIN_ROOT}` substituted, the
 * payload on stdin, the project as cwd.
 *
 * The manifests are checked as files: the marketplace, which is not in the
 * package, and `plugin.json`'s version, which must track `package.json`'s.
 */
import { exec, spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { EventName } from "../../src/event";
import { claudeCode, expectBlocked, expectNoDecision, sandbox, type CliResult, type ClaudeCodePayload, type Sandbox } from "./helpers";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const readRepoJson = (path: string) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

/**
 * A payload for every Event. A Record keyed by EventName fails typecheck when
 * an Event is added to or removed from src/event.ts, so this list (and the
 * check that hooks.json registers exactly these) can't silently drift.
 */
const everyEvent: Record<EventName, ClaudeCodePayload> = {
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

interface CommandHook {
  type: string;
  command: string;
  args: string[];
}
interface MatcherGroup {
  matcher?: string;
  hooks: CommandHook[];
}
interface HooksFile {
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

interface InstalledPlugin {
  root: string;
  files: string[];
  hooksFile: HooksFile;
  /** Read a JSON file from the installed plugin. */
  json(path: string): any;
}

/** Unpack the plugin into the sandbox, as an `npm` plugin source would. */
async function installPlugin(box: Sandbox): Promise<InstalledPlugin> {
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
function spawnAsHost(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string | undefined>; stdin: string }): Promise<CliResult> {
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
function runPluginHook(box: Sandbox, plugin: InstalledPlugin, event: string, payload: ClaudeCodePayload): Promise<CliResult> {
  const [hook] = plugin.hooksFile.hooks[event]![0]!.hooks;
  const substitute = (value: string) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin.root);
  return spawnAsHost(substitute(hook!.command), hook!.args.map(substitute), {
    cwd: box.project,
    env: { ...box.env, CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PROJECT_DIR: box.project },
    stdin: JSON.stringify({ ...payload, cwd: box.project }),
  });
}

describe("Claude Code plugin (packaged)", () => {
  it("ships the plugin manifest, hooks file and bundle, but not the marketplace", async () => {
    const { files } = await installPlugin(sandbox());
    expect(files).toEqual(expect.arrayContaining([".claude-plugin/plugin.json", "hooks/hooks.json", "dist/hardhooks.mjs"]));
    // A package with marketplace.json would be read as a marketplace, not a plugin.
    expect(files).not.toContain(".claude-plugin/marketplace.json");
  });

  it("blocks `git push --force` through the plugin's PreToolUse hook", async () => {
    const box = sandbox();
    expectBlocked(await runPluginHook(box, await installPlugin(box), "PreToolUse", claudeCode.bash("git push --force origin main")), /force/i);
  });

  it("allows `git status` through the plugin's PreToolUse hook", async () => {
    const box = sandbox();
    expectNoDecision(await runPluginHook(box, await installPlugin(box), "PreToolUse", claudeCode.bash("git status")));
  });

  describe("hooks file", () => {
    it("registers exactly the Events the library uses", async () => {
      const { hooksFile } = await installPlugin(sandbox());
      expect(Object.keys(hooksFile.hooks).sort()).toEqual(Object.keys(everyEvent).sort());
    });

    it.each(Object.keys(everyEvent) as EventName[])("runs the bundled dispatcher for %s with node in exec form", async (event) => {
      const box = sandbox();
      const plugin = await installPlugin(box);
      // One group, no matcher: the dispatcher decides which Hooks apply, so the
      // static file never has to change when config does.
      expect(plugin.hooksFile.hooks[event]).toEqual([
        {
          hooks: [
            {
              type: "command",
              command: "node",
              args: ["${CLAUDE_PLUGIN_ROOT}/dist/hardhooks.mjs", "run", event],
            },
          ],
        },
      ]);
      // Run as the Host would, the dispatcher sees this Event: audit-log (on in every Event) records it.
      box.writeUserConfig({ hooks: { "audit-log": { enabled: true } } });
      const result = await runPluginHook(box, plugin, event, everyEvent[event]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(box.auditLog().map((entry) => entry.event)).toEqual([event]);
    });

    it("never goes through npx", async () => {
      const { hooksFile } = await installPlugin(sandbox());
      expect(JSON.stringify(hooksFile)).not.toMatch(/\bnpx\b/);
    });
  });

  describe("manifests", () => {
    it("names the plugin after the npm package and tracks its version", async () => {
      const plugin = await installPlugin(sandbox());
      const pkg = plugin.json("package.json") as { name: string; version: string; license: string };
      // plugin.json's version is how installed copies detect an update.
      expect(plugin.json(".claude-plugin/plugin.json")).toMatchObject({ name: pkg.name, version: pkg.version, license: pkg.license });
    });

    it("lists the plugin with the npm package as its source", () => {
      const pkg = readRepoJson("package.json") as { name: string };
      const marketplace = readRepoJson(".claude-plugin/marketplace.json") as { plugins: { name: string; source: unknown; version?: string }[] };
      expect(marketplace.plugins).toEqual([expect.objectContaining({ name: pkg.name, source: { source: "npm", package: pkg.name } })]);
      // plugin.json owns the version; setting it in both places is a validate warning.
      expect(marketplace.plugins[0]).not.toHaveProperty("version");
    });
  });
});

// Timed runs: sequential, so the file's other (concurrent) tests don't load the machine while they measure.
describe.sequential("Events no enabled Hook handles", () => {
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

  // The static plugin hooks file runs the dispatcher on every Event, so the
  // ones with nothing to do must cost little more than starting Node. No
  // `standard` Hook handles these Events.
  it.each(["Notification", "SessionEnd", "PreCompact"] as const)(
    "`run %s` through the plugin exits 0 with no output, within 100 ms of a bare `node` start",
    async (event) => {
      const box = sandbox();
      const plugin = await installPlugin(box);
      const payload = everyEvent[event];
      const runs = 5;
      const baseline: number[] = [];
      const hardhooks: number[] = [];
      for (let i = 0; i < runs; i++) {
        const bare = await spawnAsHost("node", ["-e", ""], { cwd: box.project, env: box.env, stdin: JSON.stringify(payload) });
        baseline.push(bare.durationMs);
        const result = await runPluginHook(box, plugin, event, payload);
        expectNoDecision(result);
        expect(result.stderr).toBe("");
        hardhooks.push(result.durationMs);
      }
      // Generous bound for slow CI runners; locally the overhead is about 5 ms.
      expect(median(hardhooks) - median(baseline)).toBeLessThan(100);
    },
  );
});
