/**
 * `hardhooks init` and `hardhooks uninstall` through the real CLI: the
 * settings files they write in the sandbox's project and home, the diff on
 * stdout, the confirmation prompt (answered on stdin), and refusals.
 *
 * Which entries init writes follows from the real Hooks and the config. The
 * entries run the bundle init itself runs from: the built bundle, outside
 * every sandbox, stands for a global install; `copyBundle` makes a
 * project-local install (`<project>/node_modules/hardhooks`) or one anywhere
 * else, run with `box.run(args, { bundle })`.
 *
 * `describe.concurrent`: vitest 4 reads `sequence.concurrent` only from the
 * root config, so the e2e project's setting doesn't make these concurrent.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundlePath, claudeCode, copyBundle, expectBlocked, sandbox, type CliResult, type Sandbox } from "./helpers";

/** How project settings refer to a project-local install's bundle. */
const projectBundle = "${CLAUDE_PROJECT_DIR}/node_modules/hardhooks/dist/hardhooks.mjs";

/** The built bundle, as the running CLI sees its own path (a global install, outside the project). */
const globalBundle = () => realpathSync(bundlePath());

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Only the shell Guards (block-destructive-shell and git-guard): one entry,
 * `PreToolUse [Bash]`. The other Hooks `standard` enables are switched off.
 */
const shellGuardsOnly = {
  hooks: { "protect-secrets": { enabled: false }, "format-on-edit": { enabled: false }, "session-context": { enabled: false } },
};

/** A sandbox whose user config enables only the shell Guards. */
function shellGuards(): Sandbox {
  const box = sandbox();
  box.writeUserConfig(shellGuardsOnly);
  return box;
}

/** Every Event, in the order init adds them. */
const allEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "PreCompact", "Stop", "SubagentStop", "SessionEnd"];

/** The entry init writes for one Event: `node <bundle> run <Event>` in exec form. */
function entry(bundle: string, event: string, matcher?: string) {
  return {
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: "command", command: "node", args: [bundle, "run", event] }],
  };
}

const projectSettings = (box: Sandbox, dir = box.project) => join(dir, ".claude", "settings.json");
const localSettings = (box: Sandbox, dir = box.project) => join(dir, ".claude", "settings.local.json");
const userSettings = (box: Sandbox) => join(box.home, ".claude", "settings.json");

/** Parse a settings file; undefined when it doesn't exist. */
function readSettings(path: string): any {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return JSON.parse(text);
}

/** Write a settings file (an object, or raw text to control formatting). */
function writeSettings(path: string, settings: object | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2) + "\n");
}

/** The confirmation questions the CLI asked on stdout. */
const prompts = (result: CliResult) => [...result.stdout.matchAll(/^(.*) \[y\/N\] $/gm)].map((match) => match[1]);

/** Install the built bundle into the project, as `npm i -D hardhooks` does. */
const installInProject = (box: Sandbox) => copyBundle(join(box.project, "node_modules", "hardhooks"));

describe.concurrent("hardhooks init", () => {
  it("creates the project settings file with a PreToolUse entry for the enabled Guards", async () => {
    const box = shellGuards();
    const result = await box.run(["init", "--yes"], { bundle: installInProject(box) });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(prompts(result)).toEqual([]);
    expect(readSettings(projectSettings(box))).toEqual({
      hooks: { PreToolUse: [entry(projectBundle, "PreToolUse", "Bash")] },
    });
  });

  for (const platform of ["darwin", "win32"] as const) {
    // Case-insensitive file systems: `cd ~/code/app` into ~/Code/App gives a cwd in another case than the bundle's.
    it.runIf(process.platform === platform)(
      `on ${platform}, recognises a project install whose path differs from the project's only in case`,
      async () => {
        const box = shellGuards();
        // Every directory upper-cased; the file name kept, since Node only loads a lower-case `.mjs` as ESM.
        const bundle = join(dirname(installInProject(box)).toUpperCase(), "hardhooks.mjs");
        const result = await box.run(["init", "--yes"], { bundle });
        expect(result.exitCode, result.stderr).toBe(0);
        expect(readSettings(projectSettings(box))).toEqual({
          hooks: { PreToolUse: [entry("${CLAUDE_PROJECT_DIR}/NODE_MODULES/HARDHOOKS/DIST/hardhooks.mjs", "PreToolUse", "Bash")] },
        });
      },
    );
  }

  describe("a bundle outside the project (global install)", () => {
    it("goes to .claude/settings.local.json, never the shared settings a team commits, and says why", async () => {
      const box = shellGuards();

      const result = await box.run(["init", "--yes"]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(readSettings(localSettings(box))).toEqual({
        hooks: { PreToolUse: [entry(globalBundle(), "PreToolUse", "Bash")] },
      });
      expect(readSettings(projectSettings(box))).toBeUndefined();
      expect(result.stdout).toContain(`Wrote ${localSettings(box)}`);
      expect(result.stdout).toMatch(/only exists on this machine[\s\S]*npm i -D hardhooks[\s\S]*npx hardhooks init/);
    });

    it("moves machine-specific entries out of the shared settings, keeping everything else there", async () => {
      const box = shellGuards();
      const userGroup = { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] };
      const legacy = "/Users/someone/.nvm/versions/node/v22/lib/node_modules/hardhooks/dist/hardhooks.mjs";
      writeSettings(projectSettings(box), {
        model: "opus",
        hooks: { PreToolUse: [userGroup, entry(legacy, "PreToolUse", "Bash")], Stop: [entry(legacy, "Stop")] },
      });

      const declined = await box.run(["init"], { stdin: "n\n" });
      expect(prompts(declined)).toEqual([`Write ${projectSettings(box)} and ${localSettings(box)}?`]);
      expect(declined.stdout).toMatch(new RegExp(`^--- ${escape(projectSettings(box))}$[\\s\\S]*^-\\s+"Stop": \\[$`, "m"));
      expect(declined.stdout).toMatch(new RegExp(`^\\+\\+\\+ ${escape(localSettings(box))}$`, "m"));

      await box.run(["init", "--yes"]);

      expect(readSettings(projectSettings(box))).toEqual({ model: "opus", hooks: { PreToolUse: [userGroup] } });
      expect(readSettings(localSettings(box))).toEqual({
        hooks: { PreToolUse: [entry(globalBundle(), "PreToolUse", "Bash")] },
      });
      expect((await box.run(["init"])).stdout).toMatch(/up to date/);
    });

    it("refuses to add a second copy beside shared entries that run the project's own install", async () => {
      const box = shellGuards();
      const shared = { hooks: { PreToolUse: [entry(projectBundle, "PreToolUse", "Bash")] } };
      writeSettings(projectSettings(box), shared);

      const result = await box.run(["init", "--yes"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/\$\{CLAUDE_PROJECT_DIR\}[\s\S]*npm install[\s\S]*npx hardhooks init/);
      expect(readSettings(projectSettings(box))).toEqual(shared);
      expect(readSettings(localSettings(box))).toBeUndefined();
    });

    it("warns when git would commit .claude/settings.local.json", async () => {
      const box = sandbox({ git: true });
      box.writeUserConfig(shellGuardsOnly);

      const exposed = await box.run(["init", "--yes"]);
      expect(exposed.stdout).toMatch(/git doesn't ignore .*settings\.local\.json/);

      box.writeFile(".gitignore", ".claude/settings.local.json\n");
      writeSettings(localSettings(box), {});
      const ignored = await box.run(["init", "--yes"]);
      expect(ignored.exitCode, ignored.stderr).toBe(0);
      expect(ignored.stdout).not.toMatch(/doesn't ignore/);
    });
  });

  it("with a project-local install, removes hardhooks entries from settings.local.json so nothing runs twice", async () => {
    const box = shellGuards();
    await box.run(["init", "--yes"]);
    expect(readSettings(localSettings(box)).hooks.PreToolUse).toHaveLength(1);

    const result = await box.run(["init", "--yes"], { bundle: installInProject(box) });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(localSettings(box))).toEqual({});
    expect(readSettings(projectSettings(box))).toEqual({
      hooks: { PreToolUse: [entry(projectBundle, "PreToolUse", "Bash")] },
    });
  });

  it("writes one entry per Event, matching the union of the tools its enabled Hooks handle", async () => {
    // standard: the shell Guards and protect-secrets (every file and shell tool) on PreToolUse,
    // format-on-edit (edit, write) on PostToolUse, session-context on SessionStart; notify (Notification) is off.
    const box = sandbox();

    const result = await box.run(["init", "--yes"]);

    const bundle = globalBundle();
    expect(readSettings(localSettings(box))).toEqual({
      hooks: {
        SessionStart: [entry(bundle, "SessionStart")],
        PreToolUse: [entry(bundle, "PreToolUse", "Bash|Read|Edit|MultiEdit|NotebookEdit|Write|Grep|Glob")],
        PostToolUse: [entry(bundle, "PostToolUse", "Edit|MultiEdit|NotebookEdit|Write")],
      },
    });
    expect(result.stdout).toMatch(/^ {2}PreToolUse \[[^\]]+\]: block-destructive-shell, git-guard, protect-secrets$/m);
  });

  it("writes no matcher when an enabled Hook on the Event handles every tool", async () => {
    // audit-log handles every tool, on every Event.
    const box = shellGuards();
    box.writeRepoConfig({ hooks: { "audit-log": { enabled: true } } });

    await box.run(["init", "--yes"]);

    const bundle = globalBundle();
    expect(readSettings(localSettings(box))).toEqual({
      hooks: Object.fromEntries(allEvents.map((event) => [event, [entry(bundle, event)]])),
    });
  });

  it("writes only the Events the enabled Hooks' options make active", async () => {
    const box = sandbox();
    // check alone: SubagentStop and per-edit checks are opt-in.
    box.writeRepoConfig({ preset: "standard", hooks: { check: { enabled: true }, "format-on-edit": { enabled: false } } });

    const plain = await box.run(["init", "--yes"]);

    expect(plain.stdout).toMatch(/^ {2}Stop: check$/m);
    expect(plain.stdout).not.toMatch(/SubagentStop|PostToolUse/);
    expect(Object.keys(readSettings(localSettings(box)).hooks)).toEqual(["SessionStart", "PreToolUse", "Stop"]);

    box.writeRepoConfig({
      hooks: { check: { enabled: true, subagentStop: true, editCommand: "eslint" }, "format-on-edit": { enabled: false } },
    });
    const optedIn = await box.run(["init", "--yes"]);

    expect(optedIn.stdout).toMatch(/^ {2}PostToolUse \[Edit\|MultiEdit\|NotebookEdit\|Write\]: check$/m);
    expect(optedIn.stdout).toMatch(/^ {2}SubagentStop: check$/m);
    expect(Object.keys(readSettings(localSettings(box)).hooks)).toEqual([
      "SessionStart",
      "PreToolUse",
      "Stop",
      "PostToolUse",
      "SubagentStop",
    ]);
  });

  it("keeps every existing setting and non-hardhooks hook", async () => {
    const box = shellGuards();
    const userGroup = { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] };
    const userStop = { hooks: [{ type: "command", command: "say done", timeout: 5 }] };
    writeSettings(localSettings(box), {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PreToolUse: [userGroup], Stop: [userStop] },
      model: "opus",
    });

    expect((await box.run(["init", "--yes"])).exitCode).toBe(0);

    expect(readSettings(localSettings(box))).toEqual({
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PreToolUse: [userGroup, entry(globalBundle(), "PreToolUse", "Bash")], Stop: [userStop] },
      model: "opus",
    });
  });

  it("shows a diff of the settings file and asks before writing", async () => {
    const box = shellGuards();
    writeSettings(localSettings(box), { model: "opus" });

    const declined = await box.run(["init"], { stdin: "n\n" });
    expect(prompts(declined)).toHaveLength(1);
    expect(declined.stdout).toContain(localSettings(box));
    expect(declined.stdout).toMatch(/^\+\s+"PreToolUse": \[$/m);
    expect(declined.stdout).toMatch(/^-\s+"model": "opus"$/m);
    expect(declined.stdout).toMatch(/^\+\s+"model": "opus",$/m);
    expect(declined.exitCode).toBe(1);
    expect(readSettings(localSettings(box))).toEqual({ model: "opus" });

    const accepted = await box.run(["init"], { stdin: "y\n" });
    expect(prompts(accepted)).toHaveLength(1);
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(readSettings(localSettings(box)).hooks.PreToolUse).toHaveLength(1);
  });

  it("is idempotent: re-running with no changes shows no diff and asks nothing", async () => {
    const box = shellGuards();
    const userGroup = { matcher: "Edit", hooks: [{ type: "command", command: "./lint.sh" }] };
    writeSettings(localSettings(box), { hooks: { PreToolUse: [] } });
    await box.run(["init", "--yes"]);
    // The user adds their own group after ours; ours must stay where it is.
    const settings = readSettings(localSettings(box));
    settings.hooks.PreToolUse.push(userGroup);
    writeSettings(localSettings(box), settings);
    const before = readFileSync(localSettings(box), "utf8");

    const again = await box.run(["init"], { stdin: "y\n" });

    expect(again.exitCode).toBe(0);
    expect(prompts(again)).toEqual([]);
    expect(again.stdout).toMatch(/up to date/i);
    expect(again.stdout).not.toMatch(/^[+-]/m);
    expect(readFileSync(localSettings(box), "utf8")).toBe(before);
  });

  it("after enabling a Hook on a new Event, re-running adds exactly that Event's entry", async () => {
    // check (Stop) is off under standard.
    const box = shellGuards();
    await box.run(["init", "--yes"]);
    const before = readSettings(localSettings(box));

    box.writeRepoConfig({ hooks: { check: { enabled: true } } });
    const result = await box.run(["init", "--yes"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(localSettings(box))).toEqual({
      hooks: { ...before.hooks, Stop: [entry(globalBundle(), "Stop")] },
    });

    // And disabling it again removes exactly that entry.
    box.writeRepoConfig({ hooks: { check: { enabled: false } } });
    await box.run(["init", "--yes"]);
    expect(readSettings(localSettings(box))).toEqual(before);
  });

  it("--dry-run prints the diff and writes nothing", async () => {
    const box = shellGuards();

    const result = await box.run(["init", "--dry-run"], { stdin: "y\n" });

    expect(result.exitCode).toBe(0);
    expect(prompts(result)).toEqual([]);
    expect(result.stdout).toMatch(/^\+\s+"PreToolUse": \[$/m);
    expect(result.stdout).toContain(JSON.stringify(globalBundle()));
    expect(result.stdout).toMatch(/dry run/i);
    expect(readSettings(projectSettings(box))).toBeUndefined();
    expect(readSettings(localSettings(box))).toBeUndefined();
  });

  it("run from a subdirectory, writes the settings file at the repository root", async () => {
    const box = sandbox({ git: true });
    box.writeUserConfig(shellGuardsOnly);
    const sub = join(box.project, "packages", "app");
    mkdirSync(sub, { recursive: true });

    const result = await box.run(["init", "--yes"], { cwd: sub });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(localSettings(box)).hooks.PreToolUse).toHaveLength(1);
    expect(readSettings(localSettings(box, sub))).toBeUndefined();
  });

  it("--user writes the user-level settings file and leaves the project alone", async () => {
    const box = shellGuards();

    const result = await box.run(["init", "--user", "--yes"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(userSettings(box))).toEqual({
      hooks: { PreToolUse: [entry(globalBundle(), "PreToolUse", "Bash")] },
    });
    expect(readSettings(projectSettings(box))).toBeUndefined();
    expect(readSettings(localSettings(box))).toBeUndefined();
  });

  it("--user honours CLAUDE_CONFIG_DIR, where Claude Code then keeps user settings", async () => {
    const box = shellGuards();
    const configDir = join(box.home, "claude-config");

    const result = await box.run(["init", "--user", "--yes"], { env: { CLAUDE_CONFIG_DIR: configDir } });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(join(configDir, "settings.json")).hooks.PreToolUse).toHaveLength(1);
    expect(readSettings(userSettings(box))).toBeUndefined();
  });

  // On Windows these are the real spellings (`C:\Users\Dev User\...`, `C:\Program Files\...`); elsewhere POSIX paths with spaces.
  it("writes bundle paths with spaces verbatim as one exec-form argument, and recognises them as its own", async () => {
    const box = shellGuards();
    const npmGlobal = copyBundle(join(box.root, "Dev User", "AppData", "Roaming", "npm", "node_modules", "hardhooks"));
    const nodeDir = copyBundle(join(box.root, "Program Files", "nodejs", "node_modules", "hardhooks"));

    expect((await box.run(["init", "--yes"], { bundle: npmGlobal })).exitCode).toBe(0);
    expect(readSettings(localSettings(box))).toEqual({
      hooks: { PreToolUse: [entry(npmGlobal, "PreToolUse", "Bash")] },
    });

    // Reinstalled elsewhere: re-running init moves the entry rather than adding another.
    expect((await box.run(["init", "--yes"], { bundle: nodeDir })).exitCode).toBe(0);
    expect(readSettings(localSettings(box))).toEqual({
      hooks: { PreToolUse: [entry(nodeDir, "PreToolUse", "Bash")] },
    });

    expect((await box.run(["uninstall", "--yes"], { bundle: nodeDir })).exitCode).toBe(0);
    expect(readSettings(localSettings(box))).toEqual({});
  });

  it("refers to a project-local install through ${CLAUDE_PROJECT_DIR}, so the committed file works for the whole team", async () => {
    const box = shellGuards();
    const local = installInProject(box);

    await box.run(["init", "--yes"], { bundle: local });
    await box.run(["init", "--user", "--yes"], { bundle: local });

    expect(readSettings(projectSettings(box))).toEqual({
      hooks: {
        PreToolUse: [entry("${CLAUDE_PROJECT_DIR}/node_modules/hardhooks/dist/hardhooks.mjs", "PreToolUse", "Bash")],
      },
    });
    // The user-level file applies to every project, so it keeps the absolute path.
    expect(readSettings(userSettings(box))).toEqual({
      hooks: { PreToolUse: [entry(local, "PreToolUse", "Bash")] },
    });
  });

  it("writes an entry the Host can run as written, and `uninstall` removes it", async () => {
    // Was test/smoke/cli.test.ts: default config, answered on stdin, then the written command run without a shell.
    const box = sandbox();
    const settingsFile = localSettings(box);

    const declined = await box.run(["init"], { stdin: "n\n" });
    expect(declined.stdout).toMatch(/^\+.*"PreToolUse"/m);
    expect(readSettings(settingsFile)).toBeUndefined();

    const accepted = await box.run(["init"], { stdin: "y\n" });
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    const [group] = readSettings(settingsFile).hooks.PreToolUse;
    expect(group.matcher).toContain("Bash");
    const [handler] = group.hooks;
    expect(handler).toEqual({ type: "command", command: "node", args: [globalBundle(), "run", "PreToolUse"] });

    // Exec form, as the Host runs it: `node` from PATH, no shell.
    const forcePush = spawnSync(handler.command, handler.args, {
      input: JSON.stringify({ ...claudeCode.bash("git push --force origin main"), cwd: box.project }),
      encoding: "utf8",
      cwd: box.project,
      env: box.env as NodeJS.ProcessEnv,
    });
    expectBlocked({ stdout: forcePush.stdout, stderr: forcePush.stderr, exitCode: forcePush.status ?? -1 }, /force/i);

    const removed = await box.run(["uninstall", "--yes"]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(readSettings(settingsFile)).toEqual({});
  });

  describe("trust (ADR-0005)", () => {
    it("mentions `hardhooks trust` when the repo config has commands that won't run until the project is trusted", async () => {
      const box = sandbox();
      box.writeRepoConfig({ hooks: { check: { enabled: true, command: "npm run verify" } } });

      const { stdout, exitCode } = await box.run(["init", "--yes"]);

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/check: command from \.hardhooks\.json: npm run verify[\s\S]*run `hardhooks trust`/);
    });

    it("says nothing about trust once the project is trusted, or when it has no commands", async () => {
      const plain = sandbox();
      expect((await plain.run(["init", "--yes"])).stdout).not.toMatch(/trust/);

      const trusted = sandbox();
      trusted.writeRepoConfig({ hooks: { check: { enabled: true, command: "npm run verify" } } });
      await trusted.trust();
      expect((await trusted.run(["init", "--yes"])).stdout).not.toMatch(/trust/);
    });
  });

  it("refuses to write when the config is invalid, naming the error", async () => {
    const box = sandbox();
    box.writeRepoConfig({ hooks: { "git-guard": { enabled: "yes" } } });

    const result = await box.run(["init", "--yes"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/hooks\.git-guard\.enabled/);
    expect(readSettings(projectSettings(box))).toBeUndefined();
    expect(readSettings(localSettings(box))).toBeUndefined();
  });

  it("refuses to touch a settings file that isn't valid JSON", async () => {
    const box = shellGuards();
    writeSettings(projectSettings(box), '{ "model": "opus", }');

    const result = await box.run(["init", "--yes"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/);
    expect(readFileSync(projectSettings(box), "utf8")).toBe('{ "model": "opus", }');
  });

  it("refuses to touch a settings file whose hooks aren't in Claude Code's shape", async () => {
    const box = shellGuards();
    writeSettings(projectSettings(box), { hooks: { PreToolUse: "./guard.sh" } });

    const result = await box.run(["init", "--yes"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/hooks\.PreToolUse/);
    expect(readSettings(projectSettings(box))).toEqual({ hooks: { PreToolUse: "./guard.sh" } });
  });
});

describe.concurrent("hardhooks uninstall", () => {
  const original = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  };

  it("removes only hardhooks entries, leaving everything else as it was", async () => {
    // standard plus check: entries on SessionStart, PreToolUse, PostToolUse and Stop (beside the user's).
    const box = sandbox();
    box.writeRepoConfig({ hooks: { check: { enabled: true } } });
    writeSettings(localSettings(box), original);
    await box.run(["init", "--yes"]);
    expect(Object.keys(readSettings(localSettings(box)).hooks)).toEqual(["PreToolUse", "Stop", "SessionStart", "PostToolUse"]);

    const result = await box.run(["uninstall", "--yes"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(localSettings(box))).toEqual(original);
  });

  it("removes hardhooks entries from both the shared and the per-machine project settings", async () => {
    const box = sandbox();
    writeSettings(projectSettings(box), { ...original, hooks: { ...original.hooks, Stop: [...original.hooks.Stop, entry(projectBundle, "Stop")] } });
    writeSettings(localSettings(box), { hooks: { PreToolUse: [entry(globalBundle(), "PreToolUse", "Bash")] } });

    const result = await box.run(["uninstall", "--yes"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readSettings(projectSettings(box))).toEqual(original);
    expect(readSettings(localSettings(box))).toEqual({});
  });

  it("keeps a handler the user added to a hardhooks matcher group", async () => {
    const box = shellGuards();
    await box.run(["init", "--yes"]);
    const settings = readSettings(localSettings(box));
    const mine = { type: "command", command: "./mine.sh" };
    settings.hooks.PreToolUse[0].hooks.push(mine);
    writeSettings(localSettings(box), settings);

    await box.run(["uninstall", "--yes"]);

    expect(readSettings(localSettings(box))).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [mine] }] },
    });
  });

  it("shows the diff and asks before removing; --user targets the user-level file", async () => {
    const box = shellGuards();
    await box.run(["init", "--user", "--yes"]);
    await box.run(["init", "--yes"]);

    const declined = await box.run(["uninstall", "--user"], { stdin: "n\n" });
    expect(prompts(declined)).toEqual([expect.stringContaining(userSettings(box))]);
    expect(declined.stdout).toMatch(/^-\s+"PreToolUse": \[$/m);
    expect(readSettings(userSettings(box)).hooks.PreToolUse).toHaveLength(1);

    const accepted = await box.run(["uninstall", "--user"], { stdin: "y\n" });
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(readSettings(userSettings(box))).toEqual({});
    expect(readSettings(localSettings(box)).hooks.PreToolUse).toHaveLength(1);
  });

  it("says so and changes nothing when hardhooks isn't installed", async () => {
    const box = sandbox();
    writeSettings(projectSettings(box), original);

    const result = await box.run(["uninstall"], { stdin: "y\n" });

    expect(result.exitCode).toBe(0);
    expect(prompts(result)).toEqual([]);
    expect(result.stdout).toMatch(/no hardhooks entries/i);
    expect(readSettings(projectSettings(box))).toEqual(original);
  });
});
