import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventName, ToolKind } from "../src/event";
import { defineHook, type Hook } from "../src/hooks/hook";
import {
  fakeBundlePath,
  fakeEnvironment,
  projectSettingsPath,
  readSettings,
  runInit,
  runTrust,
  runUninstall,
  userSettingsPath,
  writeRepoConfig,
  writeSettings,
} from "./helpers";

/** A test-only Hook; enabled under every Preset unless `enabled: false`. */
function testHook(
  name: string,
  events: EventName[],
  options: { tools?: ToolKind[]; enabled?: boolean; failMode?: "open" | "closed" } = {},
): Hook<Record<string, never>> {
  const enabled = options.enabled ?? true;
  return defineHook({
    name,
    description: "test-only Hook",
    events,
    ...(options.tools ? { tools: options.tools } : {}),
    failMode: options.failMode ?? "open",
    defaults: { standard: { enabled, options: {} }, strict: { enabled, options: {} } },
    run: () => undefined,
  });
}

const shellGuard = testHook("shell-guard", ["PreToolUse"], { tools: ["shell"], failMode: "closed" });

/** The entry init writes for one Event: `node <bundle> run <Event>` in exec form. */
function entry(bundle: string, event: string, matcher?: string) {
  return {
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: "command", command: "node", args: [bundle, "run", event] }],
  };
}

describe("hardhooks init", () => {
  it("creates the project settings file with a PreToolUse entry for the enabled Guards", async () => {
    const env = fakeEnvironment();
    const result = await runInit({ env, mode: "yes", hooks: [shellGuard] });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(readSettings(projectSettingsPath(env))).toEqual({
      hooks: { PreToolUse: [entry(fakeBundlePath(env), "PreToolUse", "Bash")] },
    });
    // A global install's path is machine-specific, which matters for a committed project file.
    expect(result.stdout).toMatch(/devDependency/);
  });

  it("writes one entry per Event, matching the union of the tools its enabled Hooks handle", async () => {
    const env = fakeEnvironment();
    const hooks = [
      shellGuard,
      testHook("file-guard", ["PreToolUse"], { tools: ["read", "edit"] }),
      testHook("formatter", ["PostToolUse"], { tools: ["edit", "write"] }),
      testHook("context", ["SessionStart"]),
      testHook("off", ["Notification"], { enabled: false }),
    ];

    await runInit({ env, mode: "yes", hooks });

    const bundle = fakeBundlePath(env);
    expect(readSettings(projectSettingsPath(env))).toEqual({
      hooks: {
        SessionStart: [entry(bundle, "SessionStart")],
        PreToolUse: [entry(bundle, "PreToolUse", "Bash|Read|Edit|MultiEdit|NotebookEdit")],
        PostToolUse: [entry(bundle, "PostToolUse", "Edit|MultiEdit|NotebookEdit|Write")],
      },
    });
  });

  it("writes no matcher when an enabled Hook on the Event handles every tool", async () => {
    const env = fakeEnvironment();

    await runInit({ env, mode: "yes", hooks: [shellGuard, testHook("auditor", ["PreToolUse", "PostToolUse"])] });

    const bundle = fakeBundlePath(env);
    expect(readSettings(projectSettingsPath(env))).toEqual({
      hooks: { PreToolUse: [entry(bundle, "PreToolUse")], PostToolUse: [entry(bundle, "PostToolUse")] },
    });
  });

  it("writes only the Events the enabled Hooks' options make active", async () => {
    const env = fakeEnvironment();
    // check alone: SubagentStop and per-edit checks are opt-in.
    writeRepoConfig(env, { preset: "standard", hooks: { check: { enabled: true }, "format-on-edit": { enabled: false } } });

    const plain = await runInit({ env, mode: "yes" });

    expect(plain.stdout).toMatch(/^ {2}Stop: check$/m);
    expect(plain.stdout).not.toMatch(/SubagentStop|PostToolUse/);
    expect(Object.keys(readSettings(projectSettingsPath(env)).hooks)).toEqual(["SessionStart", "PreToolUse", "Stop"]);

    writeRepoConfig(env, {
      hooks: { check: { enabled: true, subagentStop: true, editCommand: "eslint" }, "format-on-edit": { enabled: false } },
    });
    const optedIn = await runInit({ env, mode: "yes" });

    expect(optedIn.stdout).toMatch(/^ {2}PostToolUse \[Edit\|MultiEdit\|NotebookEdit\|Write\]: check$/m);
    expect(optedIn.stdout).toMatch(/^ {2}SubagentStop: check$/m);
    expect(Object.keys(readSettings(projectSettingsPath(env)).hooks)).toEqual([
      "SessionStart",
      "PreToolUse",
      "Stop",
      "PostToolUse",
      "SubagentStop",
    ]);
  });

  it("keeps every existing setting and non-hardhooks hook", async () => {
    const env = fakeEnvironment();
    const userGroup = { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] };
    const userStop = { hooks: [{ type: "command", command: "say done", timeout: 5 }] };
    writeSettings(projectSettingsPath(env), {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PreToolUse: [userGroup], Stop: [userStop] },
      model: "opus",
    });

    expect((await runInit({ env, mode: "yes", hooks: [shellGuard] })).exitCode).toBe(0);

    expect(readSettings(projectSettingsPath(env))).toEqual({
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PreToolUse: [userGroup, entry(fakeBundlePath(env), "PreToolUse", "Bash")], Stop: [userStop] },
      model: "opus",
    });
  });

  it("shows a diff of the settings file and asks before writing", async () => {
    const env = fakeEnvironment();
    writeSettings(projectSettingsPath(env), { model: "opus" });

    const declined = await runInit({ env, answer: false, hooks: [shellGuard] });
    expect(declined.prompts).toHaveLength(1);
    expect(declined.stdout).toContain(projectSettingsPath(env));
    expect(declined.stdout).toMatch(/^\+\s+"PreToolUse": \[$/m);
    expect(declined.stdout).toMatch(/^-\s+"model": "opus"$/m);
    expect(declined.stdout).toMatch(/^\+\s+"model": "opus",$/m);
    expect(declined.exitCode).toBe(1);
    expect(readSettings(projectSettingsPath(env))).toEqual({ model: "opus" });

    const accepted = await runInit({ env, answer: true, hooks: [shellGuard] });
    expect(accepted.prompts).toHaveLength(1);
    expect(accepted.exitCode).toBe(0);
    expect(readSettings(projectSettingsPath(env)).hooks.PreToolUse).toHaveLength(1);
  });

  it("is idempotent: re-running with no changes shows no diff and asks nothing", async () => {
    const env = fakeEnvironment();
    const userGroup = { matcher: "Edit", hooks: [{ type: "command", command: "./lint.sh" }] };
    writeSettings(projectSettingsPath(env), { hooks: { PreToolUse: [] } });
    await runInit({ env, mode: "yes", hooks: [shellGuard] });
    // The user adds their own group after ours; ours must stay where it is.
    const settings = readSettings(projectSettingsPath(env));
    settings.hooks.PreToolUse.push(userGroup);
    writeSettings(projectSettingsPath(env), settings);
    const before = readFileSync(projectSettingsPath(env), "utf8");

    const again = await runInit({ env, hooks: [shellGuard] });

    expect(again.exitCode).toBe(0);
    expect(again.prompts).toEqual([]);
    expect(again.stdout).toMatch(/up to date/i);
    expect(again.stdout).not.toMatch(/^[+-]/m);
    expect(readFileSync(projectSettingsPath(env), "utf8")).toBe(before);
  });

  it("after enabling a Hook on a new Event, re-running adds exactly that Event's entry", async () => {
    const env = fakeEnvironment();
    const checker = testHook("checker", ["Stop"], { enabled: false });
    const hooks = [shellGuard, checker];
    await runInit({ env, mode: "yes", hooks });
    const before = readSettings(projectSettingsPath(env));

    writeRepoConfig(env, { hooks: { checker: { enabled: true } } });
    const result = await runInit({ env, mode: "yes", hooks });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(projectSettingsPath(env))).toEqual({
      hooks: { ...before.hooks, Stop: [entry(fakeBundlePath(env), "Stop")] },
    });

    // And disabling it again removes exactly that entry.
    writeRepoConfig(env, { hooks: { checker: { enabled: false } } });
    await runInit({ env, mode: "yes", hooks });
    expect(readSettings(projectSettingsPath(env))).toEqual(before);
  });

  it("--dry-run prints the diff and writes nothing", async () => {
    const env = fakeEnvironment();

    const result = await runInit({ env, mode: "dry-run", hooks: [shellGuard] });

    expect(result.exitCode).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toMatch(/^\+\s+"PreToolUse": \[$/m);
    expect(result.stdout).toContain(JSON.stringify(fakeBundlePath(env)));
    expect(result.stdout).toMatch(/dry run/i);
    expect(readSettings(projectSettingsPath(env))).toBeUndefined();
  });

  it("run from a subdirectory, writes the settings file at the repository root", async () => {
    const base = fakeEnvironment();
    mkdirSync(join(base.cwd, ".git"));
    const env = { ...base, cwd: join(base.cwd, "packages", "app") };
    mkdirSync(env.cwd, { recursive: true });

    await runInit({ env, mode: "yes", hooks: [shellGuard] });

    expect(readSettings(projectSettingsPath(base)).hooks.PreToolUse).toHaveLength(1);
    expect(readSettings(projectSettingsPath(env))).toBeUndefined();
  });

  it("--user writes the user-level settings file and leaves the project alone", async () => {
    const env = fakeEnvironment();

    const result = await runInit({ env, user: true, mode: "yes", hooks: [shellGuard] });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(userSettingsPath(env))).toEqual({
      hooks: { PreToolUse: [entry(fakeBundlePath(env), "PreToolUse", "Bash")] },
    });
    expect(readSettings(projectSettingsPath(env))).toBeUndefined();
  });

  it("--user honours CLAUDE_CONFIG_DIR, where Claude Code then keeps user settings", async () => {
    const base = fakeEnvironment();
    const configDir = join(base.home, "claude-config");
    const env = { ...base, env: { ...base.env, CLAUDE_CONFIG_DIR: configDir } };

    await runInit({ env, user: true, mode: "yes", hooks: [shellGuard] });

    expect(readSettings(join(configDir, "settings.json")).hooks.PreToolUse).toHaveLength(1);
    expect(readSettings(userSettingsPath(env))).toBeUndefined();
  });

  it("writes Windows bundle paths verbatim as one exec-form argument, and recognises them as its own", async () => {
    const env = fakeEnvironment({ platform: "win32" });
    const npmGlobal = String.raw`C:\Users\Dev User\AppData\Roaming\npm\node_modules\hardhooks\dist\hardhooks.mjs`;
    const nodeDir = String.raw`C:\Program Files\nodejs\node_modules\hardhooks\dist\hardhooks.mjs`;

    await runInit({ env, mode: "yes", bundlePath: npmGlobal, hooks: [shellGuard] });
    expect(readSettings(projectSettingsPath(env))).toEqual({
      hooks: { PreToolUse: [entry(npmGlobal, "PreToolUse", "Bash")] },
    });

    // Reinstalled elsewhere: re-running init moves the entry rather than adding another.
    await runInit({ env, mode: "yes", bundlePath: nodeDir, hooks: [shellGuard] });
    expect(readSettings(projectSettingsPath(env))).toEqual({
      hooks: { PreToolUse: [entry(nodeDir, "PreToolUse", "Bash")] },
    });

    await runUninstall({ env, mode: "yes" });
    expect(readSettings(projectSettingsPath(env))).toEqual({});
  });

  it("refers to a project-local install through ${CLAUDE_PROJECT_DIR}, so the committed file works for the whole team", async () => {
    const env = fakeEnvironment();
    const local = join(env.cwd, "node_modules", "hardhooks", "dist", "hardhooks.mjs");

    await runInit({ env, mode: "yes", bundlePath: local, hooks: [shellGuard] });
    await runInit({ env, user: true, mode: "yes", bundlePath: local, hooks: [shellGuard] });

    expect(readSettings(projectSettingsPath(env))).toEqual({
      hooks: {
        PreToolUse: [entry("${CLAUDE_PROJECT_DIR}/node_modules/hardhooks/dist/hardhooks.mjs", "PreToolUse", "Bash")],
      },
    });
    // The user-level file applies to every project, so it keeps the absolute path.
    expect(readSettings(userSettingsPath(env))).toEqual({
      hooks: { PreToolUse: [entry(local, "PreToolUse", "Bash")] },
    });
  });

  describe("trust (ADR-0005)", () => {
    it("mentions `hardhooks trust` when the repo config has commands that won't run until the project is trusted", async () => {
      const env = fakeEnvironment();
      writeRepoConfig(env, { hooks: { check: { enabled: true, command: "npm run verify" } } });

      const { stdout, exitCode } = await runInit({ env, mode: "yes" });

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/check: command from \.hardhooks\.json: npm run verify[\s\S]*run `hardhooks trust`/);
    });

    it("says nothing about trust once the project is trusted, or when it has no commands", async () => {
      const plain = fakeEnvironment();
      expect((await runInit({ env: plain, mode: "yes" })).stdout).not.toMatch(/trust/);

      const trusted = fakeEnvironment();
      writeRepoConfig(trusted, { hooks: { check: { enabled: true, command: "npm run verify" } } });
      await runTrust({ env: trusted, mode: "yes" });
      expect((await runInit({ env: trusted, mode: "yes" })).stdout).not.toMatch(/trust/);
    });
  });

  it("refuses to write when the config is invalid, naming the error", async () => {
    const env = fakeEnvironment();
    writeRepoConfig(env, { hooks: { "shell-guard": { enabled: "yes" } } });

    const result = await runInit({ env, mode: "yes", hooks: [shellGuard] });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/hooks\.shell-guard\.enabled/);
    expect(readSettings(projectSettingsPath(env))).toBeUndefined();
  });

  it("refuses to touch a settings file that isn't valid JSON", async () => {
    const env = fakeEnvironment();
    writeSettings(projectSettingsPath(env), '{ "model": "opus", }');

    const result = await runInit({ env, mode: "yes", hooks: [shellGuard] });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/);
    expect(readFileSync(projectSettingsPath(env), "utf8")).toBe('{ "model": "opus", }');
  });

  it("refuses to touch a settings file whose hooks aren't in Claude Code's shape", async () => {
    const env = fakeEnvironment();
    writeSettings(projectSettingsPath(env), { hooks: { PreToolUse: "./guard.sh" } });

    const result = await runInit({ env, mode: "yes", hooks: [shellGuard] });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/hooks\.PreToolUse/);
    expect(readSettings(projectSettingsPath(env))).toEqual({ hooks: { PreToolUse: "./guard.sh" } });
  });
});

describe("hardhooks uninstall", () => {
  const original = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  };
  const hooks = [shellGuard, testHook("checker", ["Stop"]), testHook("context", ["SessionStart"])];

  it("removes only hardhooks entries, leaving everything else as it was", async () => {
    const env = fakeEnvironment();
    writeSettings(projectSettingsPath(env), original);
    await runInit({ env, mode: "yes", hooks });
    expect(readSettings(projectSettingsPath(env))).not.toEqual(original);

    const result = await runUninstall({ env, mode: "yes" });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(projectSettingsPath(env))).toEqual(original);
  });

  it("keeps a handler the user added to a hardhooks matcher group", async () => {
    const env = fakeEnvironment();
    await runInit({ env, mode: "yes", hooks: [shellGuard] });
    const settings = readSettings(projectSettingsPath(env));
    const mine = { type: "command", command: "./mine.sh" };
    settings.hooks.PreToolUse[0].hooks.push(mine);
    writeSettings(projectSettingsPath(env), settings);

    await runUninstall({ env, mode: "yes" });

    expect(readSettings(projectSettingsPath(env))).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [mine] }] },
    });
  });

  it("shows the diff and asks before removing; --user targets the user-level file", async () => {
    const env = fakeEnvironment();
    await runInit({ env, user: true, mode: "yes", hooks: [shellGuard] });
    await runInit({ env, mode: "yes", hooks: [shellGuard] });

    const declined = await runUninstall({ env, user: true, answer: false });
    expect(declined.prompts).toEqual([expect.stringContaining(userSettingsPath(env))]);
    expect(declined.stdout).toMatch(/^-\s+"PreToolUse": \[$/m);
    expect(readSettings(userSettingsPath(env)).hooks.PreToolUse).toHaveLength(1);

    await runUninstall({ env, user: true });
    expect(readSettings(userSettingsPath(env))).toEqual({});
    expect(readSettings(projectSettingsPath(env)).hooks.PreToolUse).toHaveLength(1);
  });

  it("says so and changes nothing when hardhooks isn't installed", async () => {
    const env = fakeEnvironment();
    writeSettings(projectSettingsPath(env), original);

    const result = await runUninstall({ env });

    expect(result.exitCode).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toMatch(/no hardhooks entries/i);
    expect(readSettings(projectSettingsPath(env))).toEqual(original);
  });
});
