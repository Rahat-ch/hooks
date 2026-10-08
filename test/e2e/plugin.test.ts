/**
 * The Claude Code plugin (issue #14) as users get it: each test installs it
 * into its sandbox from `npm pack`'s file list and runs the commands in its
 * static hooks file as Claude Code does (`installPlugin`, `runPluginHook` in
 * helpers/plugin.ts). The overhead of Events no Hook handles is timed in
 * timing/plugin-overhead.test.ts, on a quiet machine.
 *
 * The manifests are checked as files: the marketplace, which is not in the
 * package, and `plugin.json`'s version, which must track `package.json`'s.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EventName } from "../../src/event";
import { claudeCode, everyEvent, expectBlocked, expectNoDecision, installPlugin, runPluginHook, sandbox } from "./helpers";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const readRepoJson = (path: string) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

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
