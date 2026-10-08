import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  commit,
  expectContext,
  expectFixture,
  expectMessage,
  expectNoDecision,
  fakeEnvironment,
  git,
  initRepo,
  loadFixtures,
  runEvent,
  writeProjectFile,
  writeRepoConfig,
  writeUserConfig,
  type FakeEnvironment,
} from "../../../test/helpers";

/** Midday UTC, so the local date is 2026-03-14 in every timezone from UTC-12 to UTC+11. */
const now = "2026-03-14T12:00:00Z";

describe("session-context", () => {
  it("outside a git repo, adds only today's date", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /2026-03-14/);
    expect(context).not.toMatch(/branch|commit|uncommitted/i);
  });

  it("is on in the strict Preset too, and can be turned off", async () => {
    const env = fakeEnvironment({ now });
    writeRepoConfig(env, { preset: "strict" });
    expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /2026-03-14/);

    writeRepoConfig(env, { preset: "strict", hooks: { "session-context": { enabled: false } } });
    expectNoDecision(await runEvent(claudeCode.sessionStart("startup"), { env }));
  });

  it("in a git repo, adds the branch, dirty files, last five commit subjects and the date", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    initRepo(env.cwd);
    for (const subject of ["First commit", "Second", "Third", "Fourth", "Fifth", "Sixth", "Add the parser"]) {
      commit(env.cwd, subject);
    }
    writeProjectFile(env.cwd, "second.txt", "changed\n");
    writeProjectFile(env.cwd, "notes.md", "todo\n");

    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /2026-03-14/);
    expect(context).toMatch(/branch: main\b/i);
    expect(context).toMatch(/2 uncommitted/i);
    expect(context).toContain("second.txt");
    expect(context).toContain("notes.md");
    for (const subject of ["Add the parser", "Sixth", "Fifth", "Fourth", "Third"]) expect(context).toContain(subject);
    expect(context).not.toContain("Second");
    expect(context).not.toContain("First commit");
  });

  it("says how far the branch is ahead of and behind its upstream", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    initRepo(env.cwd);
    commit(env.cwd, "Base");
    git(env.cwd, "switch", "--quiet", "--create", "feature", "--track", "main");
    commit(env.cwd, "Feature one");
    commit(env.cwd, "Feature two");
    git(env.cwd, "switch", "--quiet", "main");
    commit(env.cwd, "Main moved on");
    git(env.cwd, "switch", "--quiet", "feature");

    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /feature/);
    expect(context).toMatch(/ahead 2, behind 1 .*main/);
    expect(context).not.toMatch(/uncommitted/i);
  });

  it("names the commit when HEAD is detached", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    initRepo(env.cwd);
    commit(env.cwd, "Only commit");
    git(env.cwd, "switch", "--quiet", "--detach");
    const sha = git(env.cwd, "rev-parse", "--short=7", "HEAD").trim();

    expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), new RegExp(`detached at ${sha}`));
  });

  it.each(["startup", "resume", "clear", "compact"])("fires for the %s source", async (source) => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    initRepo(env.cwd);
    commit(env.cwd, "Only commit");
    const { context } = expectContext(await runEvent(claudeCode.sessionStart(source), { env }), /2026-03-14/);
    expect(context).toMatch(/Branch: main/);
  });

  it("stays within the byte budget with many dirty files, naming some and counting all", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    initRepo(env.cwd);
    commit(env.cwd, "Ünïcödé subject ".repeat(40));
    for (let i = 0; i < 300; i++) writeProjectFile(env.cwd, `a-rather-long-file-name-number-${i}-ä.txt`);

    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /2026-03-14/);
    expect(Buffer.byteLength(context!, "utf8")).toBeLessThanOrEqual(1024);
    expect(context).toMatch(/300 uncommitted/);
    expect(context).toContain("a-rather-long-file-name-number-0-ä.txt");
    expect(context).toMatch(/Ünïcödé subject/);
    expect(context).toMatch(/Branch: main/);
  });

  it("adds configured extra files", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    writeProjectFile(env.cwd, "docs/ORIENTATION.md", "Deploys go through the release train.\n");
    writeRepoConfig(env, { hooks: { "session-context": { files: ["docs/ORIENTATION.md"] } } });

    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /2026-03-14/);
    expect(context).toMatch(/docs\/ORIENTATION\.md[\s\S]*Deploys go through the release train\./);
  });

  it("adds the output of configured extra commands, run without a shell", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    const command = [process.execPath, "-e", "console.log('Open pull requests: 3')"];
    writeRepoConfig(env, { hooks: { "session-context": { commands: [command] } } });

    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env, trusted: true }), /2026-03-14/);
    expect(context).toContain("Open pull requests: 3");
  });

  it("in an untrusted project, leaves out the repo config's commands and tells the user, still adding the rest", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    const command = [process.execPath, "-e", "console.log('Open pull requests: 3')"];
    writeRepoConfig(env, { hooks: { "session-context": { commands: [command] } } });

    const result = await runEvent(claudeCode.sessionStart("startup"), { env });

    const { context } = expectContext(result, /2026-03-14/);
    expect(context).not.toContain("Open pull requests");
    expectMessage(result, /session-context\] skipped session-context\.commands from \.hardhooks\.json: this project is not trusted/);
  });

  it("keeps long extras within the budget, after the git summary, even in a busy repo", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    initRepo(env.cwd);
    for (let i = 1; i <= 5; i++) commit(env.cwd, `Commit number ${i} `.repeat(10));
    for (let i = 0; i < 300; i++) writeProjectFile(env.cwd, `a-rather-long-file-name-number-${i}.txt`);
    writeProjectFile(env.cwd, "NOTES.md", "Release notes. ".repeat(500));
    const longOutput = [process.execPath, "-e", "console.log('x'.repeat(5000))"];
    writeRepoConfig(env, { hooks: { "session-context": { files: ["NOTES.md"], commands: [longOutput] } } });

    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env, trusted: true }), /2026-03-14/);
    expect(Buffer.byteLength(context!, "utf8")).toBeLessThanOrEqual(1024);
    // 300 files plus NOTES.md and .hardhooks.json.
    expect(context).toMatch(/Branch: main[\s\S]*302 uncommitted[\s\S]*Commit number 1[\s\S]*NOTES\.md:\nRelease notes/);
  });

  describe("extra files stay inside the project and never include secrets", () => {
    /** Run SessionStart with `files` set in the repo config (or the user config), returning the added context. */
    async function contextWith(env: FakeEnvironment, files: string[], from: "repo" | "user" = "repo") {
      const settings = { hooks: { "session-context": { files } } };
      if (from === "repo") writeRepoConfig(env, settings);
      else writeUserConfig(env, settings);
      return expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /2026-03-14/).context!;
    }

    it.each([
      ["../home/.aws/credentials", "a relative path"],
      ["docs/../../home/.aws/credentials", "a path that dips back out"],
    ])("leaves out %s (%s) that escapes the project, saying why", async (path) => {
      const env = fakeEnvironment({ now });
      writeProjectFile(env.home, ".aws/credentials", "aws_secret_access_key=AKIAEXAMPLE\n");
      const context = await contextWith(env, [path]);
      expect(context).not.toContain("AKIAEXAMPLE");
      expect(context).toContain(`${path}: (skipped: outside the project)`);
    });

    it("leaves out an absolute path, even from the user config", async () => {
      const env = fakeEnvironment({ now });
      writeProjectFile(env.home, "notes/todo.md", "personal notes\n");
      const secret = join(env.home, "notes", "todo.md");
      for (const from of ["repo", "user"] as const) {
        const context = await contextWith(env, [secret], from);
        expect(context).not.toContain("personal notes");
        expect(context).toContain(`${secret}: (skipped: not a path relative to the project)`);
      }
    });

    it("leaves out a symlink in the project that points outside it", async () => {
      const env = fakeEnvironment({ now });
      writeProjectFile(env.home, "notes/todo.md", "personal notes\n");
      symlinkSync(join(env.home, "notes", "todo.md"), join(env.cwd, "linked.md"));
      const context = await contextWith(env, ["linked.md"]);
      expect(context).not.toContain("personal notes");
      expect(context).toContain("linked.md: (skipped: outside the project)");
    });

    it("follows a symlink that stays inside the project", async () => {
      const env = fakeEnvironment({ now });
      writeProjectFile(env.cwd, "docs/real.md", "Release train on Tuesdays.\n");
      symlinkSync(join(env.cwd, "docs", "real.md"), join(env.cwd, "ORIENTATION.md"));
      expect(await contextWith(env, ["ORIENTATION.md"])).toContain("Release train on Tuesdays.");
    });

    it.each([
      [".env", "API_KEY=hunter2\n", "`.env`"],
      ["config/.env.production", "DB_PASSWORD=hunter2\n", "`.env.*`"],
      ["certs/server.key", "-----BEGIN PRIVATE KEY-----hunter2\n", "`*.key`"],
    ])("leaves out the protected file %s, naming the pattern", async (path, content, pattern) => {
      const env = fakeEnvironment({ now });
      writeProjectFile(env.cwd, path, content);
      const context = await contextWith(env, [path]);
      expect(context).not.toContain("hunter2");
      expect(context).toContain(`${path}: (skipped: protected by ${pattern}`);
    });

    it("leaves out a symlink to a protected file", async () => {
      const env = fakeEnvironment({ now });
      writeProjectFile(env.cwd, ".env", "API_KEY=hunter2\n");
      symlinkSync(join(env.cwd, ".env"), join(env.cwd, "settings.txt"));
      const context = await contextWith(env, ["settings.txt"]);
      expect(context).not.toContain("hunter2");
      expect(context).toMatch(/settings\.txt: \(skipped: protected by `\.env`/);
    });

    it("honours protect-secrets' protect, allow and ignore files", async () => {
      const env = fakeEnvironment({ now });
      writeProjectFile(env.cwd, "notes/private.md", "salary data\n");
      writeProjectFile(env.cwd, "notes/ignored.md", "ignored data\n");
      writeProjectFile(env.cwd, ".cursorignore", "notes/ignored.md\n");
      writeProjectFile(env.cwd, "config/dev.key", "not really a secret\n");
      writeRepoConfig(env, {
        hooks: {
          "protect-secrets": { protect: ["notes/private.md"], allow: ["config/dev.key"] },
          "session-context": { files: ["notes/private.md", "notes/ignored.md", "config/dev.key"] },
        },
      });
      const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /2026-03-14/);
      expect(context).not.toContain("salary data");
      expect(context).not.toContain("ignored data");
      expect(context).toMatch(/notes\/private\.md: \(skipped: protected by `notes\/private\.md` \(your `protect` option\)/);
      expect(context).toMatch(/notes\/ignored\.md: \(skipped: protected by `notes\/ignored\.md` \(\.cursorignore\)/);
      expect(context).toContain("not really a secret");
    });
  });

  it("names an extra file it cannot read instead of failing", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    writeRepoConfig(env, { hooks: { "session-context": { files: ["missing.md"] } } });

    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /2026-03-14/);
    expect(context).toMatch(/missing\.md: \(could not read/);
  });

  it.each(loadFixtures(new URL("./fixtures", import.meta.url)))("fixture $file: $description", async (fixture) => {
    expectFixture(await runEvent(JSON.stringify(fixture.payload), { event: fixture.event }), fixture);
  });

  it("still adds the date when git and extra commands cannot run at all", async () => {
    const env = fakeEnvironment({
      now,
      processRunner: {
        run: () => Promise.reject(new Error("spawn failed")),
        spawnDetached: () => {},
      },
    });
    writeRepoConfig(env, { hooks: { "session-context": { commands: [["gh", "pr", "list"]] } } });

    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env, trusted: true }), /2026-03-14/);
    expect(context).toMatch(/gh pr list: \(could not run/);
  });
});
