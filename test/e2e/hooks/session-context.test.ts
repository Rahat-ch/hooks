/**
 * session-context through `hardhooks run SessionStart`, as a Host runs it:
 * real git in temp repos, the date from `HARDHOOKS_NOW`, the 1 KB budget,
 * and configured extra `files` (kept inside the project and away from
 * secrets) and `commands` (from a repo config, only once the project is
 * trusted).
 */
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCode, expectContext, expectFixture, expectMessage, expectNoDecision, hookFixtures, sandbox, type Sandbox } from "../helpers";

/** Midday UTC, so the local date is 2026-03-14 in every timezone from UTC-12 to UTC+11. */
const now = "2026-03-14T12:00:00Z";
const startup = claudeCode.sessionStart("startup");

describe("session-context", () => {
  it("outside a git repo, adds only today's date", async () => {
    const { context } = expectContext(await sandbox({ now }).event(startup), /2026-03-14/);
    expect(context).not.toMatch(/branch|commit|uncommitted/i);
  });

  it("is on in the strict Preset too, and can be turned off", async () => {
    const box = sandbox({ now });
    box.writeRepoConfig({ preset: "strict" });
    expectContext(await box.event(startup), /2026-03-14/);

    box.writeRepoConfig({ preset: "strict", hooks: { "session-context": { enabled: false } } });
    expectNoDecision(await box.event(startup));
  });

  it("in a git repo, adds the branch, dirty files, last five commit subjects and the date", async () => {
    const box = sandbox({ now });
    const repo = box.initGitRepo(box.project, { initialCommit: false });
    for (const subject of ["First commit", "Second", "Third", "Fourth", "Fifth", "Sixth", "Add the parser"]) repo.commit(subject);
    box.writeFile("second.txt", "changed\n");
    box.writeFile("notes.md", "todo\n");

    const { context } = expectContext(await box.event(startup), /2026-03-14/);
    expect(context).toMatch(/branch: main\b/i);
    expect(context).toMatch(/2 uncommitted/i);
    expect(context).toContain("second.txt");
    expect(context).toContain("notes.md");
    for (const subject of ["Add the parser", "Sixth", "Fifth", "Fourth", "Third"]) expect(context).toContain(subject);
    expect(context).not.toContain("Second");
    expect(context).not.toContain("First commit");
  });

  it("says how far the branch is ahead of and behind its upstream", async () => {
    const box = sandbox({ now });
    const repo = box.initGitRepo(box.project, { initialCommit: false });
    repo.commit("Base");
    repo.git("switch", "--quiet", "--create", "feature", "--track", "main");
    repo.commit("Feature one");
    repo.commit("Feature two");
    repo.git("switch", "--quiet", "main");
    repo.commit("Main moved on");
    repo.git("switch", "--quiet", "feature");

    const { context } = expectContext(await box.event(startup), /feature/);
    expect(context).toMatch(/ahead 2, behind 1 .*main/);
    expect(context).not.toMatch(/uncommitted/i);
  });

  it("names the commit when HEAD is detached", async () => {
    const box = sandbox({ now });
    const repo = box.initGitRepo(box.project, { initialCommit: false });
    repo.commit("Only commit");
    repo.git("switch", "--quiet", "--detach");
    const sha = repo.git("rev-parse", "--short=7", "HEAD").trim();

    expectContext(await box.event(startup), new RegExp(`detached at ${sha}`));
  });

  it.each(["startup", "resume", "clear", "compact"])("fires for the %s source", async (source) => {
    const box = sandbox({ now });
    box.initGitRepo(box.project, { initialCommit: false }).commit("Only commit");
    const { context } = expectContext(await box.event(claudeCode.sessionStart(source)), /2026-03-14/);
    expect(context).toMatch(/Branch: main/);
  });

  it("stays within the byte budget with many dirty files, naming some and counting all", async () => {
    const box = sandbox({ now });
    box.initGitRepo(box.project, { initialCommit: false }).commit("Ünïcödé subject ".repeat(40));
    for (let i = 0; i < 300; i++) box.writeFile(`a-rather-long-file-name-number-${i}-ä.txt`);

    const { context } = expectContext(await box.event(startup), /2026-03-14/);
    expect(Buffer.byteLength(context!, "utf8")).toBeLessThanOrEqual(1024);
    expect(context).toMatch(/300 uncommitted/);
    expect(context).toContain("a-rather-long-file-name-number-0-ä.txt");
    expect(context).toMatch(/Ünïcödé subject/);
    expect(context).toMatch(/Branch: main/);
  });

  it("adds configured extra files", async () => {
    const box = sandbox({ now });
    box.writeFile("docs/ORIENTATION.md", "Deploys go through the release train.\n");
    box.writeRepoConfig({ hooks: { "session-context": { files: ["docs/ORIENTATION.md"] } } });

    const { context } = expectContext(await box.event(startup), /2026-03-14/);
    expect(context).toMatch(/docs\/ORIENTATION\.md[\s\S]*Deploys go through the release train\./);
  });

  it("adds the output of configured extra commands, run without a shell", async () => {
    const box = sandbox({ now });
    const command = [process.execPath, "-e", "console.log('Open pull requests: 3')"];
    box.writeRepoConfig({ hooks: { "session-context": { commands: [command] } } });
    await box.trust();

    const { context } = expectContext(await box.event(startup), /2026-03-14/);
    expect(context).toContain("Open pull requests: 3");
  });

  it("in an untrusted project, leaves out the repo config's commands and tells the user, still adding the rest", async () => {
    const box = sandbox({ now });
    const command = [process.execPath, "-e", "console.log('Open pull requests: 3')"];
    box.writeRepoConfig({ hooks: { "session-context": { commands: [command] } } });

    const result = await box.event(startup);

    const { context } = expectContext(result, /2026-03-14/);
    expect(context).not.toContain("Open pull requests");
    expectMessage(result, /session-context\] skipped session-context\.commands from \.hardhooks\.json: this project is not trusted/);
  });

  it("keeps long extras within the budget, after the git summary, even in a busy repo", async () => {
    const box = sandbox({ now });
    const repo = box.initGitRepo(box.project, { initialCommit: false });
    for (let i = 1; i <= 5; i++) repo.commit(`Commit number ${i} `.repeat(10));
    for (let i = 0; i < 300; i++) box.writeFile(`a-rather-long-file-name-number-${i}.txt`);
    box.writeFile("NOTES.md", "Release notes. ".repeat(500));
    const longOutput = [process.execPath, "-e", "console.log('x'.repeat(5000))"];
    box.writeRepoConfig({ hooks: { "session-context": { files: ["NOTES.md"], commands: [longOutput] } } });
    await box.trust();

    const { context } = expectContext(await box.event(startup), /2026-03-14/);
    expect(Buffer.byteLength(context!, "utf8")).toBeLessThanOrEqual(1024);
    // 300 files plus NOTES.md and .hardhooks.json.
    expect(context).toMatch(/Branch: main[\s\S]*302 uncommitted[\s\S]*Commit number 1[\s\S]*NOTES\.md:\nRelease notes/);
  });

  describe("extra files stay inside the project and never include secrets", () => {
    /** Run SessionStart with `files` set in the repo config (or the user config), returning the added context. */
    async function contextWith(box: Sandbox, files: string[], from: "repo" | "user" = "repo") {
      const settings = { hooks: { "session-context": { files } } };
      if (from === "repo") box.writeRepoConfig(settings);
      else box.writeUserConfig(settings);
      return expectContext(await box.event(startup), /2026-03-14/).context!;
    }

    it.each([
      ["../home/.aws/credentials", "a relative path"],
      ["docs/../../home/.aws/credentials", "a path that dips back out"],
    ])("leaves out %s (%s) that escapes the project, saying why", async (path) => {
      // The sandbox's home and project are siblings, so `../home` from the project is the home.
      const box = sandbox({ now });
      box.writeFile(join(box.home, ".aws", "credentials"), "aws_secret_access_key=AKIAEXAMPLE\n");
      const context = await contextWith(box, [path]);
      expect(context).not.toContain("AKIAEXAMPLE");
      expect(context).toContain(`${path}: (skipped: outside the project)`);
    });

    it("leaves out an absolute path, even from the user config", async () => {
      const box = sandbox({ now });
      const secret = box.writeFile(join(box.home, "notes", "todo.md"), "personal notes\n");
      for (const from of ["repo", "user"] as const) {
        const context = await contextWith(box, [secret], from);
        expect(context).not.toContain("personal notes");
        expect(context).toContain(`${secret}: (skipped: not a path relative to the project)`);
      }
    });

    it("leaves out a symlink in the project that points outside it", async () => {
      const box = sandbox({ now });
      const outside = box.writeFile(join(box.home, "notes", "todo.md"), "personal notes\n");
      symlinkSync(outside, join(box.project, "linked.md"));
      const context = await contextWith(box, ["linked.md"]);
      expect(context).not.toContain("personal notes");
      expect(context).toContain("linked.md: (skipped: outside the project)");
    });

    it("follows a symlink that stays inside the project", async () => {
      const box = sandbox({ now });
      const real = box.writeFile("docs/real.md", "Release train on Tuesdays.\n");
      symlinkSync(real, join(box.project, "ORIENTATION.md"));
      expect(await contextWith(box, ["ORIENTATION.md"])).toContain("Release train on Tuesdays.");
    });

    it.each([
      [".env", "API_KEY=hunter2\n", "`.env`"],
      ["config/.env.production", "DB_PASSWORD=hunter2\n", "`.env.*`"],
      ["certs/server.key", "-----BEGIN PRIVATE KEY-----hunter2\n", "`*.key`"],
    ])("leaves out the protected file %s, naming the pattern", async (path, content, pattern) => {
      const box = sandbox({ now });
      box.writeFile(path, content);
      const context = await contextWith(box, [path]);
      expect(context).not.toContain("hunter2");
      expect(context).toContain(`${path}: (skipped: protected by ${pattern}`);
    });

    it("leaves out a symlink to a protected file", async () => {
      const box = sandbox({ now });
      const env = box.writeFile(".env", "API_KEY=hunter2\n");
      symlinkSync(env, join(box.project, "settings.txt"));
      const context = await contextWith(box, ["settings.txt"]);
      expect(context).not.toContain("hunter2");
      expect(context).toMatch(/settings\.txt: \(skipped: protected by `\.env`/);
    });

    it("honours protect-secrets' protect, allow and ignore files", async () => {
      const box = sandbox({ now });
      box.writeFile("notes/private.md", "salary data\n");
      box.writeFile("notes/ignored.md", "ignored data\n");
      box.writeFile(".cursorignore", "notes/ignored.md\n");
      box.writeFile("config/dev.key", "not really a secret\n");
      box.writeRepoConfig({
        hooks: {
          "protect-secrets": { protect: ["notes/private.md"], allow: ["config/dev.key"] },
          "session-context": { files: ["notes/private.md", "notes/ignored.md", "config/dev.key"] },
        },
      });
      const { context } = expectContext(await box.event(startup), /2026-03-14/);
      expect(context).not.toContain("salary data");
      expect(context).not.toContain("ignored data");
      expect(context).toMatch(/notes\/private\.md: \(skipped: protected by `notes\/private\.md` \(your `protect` option\)/);
      expect(context).toMatch(/notes\/ignored\.md: \(skipped: protected by `notes\/ignored\.md` \(\.cursorignore\)/);
      expect(context).toContain("not really a secret");
    });
  });

  it("names an extra file it cannot read instead of failing", async () => {
    const box = sandbox({ now });
    box.writeRepoConfig({ hooks: { "session-context": { files: ["missing.md"] } } });

    const { context } = expectContext(await box.event(startup), /2026-03-14/);
    expect(context).toMatch(/missing\.md: \(could not read/);
  });

  it.each(hookFixtures("session-context"))("fixture $file: $description", async (fixture) => {
    expectFixture(await sandbox().event(JSON.stringify(fixture.payload), { event: fixture.event }), fixture);
  });

  it("still adds the date when git and extra commands cannot run at all", async () => {
    const box = sandbox({ now });
    box.initGitRepo(box.project, { initialCommit: false }).commit("Only commit");
    box.writeRepoConfig({ hooks: { "session-context": { commands: [["gh", "pr", "list"]] } } });
    await box.trust();

    // A PATH holding neither git nor gh (only the empty fake-program dir): neither can be started.
    const { context } = expectContext(await box.event(startup, { env: { PATH: box.bin } }), /2026-03-14/);
    expect(context).toMatch(/gh pr list: \(could not run/);
    expect(context).not.toMatch(/Branch|commit/i);
  });
});
