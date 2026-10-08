/**
 * `hardhooks test` through the real CLI: the shipped fixtures (inlined into
 * the bundle) and the user's case files run against the resolved config in
 * the sandbox's project and home. Asserts the printed report, the warnings on
 * stderr and the exit code; fake programs and the state dir show that nothing
 * a case triggers really runs.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCode, copyBundle, sandbox, type CliResult, type Sandbox } from "./helpers";

/** Write a case file (default: into the project's `.hardhooks/tests/`). Returns its path. */
function writeCases(box: Sandbox, file: string, cases: unknown, dir = join(box.project, ".hardhooks", "tests")): string {
  return box.writeFile(join(dir, file), typeof cases === "string" ? cases : JSON.stringify(cases, null, 2));
}

/** `hardhooks test [--cases <path>]` in the project. */
function runTest(box: Sandbox, cases?: string): Promise<CliResult> {
  return box.run(["test", ...(cases !== undefined ? ["--cases", cases] : [])]);
}

/**
 * Only the shell Guards (block-destructive-shell and git-guard), so `init`
 * writes one entry, `PreToolUse [Bash]`, and enabling check (Stop) or
 * protect-secrets (Read and other file tools) needs more.
 */
const shellGuardsOnly = {
  hooks: { "protect-secrets": { enabled: false }, "format-on-edit": { enabled: false }, "session-context": { enabled: false } },
};

describe("hardhooks test", () => {
  it("passes every shipped fixture with the default config", async () => {
    const result = await runTest(sandbox());
    expect(result.stdout).toMatch(/PASS\s+git-guard\/force-push-blocked/);
    expect(result.stdout).toMatch(/PASS\s+session-context\/compact-adds-date/);
    expect(result.stdout).not.toMatch(/FAIL/);
    expect(result.stdout).toMatch(/\b0 failed\b/);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  });

  it("runs the user's cases from .hardhooks/tests/ in the project", async () => {
    const box = sandbox();
    writeCases(box, "git.json", [
      { name: "force-push to main is blocked", event: "PreToolUse", bash: "git push --force origin main", expect: "block" },
    ]);
    const result = await runTest(box);
    expect(result.stdout).toMatch(/PASS\s+git\.json\s+force-push to main is blocked/);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  });

  it("runs a case as the Host it names, so asks fall back where that Host can't ask", async () => {
    // A CURSOR_VERSION leaked from the user's terminal must not change any case's Host.
    const box = sandbox({ env: { CURSOR_VERSION: "1.7.2" } });
    const lease = "git push --force-with-lease origin feature";
    writeCases(box, "hosts.json", [
      { name: "claude-code asks", bash: lease, expect: "ask" },
      { name: "copilot-cli asks", host: "copilot-cli", bash: lease, expect: "ask" },
      ...["cursor", "continue-cli", "copilot-cloud", "devin-cli"].map((host) => ({
        name: `${host} can't ask, so standard allows`,
        host,
        bash: lease,
        expect: "allow",
      })),
    ]);
    const result = await runTest(box);
    expect(result.stdout).not.toMatch(/FAIL/);
    expect(result.stdout).toMatch(/PASS\s+hosts\.json\s+devin-cli can't ask/);
    expect(result.exitCode, result.stdout).toBe(0);

    box.writeRepoConfig({ preset: "strict" });
    writeCases(box, "hosts.json", [{ name: "strict blocks instead", host: "devin-cli", bash: lease, expect: { decision: "block", reason: "Devin CLI" } }]);
    const strict = await runTest(box);
    expect(strict.stdout).toMatch(/PASS\s+hosts\.json\s+strict blocks instead/);
  });

  it("fails a case whose Hook is disabled, showing the expected and actual Decisions", async () => {
    const box = sandbox();
    box.writeRepoConfig({ hooks: { "git-guard": { enabled: false } } });
    writeCases(box, "git.json", [{ name: "force-push to main is blocked", bash: "git push --force origin main", expect: "block" }]);
    const result = await runTest(box);
    expect(result.stdout).toMatch(/FAIL\s+git\.json\s+force-push to main is blocked/);
    expect(result.stdout).toMatch(/expected block, got none/);
    expect(result.stdout).toMatch(/\b1 failed\b/);
    expect(result.exitCode).toBe(1);
  });

  it("skips the shipped fixtures of a disabled Hook, saying why", async () => {
    const box = sandbox();
    box.writeRepoConfig({ hooks: { "git-guard": { enabled: false } } });
    const result = await runTest(box);
    expect(result.stdout).toMatch(/SKIP\s+git-guard\/force-push-blocked.*\n\s+git-guard is disabled/);
    expect(result.stdout).toMatch(/PASS\s+session-context\/compact-adds-date/);
    expect(result.exitCode, result.stdout).toBe(0);
  });

  it("matches reasons and added context, for any Event, with extra payload fields", async () => {
    const box = sandbox();
    writeCases(box, "cases.json", [
      { name: "says why", bash: "git push --force origin main", expect: { decision: "block", reason: "force" } },
      { name: "dates the session", event: "SessionStart", payload: { source: "compact" }, expect: { context: "^today: \\d{4}-" } },
      { name: "wrong reason", bash: "git push --force origin main", expect: { decision: "block", reason: "lease" } },
      { name: "wrong context", event: "SessionStart", expect: { context: "Branch:" } },
    ]);
    const result = await runTest(box);
    expect(result.stdout).toMatch(/PASS\s+cases\.json\s+says why/);
    expect(result.stdout).toMatch(/PASS\s+cases\.json\s+dates the session/);
    expect(result.stdout).toMatch(/FAIL\s+cases\.json\s+wrong reason\n\s+reason: expected to match \/lease\/i, got ".*force/);
    expect(result.stdout).toMatch(/FAIL\s+cases\.json\s+wrong context\n\s+context: expected to match \/Branch:\/i, got "Today: /);
    expect(result.exitCode).toBe(1);
  });

  describe("trust (ADR-0005)", () => {
    const listsPullRequests = [{ name: "lists pull requests", event: "SessionStart", expect: { context: "\\$ gh pr list" } }];

    it("runs cases as the Hooks behave in this project: without trust, the repo's commands are left out, and it says why", async () => {
      const box = sandbox();
      box.writeRepoConfig({ hooks: { "session-context": { commands: [["gh", "pr", "list"]] } } });
      writeCases(box, "context.json", listsPullRequests);

      const result = await runTest(box);

      expect(result.stdout).toMatch(/FAIL\s+context\.json\s+lists pull requests/);
      expect(result.stderr).toMatch(
        /this project is not trusted, so hardhooks won't run its commands:\n.*session-context: commands from \.hardhooks\.json: gh pr list[\s\S]*`hardhooks trust`/,
      );
    });

    it("in a trusted project, the repo's commands count (still sandboxed: nothing really runs)", async () => {
      const box = sandbox();
      const gh = box.fakeProgram("gh");
      box.writeRepoConfig({ hooks: { "session-context": { commands: [["gh", "pr", "list"]] } } });
      writeCases(box, "context.json", listsPullRequests);
      await box.trust();

      const result = await runTest(box);

      expect(result.stdout).toMatch(/PASS\s+context\.json\s+lists pull requests/);
      expect(result.stderr).not.toMatch(/trust/);
      expect(gh.calls()).toEqual([]);
    });
  });

  describe("side effects", () => {
    it("never runs formatters or other programs from the user's config", async () => {
      const box = sandbox();
      // A formatter run as `node <script>`, so it can be faked on every OS. From the user config: no trust needed.
      const formatter = box.fakeNodePackage("fake-formatter", "fake-formatter");
      box.writeUserConfig({ hooks: { "format-on-edit": { command: ["node", formatter.path] } } });
      box.writeFile("a.ts", "const  a=1\n");
      writeCases(box, "edit.json", [{ name: "writing a file is fine", event: "PostToolUse", write: "a.ts", expect: "allow" }]);

      const result = await runTest(box);

      expect(result.stdout).toMatch(/PASS\s+edit\.json/);
      expect(formatter.calls()).toEqual([]);
      // The same edit from a real Host does run it.
      await box.event(claudeCode.postToolUse("Write", { file_path: join(box.project, "a.ts"), content: "const  a=1\n" }));
      expect(formatter.calls()).toHaveLength(1);
    });

    it("keeps Hook state (audit logs, notify's turn start, check fingerprints) out of the user's state directory", async () => {
      // strict: audit-log logs every Event, notify records each turn's start, check fingerprints the tree at Stop.
      const box = sandbox();
      box.writeRepoConfig({ preset: "strict" });
      writeCases(box, "stop.json", [
        { name: "prompt is fine", event: "UserPromptSubmit", payload: { prompt: "refactor" }, expect: "allow" },
        { name: "stop is fine", event: "Stop", expect: "allow" },
      ]);

      const result = await runTest(box);

      expect(result.stdout).toMatch(/PASS\s+stop\.json\s+stop is fine/);
      expect(existsSync(box.stateDir)).toBe(false);
      // The same Event from a real Host does write there.
      await box.event(claudeCode.stop());
      expect(box.auditLog()).toHaveLength(1);
    });

    it("lets user cases see the real git repository", async () => {
      const box = sandbox();
      const repo = box.initGitRepo();
      box.writeRepoConfig({ preset: "strict" });
      writeCases(box, "branches.json", [{ name: "no commits on main", bash: "git commit -m wip", expect: { decision: "block", reason: "`main`" } }]);
      expect((await runTest(box)).stdout).toMatch(/PASS\s+branches\.json\s+no commits on main/);

      repo.git("switch", "-q", "-c", "feature");
      // Only read-only git runs: a configured command that would write is never started, even in a trusted project.
      box.writeRepoConfig({
        preset: "strict",
        hooks: { "session-context": { commands: [["git", "-C", box.project, "commit", "-q", "--allow-empty", "-m", "from hardhooks test"]] } },
      });
      writeCases(box, "session.json", [{ name: "session starts", event: "SessionStart", expect: { context: "feature" } }]);
      await box.trust();
      const onFeature = await runTest(box);
      expect(onFeature.stdout).toMatch(/FAIL\s+branches\.json\s+no commits on main\n\s+decision: expected block, got none/);
      expect(onFeature.stdout).toMatch(/PASS\s+session\.json\s+session starts/);
      expect(repo.git("log", "--format=%s")).not.toMatch(/from hardhooks test/);
    });
  });

  it("never fails a shipped fixture just because the user configured a Hook's options", async () => {
    const box = sandbox();
    box.writeFile("NOTES.md", "remember the milk\n");
    box.writeRepoConfig({ preset: "strict", hooks: { "session-context": { files: ["NOTES.md"], commands: [["gh", "pr", "list"]] } } });
    const result = await runTest(box);
    expect(result.stdout).not.toMatch(/FAIL/);
    expect(result.exitCode, result.stdout).toBe(0);
  });

  it("fails on an invalid config, naming the problem, without running anything", async () => {
    const box = sandbox();
    box.writeRepoConfig({ hooks: { "git-guard": { enabled: "yes" } } });
    const result = await runTest(box);
    expect(result.stderr).toMatch(/invalid config: .*\.hardhooks\.json: hooks\.git-guard\.enabled/);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  describe("install warnings", () => {
    /**
     * The shell Guards only, installed with `init --yes [--user]` from a copy
     * of the bundle outside the project (a global install), so tests can
     * remove it. Returns that copy's path.
     */
    async function installed(box: Sandbox, options: { user?: boolean } = {}): Promise<string> {
      box.writeUserConfig(shellGuardsOnly);
      const bundle = copyBundle(join(box.root, "global", "lib", "node_modules", "hardhooks"));
      const init = await box.run(["init", "--yes", ...(options.user ? ["--user"] : [])], { bundle });
      expect(init.exitCode, init.stderr).toBe(0);
      return bundle;
    }

    it("has nothing to say right after init", async () => {
      const box = sandbox();
      await installed(box);
      const result = await runTest(box);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("warns when an enabled Hook's Event isn't installed, without failing the run", async () => {
      const box = sandbox();
      await installed(box);
      box.writeRepoConfig({ hooks: { check: { enabled: true } } });
      const result = await runTest(box);
      expect(result.stderr).toMatch(/warning: check is enabled, but no hardhooks entry for Stop is installed.*run `hardhooks init`/);
      expect(result.exitCode).toBe(0);
    });

    it("asks for the Events a Hook's options make active, and only those", async () => {
      const box = sandbox();
      const bundle = copyBundle(join(box.project, "node_modules", "hardhooks"));
      box.writeRepoConfig({ hooks: { check: { enabled: true } } });
      expect((await box.run(["init", "--yes"], { bundle })).exitCode).toBe(0);
      expect((await runTest(box)).stderr).toBe("");

      box.writeRepoConfig({ hooks: { check: { enabled: true, subagentStop: true } } });
      const result = await runTest(box);
      expect(result.stderr).toMatch(/warning: check is enabled, but no hardhooks entry for SubagentStop is installed/);
      expect(result.stderr.match(/warning/g)).toHaveLength(1);
    });

    it("warns when the installed entry's matcher doesn't cover a newly enabled Hook's tools", async () => {
      const box = sandbox();
      await installed(box);
      box.writeRepoConfig({ hooks: { "protect-secrets": { enabled: true } } });
      const result = await runTest(box);
      expect(result.stderr).toMatch(/warning: the PreToolUse entry doesn't match Read, .*\(needed by protect-secrets\).*re-run `hardhooks init`/);
    });

    it("counts entries in the user settings and in .claude/settings.local.json", async () => {
      const box = sandbox();
      const bundle = await installed(box, { user: true });
      box.writeRepoConfig({ hooks: { check: { enabled: true } } });
      box.writeFile(
        join(".claude", "settings.local.json"),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: [bundle, "run", "Stop"] }] }] } }),
      );
      const result = await runTest(box);
      expect(result.stderr).toBe("");
    });

    it("says once when hardhooks isn't installed at all", async () => {
      const result = await runTest(sandbox());
      expect(result.stderr).toMatch(/warning: hardhooks isn't installed in any Host settings.*run `hardhooks init`/);
      expect(result.stderr.match(/warning/g)).toHaveLength(1);
    });

    it("doesn't warn about Events when the Claude Code plugin is enabled, since it installs every Event", async () => {
      const box = sandbox();
      box.writeUserConfig(shellGuardsOnly);
      box.writeRepoConfig({ hooks: { check: { enabled: true } } });
      box.writeFile(join(box.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "hardhooks@hardhooks": true } }));
      expect((await runTest(box)).stderr).toBe("");

      box.writeFile(join(".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "hardhooks@hardhooks": false } }));
      expect((await runTest(box)).stderr).toMatch(/isn't installed/);
    });

    it("warns when an installed entry runs a bundle that no longer exists", async () => {
      const box = sandbox();
      rmSync(await installed(box));
      const result = await runTest(box);
      expect(result.stderr).toMatch(
        /warning: .*settings\.local\.json: the hardhooks entries \([A-Za-z, ]*PreToolUse[A-Za-z, ]*\) run .*hardhooks\.mjs, which doesn't exist.*re-run `hardhooks init`/,
      );
      expect(result.stderr.match(/warning/g)).toHaveLength(1);
    });

    it("resolves ${CLAUDE_PROJECT_DIR} in a project install", async () => {
      const box = sandbox();
      const bundle = copyBundle(join(box.project, "node_modules", "hardhooks"));
      expect((await box.run(["init", "--yes"], { bundle })).exitCode).toBe(0);
      expect((await runTest(box)).stderr).toBe("");
      rmSync(bundle);
      expect((await runTest(box)).stderr).toMatch(/node_modules[\\/]hardhooks[\\/]dist[\\/]hardhooks\.mjs, which doesn't exist/);
    });

    it("warns when the shared project settings run hardhooks by a path that only exists on this machine", async () => {
      const box = sandbox();
      await installed(box);
      // An older init (or a hand edit) put the global install's path in the committed file.
      const local = join(box.project, ".claude", "settings.local.json");
      box.writeFile(join(".claude", "settings.json"), readFileSync(local, "utf8"));
      rmSync(local);

      const result = await runTest(box);

      expect(result.stderr).toMatch(
        /warning: .*[\\/]\.claude[\\/]settings\.json: the hardhooks entries \(PreToolUse\) run .*hardhooks\.mjs, a path on this machine only.*teammates.*re-run `hardhooks init`/,
      );
      expect(result.stderr.match(/warning/g)).toHaveLength(1);
    });

    it("warns about an unreadable settings file", async () => {
      const box = sandbox();
      box.writeFile(join(".claude", "settings.json"), "{ not json");
      expect((await runTest(box)).stderr).toMatch(/warning: could not read .*settings\.json/);
    });
  });

  describe("shipped fixtures that assume a config", () => {
    // audit-log/logged-force-push-replays assumes the strict Preset; session-context/compact-adds-date
    // assumes `files: []` and `commands: []`.
    it("run when the resolved config matches", async () => {
      const box = sandbox();
      box.writeRepoConfig({ preset: "strict" });
      const result = await runTest(box);
      expect(result.stdout).toMatch(/PASS\s+audit-log\/logged-force-push-replays\s/);
    });

    it("are skipped under another Preset", async () => {
      const box = sandbox();
      box.writeRepoConfig({ hooks: { "audit-log": { enabled: true } } });
      const result = await runTest(box);
      expect(result.stdout).toMatch(/SKIP\s+audit-log\/logged-force-push-replays.*\n\s+assumes the strict Preset/);
      expect(result.exitCode, result.stdout).toBe(0);
    });

    it("are skipped when the Hook's options differ", async () => {
      const box = sandbox();
      box.writeRepoConfig({ hooks: { "session-context": { files: ["NOTES.md"] } } });
      const result = await runTest(box);
      expect(result.stdout).toMatch(/SKIP\s+session-context\/compact-adds-date.*\n\s+assumes session-context option files = \[\]/);
    });
  });

  describe("invalid case files", () => {
    it.each([
      ["invalid JSON", "{ name: 'x' ", /bad\.json: invalid JSON/],
      ["a case that isn't an object", ["git status"], /bad\.json\[0\]: a case must be a JSON object/],
      ["a missing name", [{ bash: "ls", expect: "allow" }], /bad\.json\[0\]: "name" is required/],
      ["a misspelt key", [{ name: "push", bash: "git push", expects: "block" }], /bad\.json\[0\] \(push\): unknown key "expects"/],
      ["a missing expect", [{ name: "push", bash: "git push" }], /"expect" is required/],
      ["an unknown Decision", [{ name: "push", bash: "git push", expect: "deny" }], /"expect" must be one of block, ask, allow, none/],
      ["an invalid regular expression", [{ name: "push", bash: "git push", expect: { reason: "(" } }], /"expect\.reason" is not a valid regular expression/],
      ["an unknown Event", [{ name: "x", event: "PreToolCall", expect: "allow" }], /unknown "event" "PreToolCall" \(known: SessionStart, /],
      ["no Event or tool", [{ name: "x", expect: "allow" }], /"event" is required/],
      ["a tool on a tool-less Event", [{ name: "x", event: "Stop", bash: "ls", expect: "allow" }], /a tool only applies to PreToolUse and PostToolUse, not Stop/],
      ["two tools", [{ name: "x", bash: "ls", read: "a.txt", expect: "allow" }], /give one of "tool", .*not bash and read/],
      ["input without a tool", [{ name: "x", input: { command: "ls" }, expect: "allow" }], /"input" needs "tool"/],
      ["an unknown Host", [{ name: "x", host: "vim", bash: "ls", expect: "allow" }], /unknown "host" "vim"/],
      ["assumes, which only shipped fixtures may declare", [{ name: "x", bash: "ls", expect: "allow", assumes: { preset: "strict" } }], /unknown key "assumes"/],
    ])("names the file, the case and the problem: %s", async (_, cases, message) => {
      const box = sandbox();
      writeCases(box, "bad.json", cases);
      const result = await runTest(box);
      expect(result.stderr).toMatch(message);
      expect(result.exitCode).toBe(1);
    });

    it("reports every invalid case at once and runs nothing", async () => {
      const box = sandbox();
      writeCases(box, "a.json", [{ name: "one", bash: "ls", expect: "maybe" }, { name: "two", bash: "ls", expect: "allow" }]);
      writeCases(box, "b.json", [{ name: "three", expect: "allow" }]);
      const result = await runTest(box);
      expect(result.stderr).toMatch(/a\.json\[0\] \(one\)/);
      expect(result.stderr).toMatch(/b\.json\[0\] \(three\)/);
      expect(result.stderr).not.toMatch(/two/);
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("--cases", () => {
    it("runs one case file", async () => {
      const box = sandbox();
      writeCases(box, "ignored.json", [{ name: "never runs", bash: "git status", expect: "block" }]);
      const file = writeCases(box, "push.json", { name: "force-push is blocked", bash: "git push -f", expect: "block" }, join(box.project, "ci"));
      const result = await runTest(box, file);
      expect(result.stdout).toMatch(/PASS\s+push\.json\s+force-push is blocked/);
      expect(result.stdout).not.toMatch(/never runs/);
      expect(result.exitCode, result.stdout).toBe(0);
    });

    it("runs every *.json file in a directory, relative to the working directory", async () => {
      const box = sandbox();
      const dir = join(box.project, "ci", "hooks");
      writeCases(box, "a.json", [{ name: "status is fine", bash: "git status", expect: "allow" }], dir);
      writeCases(box, "b.json", [{ name: "reset --hard is blocked", bash: "git reset --hard", expect: "block" }], dir);
      writeCases(box, "notes.txt", "not a case file", dir);
      const result = await runTest(box, join("ci", "hooks"));
      expect(result.stdout).toMatch(/PASS\s+a\.json\s+status is fine/);
      expect(result.stdout).toMatch(/PASS\s+b\.json\s+reset --hard is blocked/);
      expect(result.exitCode, result.stdout).toBe(0);
    });

    it("passes the example case file shipped in examples/tests/", async () => {
      const example = fileURLToPath(new URL("../../examples/tests/git.json", import.meta.url));
      const result = await runTest(sandbox(), example);
      expect(result.stdout).toMatch(/PASS\s+git\.json\s+force-push to main is blocked/);
      expect(result.stdout).not.toMatch(/FAIL/);
      expect(result.exitCode, result.stdout).toBe(0);
    });

    it("fails when the path doesn't exist", async () => {
      const result = await runTest(sandbox(), "missing.json");
      expect(result.stderr).toMatch(/missing\.json/);
      expect(result.exitCode).toBe(1);
    });
  });

  // Was test/smoke/test-command.test.ts.
  describe("the bundle on its own", () => {
    /** A copy of the bundle away from the repo, so it can't read the fixtures from src/. */
    const elsewhere = (box: Sandbox) => copyBundle(join(box.root, "elsewhere"));

    it("carries the shipped fixtures, runs the user's cases and exits 0", async () => {
      const box = sandbox();
      writeCases(box, "git.json", [{ name: "force-push to main is blocked", bash: "git push --force origin main", expect: "block" }]);
      const result = await box.run(["test"], { bundle: elsewhere(box) });
      expect(result.stdout).toMatch(/PASS\s+git-guard\/force-push-blocked/);
      expect(result.stdout).toMatch(/PASS\s+git\.json\s+force-push to main is blocked/);
      expect(result.stderr).toMatch(/warning: hardhooks isn't installed/);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    });

    it("exits 1 when a case fails, e.g. with git-guard disabled", async () => {
      const box = sandbox();
      writeCases(box, "git.json", [{ name: "force-push to main is blocked", bash: "git push --force origin main", expect: "block" }]);
      box.writeRepoConfig({ hooks: { "git-guard": { enabled: false } } });
      const result = await box.run(["test", "--cases", join(".hardhooks", "tests", "git.json")], { bundle: elsewhere(box) });
      expect(result.stdout).toMatch(/FAIL\s+git\.json\s+force-push to main is blocked\n\s+decision: expected block, got none/);
      expect(result.exitCode).toBe(1);
    });

    it("rejects unknown arguments", async () => {
      const result = await sandbox().run(["test", "--case", "x.json"]);
      expect(result.stderr).toMatch(/usage: hardhooks test \[--cases <path>\]/);
      expect(result.exitCode).toBe(1);
    });
  });
});
