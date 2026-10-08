import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as s from "../src/config/schema";
import { addContext } from "../src/decision";
import { defineHook } from "../src/hooks/hook";
import { gitGuard } from "../src/hooks/git-guard";
import {
  claudeCode,
  expectBlocked,
  expectNoDecision,
  fakeEnvironment,
  observe,
  runEvent,
  writeRepoConfig,
  writeUserConfig,
} from "./helpers";
import type { HostResult } from "../src/dispatcher";

const forcePush = claudeCode.bash("git push --force origin main");

/** Off under `standard`, on under `strict`; reports its resolved options as context. */
const greeter = defineHook({
  name: "greeter",
  description: "test-only Hook",
  events: ["SessionStart"],
  failMode: "open",
  optionsSchema: s.object({
    greeting: s.string(),
    names: s.array(s.string()),
  }),
  defaults: {
    standard: { enabled: false, options: { greeting: "hi", names: [] } },
    strict: { enabled: true, options: { greeting: "HELLO", names: ["strict"] } },
  },
  run: (_event, options) => addContext(JSON.stringify(options)),
});

const hooks = [gitGuard, greeter];
const sessionStart = claudeCode.sessionStart("startup");

/** The options `greeter` ran with, or undefined if it didn't run. */
function greeterOptions(result: HostResult): unknown {
  expect(result.exitCode, result.stderr).toBe(0);
  const context = observe(result).context;
  return context === undefined ? undefined : JSON.parse(context);
}

describe("config", () => {
  it("with no config files, `standard` applies and git-guard is enabled", async () => {
    expectBlocked(await runEvent(forcePush), /force/i);
    expect(greeterOptions(await runEvent(sessionStart, { hooks }))).toBeUndefined();
  });

  it("disabling git-guard in .hardhooks.json allows `git push --force`", async () => {
    const env = fakeEnvironment();
    writeRepoConfig(env, { hooks: { "git-guard": { enabled: false } } });
    expectNoDecision(await runEvent(forcePush, { env }));
  });

  it("`preset: strict` switches every Hook to its strict defaults", async () => {
    const env = fakeEnvironment();
    writeRepoConfig(env, { preset: "strict" });
    expect(greeterOptions(await runEvent(sessionStart, { env, hooks }))).toEqual({
      greeting: "HELLO",
      names: ["strict"],
    });
  });

  it("per-Hook overrides still apply on top of `strict`", async () => {
    const env = fakeEnvironment();
    writeRepoConfig(env, { preset: "strict", hooks: { greeter: { greeting: "yo" }, "git-guard": { enabled: false } } });
    expect(greeterOptions(await runEvent(sessionStart, { env, hooks }))).toEqual({ greeting: "yo", names: ["strict"] });
    expectNoDecision(await runEvent(forcePush, { env, hooks }));
  });

  it("enables an opt-in Hook under `standard` with its standard options", async () => {
    const env = fakeEnvironment();
    writeRepoConfig(env, { hooks: { greeter: { enabled: true } } });
    expect(greeterOptions(await runEvent(sessionStart, { env, hooks }))).toEqual({ greeting: "hi", names: [] });
  });

  describe("user config", () => {
    it("is merged under the repo config: repo values win, the rest of the user config still applies", async () => {
      const env = fakeEnvironment();
      writeUserConfig(env, {
        preset: "strict",
        hooks: { greeter: { greeting: "from user", names: ["user"] }, "git-guard": { enabled: false } },
      });
      writeRepoConfig(env, { hooks: { greeter: { greeting: "from repo" }, "git-guard": { enabled: true } } });
      expect(greeterOptions(await runEvent(sessionStart, { env, hooks }))).toEqual({
        greeting: "from repo",
        names: ["user"],
      });
      expectBlocked(await runEvent(forcePush, { env, hooks }), /force/i);
    });

    it("applies on its own when the repo has no config", async () => {
      const env = fakeEnvironment();
      writeUserConfig(env, { hooks: { "git-guard": { enabled: false } } });
      expectNoDecision(await runEvent(forcePush, { env }));
    });

    it("a repo `preset` wins over the user's", async () => {
      const env = fakeEnvironment();
      writeUserConfig(env, { preset: "strict" });
      writeRepoConfig(env, { preset: "standard" });
      expect(greeterOptions(await runEvent(sessionStart, { env, hooks }))).toBeUndefined();
    });

    const disableGitGuard = JSON.stringify({ hooks: { "git-guard": { enabled: false } } });
    it.each([
      { platform: "linux", env: {}, path: [".config", "hardhooks", "config.json"] },
      { platform: "darwin", env: {}, path: [".config", "hardhooks", "config.json"] },
      { platform: "linux", env: { XDG_CONFIG_HOME: "xdg" }, path: ["xdg", "hardhooks", "config.json"] },
      { platform: "darwin", env: { XDG_CONFIG_HOME: "xdg" }, path: ["xdg", "hardhooks", "config.json"] },
      { platform: "win32", env: { APPDATA: "Roaming" }, path: ["Roaming", "hardhooks", "config.json"] },
      { platform: "win32", env: {}, path: ["AppData", "Roaming", "hardhooks", "config.json"] },
    ] as const)("on $platform with $env lives at ~/$path", async ({ platform, env: vars, path }) => {
      const base = fakeEnvironment({ platform });
      // Directories in env vars are placed under the fake home.
      const absolute = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, join(base.home, v)]));
      const env = { ...base, env: { ...base.env, ...absolute } };
      const file = join(env.home, ...path);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, disableGitGuard);
      expectNoDecision(await runEvent(forcePush, { env }));
    });
  });

  describe("repo config", () => {
    it("is found from a subdirectory of the repo", async () => {
      const root = fakeEnvironment();
      writeRepoConfig(root, { hooks: { "git-guard": { enabled: false } } });
      mkdirSync(join(root.cwd, ".git"));
      const sub = join(root.cwd, "packages", "app");
      mkdirSync(sub, { recursive: true });
      expectNoDecision(await runEvent(forcePush, { env: { ...root, cwd: sub } }));
    });

    it("is not looked for above the repository root", async () => {
      const outer = fakeEnvironment();
      writeRepoConfig(outer, { hooks: { "git-guard": { enabled: false } } });
      const repo = join(outer.cwd, "nested-repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      expectBlocked(await runEvent(forcePush, { env: { ...outer, cwd: repo } }), /force/i);
    });
  });

  describe("an invalid config", () => {
    it.each([
      { problem: "a wrong type", config: { hooks: { "git-guard": { enabled: "no" } } }, path: "hooks.git-guard.enabled", message: /expected a boolean, got a string \("no"\)/ },
      { problem: "an unknown top-level key", config: { presets: "strict" }, path: "presets", message: /unknown key "presets"/ },
      { problem: "an unknown Hook", config: { hooks: { "git-gaurd": { enabled: false } } }, path: "hooks.git-gaurd", message: /unknown Hook "git-gaurd" \(known Hooks: git-guard, greeter\)/ },
      { problem: "an unknown option", config: { hooks: { greeter: { greting: "x" } } }, path: "hooks.greeter.greting", message: /unknown option "greting" for Hook "greeter"/ },
      { problem: "a wrong option type", config: { hooks: { greeter: { names: "bob" } } }, path: "hooks.greeter.names", message: /expected an array/ },
      { problem: "a wrong array item", config: { hooks: { greeter: { names: ["ok", 7] } } }, path: "hooks.greeter.names[1]", message: /expected a string, got a number \(7\)/ },
      { problem: "an unknown preset", config: { preset: "paranoid" }, path: "preset", message: /expected one of "standard", "strict"/ },
      { problem: "a non-object", config: "[]", path: "(top level)", message: /expected an object, got an array/ },
    ])("with $problem blocks PreToolUse(Bash), naming file, path and problem", async ({ config, path, message }) => {
      const env = fakeEnvironment();
      const file = writeRepoConfig(env, config);
      const { reason } = expectBlocked(await runEvent(claudeCode.bash("ls"), { env, hooks }), /config is invalid/);
      expect(reason).toContain(`${file}: ${path}: `);
      expect(reason).toMatch(message);
    });

    it("that isn't JSON blocks, naming the file", async () => {
      const env = fakeEnvironment();
      const file = writeRepoConfig(env, '{ "preset": "strict", }');
      const { reason } = expectBlocked(await runEvent(claudeCode.bash("ls"), { env, hooks }));
      expect(reason).toContain(`${file}: invalid JSON`);
    });

    it("blocks even when it tries to disable the Guard", async () => {
      const env = fakeEnvironment();
      writeRepoConfig(env, { hooks: { "git-guard": { enabled: false, typo: true } } });
      expectBlocked(await runEvent(forcePush, { env, hooks }), /hooks\.git-guard\.typo/);
    });

    it("in the user config blocks too, naming the user config file", async () => {
      const env = fakeEnvironment({ platform: "linux" });
      const file = writeUserConfig(env, { hooks: { "git-guard": { enabled: 1 } } });
      writeRepoConfig(env, { hooks: { "git-guard": { enabled: true } } });
      const { reason } = expectBlocked(await runEvent(claudeCode.bash("ls"), { env, hooks }));
      expect(reason).toContain(`${file}: hooks.git-guard.enabled: expected a boolean`);
    });

    it("reports every problem in both files", async () => {
      const env = fakeEnvironment({ platform: "linux" });
      writeUserConfig(env, { nope: 1 });
      writeRepoConfig(env, { preset: 1, hooks: { greeter: { greeting: 2 } } });
      const { reason } = expectBlocked(await runEvent(claudeCode.bash("ls"), { env, hooks }));
      expect(reason).toMatch(/nope[\s\S]*preset[\s\S]*hooks\.greeter\.greeting/);
    });

    it("allows Events and tools no Guard handles, reporting the error on stderr", async () => {
      const env = fakeEnvironment();
      writeRepoConfig(env, { preset: "strict", hooks: { "git-guard": { enabled: "yes" } } });
      for (const payload of [
        claudeCode.sessionStart("startup"),
        claudeCode.notification("idle"),
        claudeCode.preToolUse("Write", { file_path: "a.ts", content: "" }),
      ]) {
        const result = await runEvent(payload, { env, hooks });
        expectNoDecision(result);
        expect(result.stderr).toMatch(/invalid config[\s\S]*hooks\.git-guard\.enabled/);
      }
    });

    it("blocks a Guard's Event even when the payload is unreadable", async () => {
      const env = fakeEnvironment();
      writeRepoConfig(env, { preset: 3 });
      expectBlocked(await runEvent("{not json", { env, hooks, event: "PreToolUse" }), /config is invalid/);
    });
  });
});
