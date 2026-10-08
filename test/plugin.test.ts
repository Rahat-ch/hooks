/**
 * The Claude Code plugin (issue #14): the repo root is the plugin root, and
 * the npm package is what a marketplace install fetches. These tests check the
 * static plugin files against the library; `test/smoke/plugin.test.ts` runs
 * the packaged plugin for real.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EventName } from "../src/event";

const root = new URL("../", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

// A Record keyed by EventName fails typecheck when an Event is added or
// removed, so this list can't silently drift from src/event.ts.
const everyEvent: Record<EventName, true> = {
  PreToolUse: true,
  PostToolUse: true,
  UserPromptSubmit: true,
  Stop: true,
  SubagentStop: true,
  SessionStart: true,
  SessionEnd: true,
  Notification: true,
  PreCompact: true,
};

interface CommandHook {
  type: string;
  command: string;
  args?: string[];
}
interface MatcherGroup {
  matcher?: string;
  hooks: CommandHook[];
}

describe("plugin hooks file", () => {
  const hooksFile = readJson("hooks/hooks.json") as { hooks: Record<string, MatcherGroup[]> };

  it("registers exactly the Events the library uses", () => {
    expect(Object.keys(hooksFile.hooks).sort()).toEqual(Object.keys(everyEvent).sort());
  });

  it.each(Object.keys(everyEvent))("runs the bundled dispatcher for %s with node in exec form", (event) => {
    // One group, no matcher: the dispatcher decides which Hooks apply, so the
    // static file never has to change when config does.
    expect(hooksFile.hooks[event]).toEqual([
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
  });

  it("never goes through npx", () => {
    expect(JSON.stringify(hooksFile)).not.toMatch(/\bnpx\b/);
  });
});

describe("plugin and marketplace manifests", () => {
  const pkg = readJson("package.json") as { name: string; version: string; license: string };
  const plugin = readJson(".claude-plugin/plugin.json") as Record<string, unknown>;
  const marketplace = readJson(".claude-plugin/marketplace.json") as {
    plugins: { name: string; source: unknown; version?: string }[];
  };

  it("names the plugin after the npm package and tracks its version", () => {
    // plugin.json's version is how installed copies detect an update.
    expect(plugin).toMatchObject({ name: pkg.name, version: pkg.version, license: pkg.license });
  });

  it("lists the plugin with the npm package as its source", () => {
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: pkg.name, source: { source: "npm", package: pkg.name } }),
    ]);
    // plugin.json owns the version; setting it in both places is a validate warning.
    expect(marketplace.plugins[0]).not.toHaveProperty("version");
  });
});
