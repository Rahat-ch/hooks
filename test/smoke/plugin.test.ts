/**
 * The Claude Code plugin as users get it. A marketplace install fetches the
 * npm package (an `npm` plugin source, with no build step), so these tests
 * rebuild the plugin root from `npm pack`'s file list and run the commands in
 * its static hooks file the way Claude Code would. Requires `npm run build`.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { claudeCode, expectBlocked, expectNoDecision } from "../helpers";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

interface CommandHook {
  command: string;
  args: string[];
}

/** The files `npm publish` would ship, i.e. what an `npm` plugin source unpacks. */
function packedFiles(): string[] {
  // shell: npm is a .cmd shim on Windows. The arguments are constants.
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
  });
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`);
  const [pack] = JSON.parse(result.stdout) as { files: { path: string }[] }[];
  return pack!.files.map((file) => file.path.replaceAll("\\", "/")).sort();
}

describe("Claude Code plugin (packaged)", () => {
  let files: string[];
  let pluginRoot: string;
  let projectDir: string;

  /** Run the hooks file's command for `event` with stdin, as Claude Code does in exec form. */
  function runPluginHook(event: string, stdin: string) {
    const hooksFile = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8")) as {
      hooks: Record<string, { hooks: CommandHook[] }[]>;
    };
    const [hook] = hooksFile.hooks[event]![0]!.hooks;
    const substitute = (value: string) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
    const result = spawnSync(substitute(hook!.command), hook!.args.map(substitute), {
      cwd: projectDir,
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: projectDir },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? -1 };
  }

  beforeAll(() => {
    files = packedFiles();
    const tmp = mkdtempSync(join(tmpdir(), "hardhooks-plugin-"));
    pluginRoot = join(tmp, "plugin");
    projectDir = join(tmp, "project");
    mkdirSync(projectDir, { recursive: true });
    for (const file of files) {
      mkdirSync(dirname(join(pluginRoot, file)), { recursive: true });
      cpSync(join(repoRoot, file), join(pluginRoot, file));
    }
    return () => rmSync(tmp, { recursive: true, force: true });
  });

  it("ships the plugin manifest, hooks file and bundle, but not the marketplace", () => {
    expect(files).toEqual(
      expect.arrayContaining([".claude-plugin/plugin.json", "hooks/hooks.json", "dist/hardhooks.mjs"]),
    );
    // A package with marketplace.json would be read as a marketplace, not a plugin.
    expect(files).not.toContain(".claude-plugin/marketplace.json");
  });

  it("blocks `git push --force` through the plugin's PreToolUse hook", () => {
    const payload = claudeCode.bash("git push --force origin main", { cwd: projectDir });
    expectBlocked(runPluginHook("PreToolUse", JSON.stringify(payload)), /force/i);
  });

  it("allows `git status` through the plugin's PreToolUse hook", () => {
    const payload = claudeCode.bash("git status", { cwd: projectDir });
    expectNoDecision(runPluginHook("PreToolUse", JSON.stringify(payload)));
  });
});

describe("Events no enabled Hook handles", () => {
  const bundle = join(repoRoot, "dist/hardhooks.mjs");

  function timeSpawn(args: string[], stdin: string) {
    const start = performance.now();
    const result = spawnSync(process.execPath, args, { input: stdin, encoding: "utf8" });
    return { ms: performance.now() - start, stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? -1 };
  }

  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

  // The static plugin hooks file runs the dispatcher on every Event, so the
  // ones with nothing to do must cost little more than starting Node. No
  // `standard` Hook handles these Events.
  it.each([
    ["Notification", claudeCode.notification("Claude is waiting for your input")],
    ["SessionEnd", { ...claudeCode.stop(), hook_event_name: "SessionEnd", reason: "exit" }],
    ["PreCompact", { ...claudeCode.stop(), hook_event_name: "PreCompact", trigger: "auto" }],
  ])("`run %s` exits 0 with no output, within 100 ms of a bare `node` start", (event, payload) => {
    const stdin = JSON.stringify(payload);
    const runs = 5;
    const baseline: number[] = [];
    const hardhooks: number[] = [];
    for (let i = 0; i < runs; i++) {
      baseline.push(timeSpawn(["-e", ""], stdin).ms);
      const result = timeSpawn([bundle, "run", event], stdin);
      expectNoDecision(result);
      expect(result.stderr).toBe("");
      hardhooks.push(result.ms);
    }
    // Generous bound for slow CI runners; locally the overhead is about 5 ms.
    expect(median(hardhooks) - median(baseline)).toBeLessThan(100);
  });
});
