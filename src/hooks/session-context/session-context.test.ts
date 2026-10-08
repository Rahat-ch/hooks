import { describe, expect, it } from "vitest";
import { claudeCode, commit, expectContext, fakeEnvironment, git, initRepo, runEvent, writeProjectFile } from "../../../test/helpers";

/** Midday UTC, so the local date is 2026-03-14 in every timezone from UTC-12 to UTC+11. */
const now = "2026-03-14T12:00:00Z";

describe("session-context", () => {
  it("outside a git repo, adds only today's date", async () => {
    const env = fakeEnvironment({ now, processRunner: "real" });
    const { context } = expectContext(await runEvent(claudeCode.sessionStart("startup"), { env }), /2026-03-14/);
    expect(context).not.toMatch(/branch|commit|uncommitted/i);
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
});
