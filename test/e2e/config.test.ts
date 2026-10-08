/**
 * Config loading through the real CLI: Presets, per-Hook overrides, the user
 * config under the repo config, where each file is looked for, and invalid
 * configs failing closed (ADR-0004). Resolved options are observed through
 * what real Hooks do with them: git-guard's protected branches,
 * block-destructive-shell's `askDynamicCommands`, session-context's `files`
 * and `commands`, and whether audit-log (opt-in) writes entries.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCode, expectAsked, expectBlocked, expectContext, expectNoDecision, sandbox, type Sandbox } from "./helpers";

const forcePush = claudeCode.bash("git push --force origin main");
/** Blocked only where `main` is a protected branch (strict). */
const pushMain = claudeCode.bash("git push origin main");
/** Asked only with `askDynamicCommands` (strict). */
const dynamic = claudeCode.bash('bash -c "$CMD"');
const sessionStart = claudeCode.sessionStart("startup");

/** Whether audit-log (off under standard, on under strict) ran: it writes one entry per Event. */
async function auditLogRan(box: Sandbox): Promise<boolean> {
  const before = box.auditLog().length;
  await box.event(claudeCode.notification("idle"));
  return box.auditLog().length > before;
}

/** A project with `notes/<name>.md` files whose contents are their names. */
function withNotes(box: Sandbox, ...names: string[]): Sandbox {
  for (const name of names) box.writeFile(`notes/${name}.md`, `${name} notes`);
  return box;
}

const knownHooks = "audit-log, block-destructive-shell, check, format-on-edit, git-guard, notify, protect-secrets, session-context";

describe("config", () => {
  it("with no config files, `standard` applies and git-guard is enabled", async () => {
    const box = sandbox();
    expectBlocked(await box.event(forcePush), /force/i);
    expectNoDecision(await box.event(pushMain));
    expectNoDecision(await box.event(dynamic));
    expect(await auditLogRan(box)).toBe(false);
  });

  it("disabling git-guard in .hardhooks.json allows `git push --force`", async () => {
    const box = sandbox();
    box.writeRepoConfig({ hooks: { "git-guard": { enabled: false } } });
    expectNoDecision(await box.event(forcePush));
  });

  it("`preset: strict` switches every Hook to its strict defaults", async () => {
    const box = sandbox();
    box.writeRepoConfig({ preset: "strict" });
    expectBlocked(await box.event(pushMain), /main/);
    expectAsked(await box.event(dynamic));
    expect(await auditLogRan(box)).toBe(true);
  });

  it("per-Hook overrides still apply on top of `strict`", async () => {
    const box = sandbox();
    box.writeRepoConfig({
      preset: "strict",
      hooks: { "block-destructive-shell": { askDynamicCommands: false }, "git-guard": { enabled: false } },
    });
    expectNoDecision(await box.event(dynamic));
    expectNoDecision(await box.event(forcePush));
    // The rest of strict still applies.
    expect(await auditLogRan(box)).toBe(true);
  });

  it("enables an opt-in Hook under `standard`", async () => {
    // Opt-in Hooks have the same options under both Presets, so only enabling is observable.
    const box = sandbox();
    box.writeRepoConfig({ hooks: { "audit-log": { enabled: true } } });
    expect(await auditLogRan(box)).toBe(true);
    expectNoDecision(await box.event(pushMain));
  });

  describe("user config", () => {
    it("is merged under the repo config: repo values win, the rest of the user config still applies", async () => {
      const box = withNotes(sandbox(), "user", "repo");
      box.writeUserConfig({
        preset: "strict",
        hooks: {
          "session-context": { files: ["notes/user.md"], commands: [["node", "-e", "console.log('from the user config')"]] },
          "git-guard": { enabled: false },
        },
      });
      box.writeRepoConfig({ hooks: { "session-context": { files: ["notes/repo.md"] }, "git-guard": { enabled: true } } });
      const { context } = expectContext(await box.event(sessionStart), /repo notes/);
      expect(context).not.toMatch(/user notes/);
      expect(context).toMatch(/from the user config/);
      expectBlocked(await box.event(forcePush), /force/i);
      // The user's Preset still applies: strict protects main.
      expectBlocked(await box.event(pushMain), /main/);
    });

    it("applies on its own when the repo has no config", async () => {
      const box = sandbox();
      box.writeUserConfig({ hooks: { "git-guard": { enabled: false } } });
      expectNoDecision(await box.event(forcePush));
    });

    it("a repo `preset` wins over the user's", async () => {
      const box = sandbox();
      box.writeUserConfig({ preset: "strict" });
      box.writeRepoConfig({ preset: "standard" });
      expectNoDecision(await box.event(pushMain));
      expect(await auditLogRan(box)).toBe(false);
    });

    // Each row runs on its own OS. Directories in env vars are placed under the sandbox home.
    const disableGitGuard = { hooks: { "git-guard": { enabled: false } } };
    const rows = [
      { platform: "linux", env: {}, path: [".config", "hardhooks", "config.json"] },
      { platform: "darwin", env: {}, path: [".config", "hardhooks", "config.json"] },
      { platform: "linux", env: { XDG_CONFIG_HOME: "xdg" }, path: ["xdg", "hardhooks", "config.json"] },
      { platform: "darwin", env: { XDG_CONFIG_HOME: "xdg" }, path: ["xdg", "hardhooks", "config.json"] },
      { platform: "win32", env: { APPDATA: "Roaming" }, path: ["Roaming", "hardhooks", "config.json"] },
      { platform: "win32", env: {}, path: ["AppData", "Roaming", "hardhooks", "config.json"] },
    ] as const;
    for (const { platform, env: vars, path } of rows) {
      it.runIf(process.platform === platform)(`on ${platform} with ${JSON.stringify(vars)} lives at ~/${path.join("/")}`, async () => {
        const probe = sandbox();
        const env = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, join(probe.home, value)]));
        probe.writeFile(join(probe.home, ...path), JSON.stringify(disableGitGuard));
        expectNoDecision(await probe.event(forcePush, { env }));
      });
    }
  });

  describe("repo config", () => {
    it("is found from a subdirectory of the repo", async () => {
      const box = sandbox();
      box.writeRepoConfig({ hooks: { "git-guard": { enabled: false } } });
      mkdirSync(join(box.project, ".git"));
      const sub = join(box.project, "packages", "app");
      mkdirSync(sub, { recursive: true });
      expectNoDecision(await box.event(forcePush, { cwd: sub }));
    });

    it("is not looked for above the repository root", async () => {
      const box = sandbox();
      box.writeRepoConfig({ hooks: { "git-guard": { enabled: false } } });
      const repo = join(box.project, "nested-repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      expectBlocked(await box.event(forcePush, { cwd: repo }), /force/i);
    });
  });

  describe("an invalid config", () => {
    it.each([
      { problem: "a wrong type", config: { hooks: { "git-guard": { enabled: "no" } } }, path: "hooks.git-guard.enabled", message: /expected a boolean, got a string \("no"\)/ },
      { problem: "an unknown top-level key", config: { presets: "strict" }, path: "presets", message: /unknown key "presets"/ },
      { problem: "an unknown Hook", config: { hooks: { "git-gaurd": { enabled: false } } }, path: "hooks.git-gaurd", message: new RegExp(`unknown Hook "git-gaurd" \\(known Hooks: ${knownHooks}\\)`) },
      { problem: "an unknown option", config: { hooks: { "session-context": { flies: ["x"] } } }, path: "hooks.session-context.flies", message: /unknown option "flies" for Hook "session-context"/ },
      { problem: "a wrong option type", config: { hooks: { "session-context": { files: "README.md" } } }, path: "hooks.session-context.files", message: /expected an array/ },
      { problem: "a wrong array item", config: { hooks: { "session-context": { files: ["ok", 7] } } }, path: "hooks.session-context.files[1]", message: /expected a string, got a number \(7\)/ },
      { problem: "an unknown preset", config: { preset: "paranoid" }, path: "preset", message: /expected one of "standard", "strict"/ },
      { problem: "a non-object", config: "[]", path: "(top level)", message: /expected an object, got an array/ },
    ])("with $problem blocks PreToolUse(Bash), naming file, path and problem", async ({ config, path, message }) => {
      const box = sandbox();
      const file = box.writeRepoConfig(config);
      const { reason } = expectBlocked(await box.event(claudeCode.bash("ls")), /config is invalid/);
      expect(reason).toContain(`${file}: ${path}: `);
      expect(reason).toMatch(message);
    });

    it("that isn't JSON blocks, naming the file", async () => {
      const box = sandbox();
      const file = box.writeRepoConfig('{ "preset": "strict", }');
      const { reason } = expectBlocked(await box.event(claudeCode.bash("ls")));
      expect(reason).toContain(`${file}: invalid JSON`);
    });

    it("blocks even when it tries to disable the Guard", async () => {
      const box = sandbox();
      box.writeRepoConfig({ hooks: { "git-guard": { enabled: false, typo: true } } });
      expectBlocked(await box.event(forcePush), /hooks\.git-guard\.typo/);
    });

    it("in the user config blocks too, naming the user config file", async () => {
      const box = sandbox();
      const file = box.writeUserConfig({ hooks: { "git-guard": { enabled: 1 } } });
      box.writeRepoConfig({ hooks: { "git-guard": { enabled: true } } });
      const { reason } = expectBlocked(await box.event(claudeCode.bash("ls")));
      expect(reason).toContain(`${file}: hooks.git-guard.enabled: expected a boolean`);
    });

    it("reports every problem in both files", async () => {
      const box = sandbox();
      box.writeUserConfig({ nope: 1 });
      box.writeRepoConfig({ preset: 1, hooks: { "session-context": { files: 2 } } });
      const { reason } = expectBlocked(await box.event(claudeCode.bash("ls")));
      expect(reason).toMatch(/nope[\s\S]*preset[\s\S]*hooks\.session-context\.files/);
    });

    it("allows Events and tools no Guard handles, reporting the error on stderr", async () => {
      const box = sandbox();
      box.writeRepoConfig({ preset: "strict", hooks: { "git-guard": { enabled: "yes" } } });
      for (const payload of [
        claudeCode.sessionStart("startup"),
        claudeCode.notification("idle"),
        // No Guard handles web fetches.
        claudeCode.preToolUse("WebFetch", { url: "https://example.com", prompt: "summarise" }),
      ]) {
        const result = await box.event(payload);
        expectNoDecision(result);
        expect(result.stderr).toMatch(/invalid config[\s\S]*hooks\.git-guard\.enabled/);
      }
    });

    it("blocks a Guard's Event even when the payload is unreadable", async () => {
      const box = sandbox();
      box.writeRepoConfig({ preset: 3 });
      expectBlocked(await box.event("{not json", { event: "PreToolUse" }), /config is invalid/);
    });
  });
});
