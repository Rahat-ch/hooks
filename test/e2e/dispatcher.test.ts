/**
 * The dispatcher, through `hardhooks run <Event>` exactly as a Host runs it:
 * Hook selection, Decision merging, fail-closed Guards, Host detection and
 * the ask fallback, observers, and the Host protocol. Every case uses real
 * Hooks with real configs (ADR-0006).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  expectAllowedWithWarning,
  expectAsked,
  expectBlocked,
  expectContext,
  expectMessage,
  expectNoDecision,
  hostPayloadFields,
  observe,
  sandbox,
  type FakeBehaviour,
  type Sandbox,
} from "./helpers";

const isWindows = process.platform === "win32";
const auditLogOn = { hooks: { "audit-log": { enabled: true } } };
const failingCommand = `node -e "process.exit(1)"`;

/**
 * A fake `git` for which the project is a work tree but listing its files
 * fails (`ls-files` exits 1), or hangs with `hang`: block-destructive-shell
 * then can't tell what `rm -rf src` would lose. POSIX only: the product
 * spawns git by bare name without a shell, which on Windows finds only .exe.
 */
function brokenGit(box: Sandbox, how: "fails" | "hangs"): void {
  const listFiles: FakeBehaviour = how === "fails" ? { exitCode: 1 } : { delayMs: 8_000 };
  box.fakeProgram("git", {
    exitCode: 1,
    rules: [
      { match: /rev-parse --show-toplevel/, stdout: `${box.project}\n` },
      { match: /ls-files/, ...listFiles },
    ],
  });
}

/** A git repo whose node_modules is gitignored output, so deleting it is harmless. */
function repoWithIgnoredOutput(): Sandbox {
  const box = sandbox({ git: true });
  box.writeFile(".gitignore", "node_modules/\n");
  box.writeFile("node_modules/x/index.js");
  return box;
}

describe("dispatcher", () => {
  it("reports nothing when no Hook handles the Event", async () => {
    const result = await sandbox().event(claudeCode.notification("idle"));
    expectNoDecision(result);
    expect(result.stderr).toBe("");
  });

  it("asks the Host when a Hook asks", async () => {
    expectAsked(await sandbox().event(claudeCode.bash("git branch -D old")), /git-guard[\s\S]*branch -D/);
  });

  it("never emits an explicit allow, so the Host's own permission prompts still apply", async () => {
    const box = repoWithIgnoredOutput();
    // Every Guard looks at these and finds nothing to stop.
    expectNoDecision(await box.event(claudeCode.bash("git status && rm -rf node_modules")));
  });

  it("block beats ask beats allow, and names every Hook behind the winning Decision", async () => {
    const box = repoWithIgnoredOutput();
    const command = "rm -rf node_modules && git branch -D old && git push --force origin main && rm -rf ~";
    const observed = expectBlocked(await box.event(claudeCode.bash(command)));
    expect(observed.reason).toMatch(/\[hardhooks\/git-guard\][^\n]*force/);
    expect(observed.reason).toMatch(/\[hardhooks\/block-destructive-shell\][^\n]*home directory/);
    expect(observed.reason).not.toMatch(/branch -D/);
  });

  it.skipIf(isWindows)("a Guard that throws blocks, naming the Hook and the error", async () => {
    const box = sandbox();
    brokenGit(box, "fails");
    expectBlocked(await box.event(claudeCode.bash("rm -rf src")), /block-destructive-shell failed[\s\S]*git ls-files/);
  });

  describe("two Guards on one Event", () => {
    it("a command matching both Guards returns one block whose reason includes both", async () => {
      const observed = expectBlocked(await sandbox().event(claudeCode.bash("git push --force origin main && rm -rf ~")));
      expect(observed.reason).toMatch(/\[hardhooks\/git-guard\][^\n]*force/);
      expect(observed.reason).toMatch(/\[hardhooks\/block-destructive-shell\][^\n]*home directory/);
    });

    it("one ask plus one allow merges to ask", async () => {
      const box = repoWithIgnoredOutput();
      const result = await box.event(claudeCode.bash("rm -rf node_modules && git push --force-with-lease"));
      expectAsked(result, /\[hardhooks\/git-guard\][^\n]*force-with-lease/);
    });

    it("one ask plus one block merges to block, giving only the block's reason", async () => {
      const observed = expectBlocked(await sandbox().event(claudeCode.bash("git branch -D old && rm -rf /")));
      expect(observed.reason).toMatch(/block-destructive-shell[^\n]*root/);
      expect(observed.reason).not.toMatch(/git-guard/);
    });

    it.skipIf(isWindows)("a throwing Guard contributes a block without changing the other Guard's Decision", async () => {
      const box = sandbox();
      brokenGit(box, "fails");
      const observed = expectBlocked(await box.event(claudeCode.bash("rm -rf src && git push --force origin main")));
      expect(observed.reason).toMatch(/block-destructive-shell failed[\s\S]*git ls-files/);
      expect(observed.reason).toMatch(/\[hardhooks\/git-guard\][^\n]*force/);
    });
  });

  describe("Host detection and the ask fallback", () => {
    const ls = (overrides: Record<string, unknown> = {}) => claudeCode.bash("ls", overrides);
    const branchDelete = (overrides: Record<string, unknown> = {}) => claudeCode.bash("git branch -D old", overrides);

    // audit-log records the Host the dispatcher detected for each Event.
    it.each([
      ["no markers", ls(), {}, "claude-code"],
      ["CLAUDECODE alone", ls(), { CLAUDECODE: "1" }, "claude-code"],
      ["a Cursor payload", ls(hostPayloadFields.cursor), {}, "cursor"],
      ["Cursor's env", ls({ transcript_path: undefined }), { CURSOR_VERSION: "1.7.2" }, "cursor"],
      ["a Cursor payload inside Claude Code's env", ls(hostPayloadFields.cursor), { CLAUDECODE: "1" }, "cursor"],
      ["a Copilot CLI payload", ls(hostPayloadFields.copilotCli), {}, "copilot-cli"],
      ["Copilot cloud agent", ls(hostPayloadFields.copilotCli), { COPILOT_AGENT_PROMPT: "fix it" }, "copilot-cloud"],
      ["a Continue payload", ls(hostPayloadFields.continueCli), {}, "continue-cli"],
      ["Devin's env", ls({ transcript_path: undefined }), { DEVIN_PROJECT_DIR: "/p" }, "devin-cli"],
      ["Claude Code's payload despite another Host's env", ls(), { CURSOR_VERSION: "1.7.2" }, "claude-code"],
    ])("detects the Host from %s", async (_, payload, vars, host) => {
      const box = sandbox({ env: vars });
      box.writeRepoConfig(auditLogOn);
      expectNoDecision(await box.event(payload));
      expect(box.auditLog().map((entry) => entry.host)).toEqual([host]);
    });

    it("reads Cursor's `Shell` tool as a shell tool", async () => {
      const payload = claudeCode.preToolUse("Shell", { command: "git push --force origin main" }, hostPayloadFields.cursor);
      expectBlocked(await sandbox().event(payload), /git-guard[\s\S]*force/);
    });

    it("asks on Hosts that support ask, under either Preset", async () => {
      const box = sandbox();
      expectAsked(await box.event(branchDelete()), /branch -D/);
      expectAsked(await box.event(branchDelete(hostPayloadFields.copilotCli)), /branch -D/);
      box.writeRepoConfig({ preset: "strict" });
      expectAsked(await box.event(branchDelete()), /branch -D/);
    });

    it("under standard, allows with a warning where the Host can't ask", async () => {
      const result = await sandbox().event(branchDelete(hostPayloadFields.cursor));
      expectAllowedWithWarning(result, /Cursor can't ask[\s\S]*git-guard[\s\S]*branch -D/);
    });

    it("under strict, blocks where the Host can't ask", async () => {
      const box = sandbox({ env: { DEVIN_PROJECT_DIR: "/p" } });
      box.writeRepoConfig({ preset: "strict" });
      const result = await box.event(branchDelete({ transcript_path: undefined }));
      expectBlocked(result, /Devin CLI[\s\S]*strict[\s\S]*branch -D/);
    });

    it("a real Guard's ask falls back too", async () => {
      const box = sandbox();
      const payload = branchDelete(hostPayloadFields.cursor);
      expectAllowedWithWarning(await box.event(payload), /git-guard[\s\S]*branch -D/);
      box.writeRepoConfig({ preset: "strict" });
      expectBlocked(await box.event(payload), /git-guard[\s\S]*branch -D/);
    });

    it("leaves blocks alone where the Host can't ask", async () => {
      const payload = claudeCode.bash("git branch -D old && git push --force origin main", hostPayloadFields.cursor);
      expect(expectBlocked(await sandbox().event(payload)).reason).not.toMatch(/can't ask/);
    });
  });

  describe("timeouts", () => {
    it.skipIf(isWindows)("a Guard whose git query hangs blocks, saying it timed out, and the CLI still exits", async () => {
      const box = sandbox();
      brokenGit(box, "hangs");
      const result = await box.event(claudeCode.bash("rm -rf src"));
      expectBlocked(result, /block-destructive-shell failed[\s\S]*timed out/);
      // git queries give up after 5 s; the hung fake is killed, not waited for.
      expect(result.durationMs).toBeLessThan(7_500);
    });

    it("a fail-open Hook whose program hangs is ignored, and the rest still decide", async () => {
      const box = sandbox();
      const prettier = box.fakeNodePackage("prettier", "prettier", { delayMs: 10_000 });
      box.writeFile(".prettierrc", "{}\n");
      box.writeFile("a.ts", "let x\n");
      // From the user config, so the edit command needs no trust; the detected formatter does.
      box.writeUserConfig({ hooks: { "format-on-edit": { timeoutMs: 300 }, check: { enabled: true, editCommand: failingCommand } } });
      await box.trust();
      const result = await box.event(claudeCode.postToolUse("Write", { file_path: "a.ts", content: "let x\n" }));
      expectContext(result, /check\] `[^`]*` failed \(exit 1\) after this edit/);
      expect(prettier.calls()).toHaveLength(1);
      expect(result.durationMs).toBeLessThan(5_000);
    });
  });

  describe("observers (audit-log)", () => {
    it("see every selected Hook's Decision and timing, and the Host output, after the Decision is final", async () => {
      const box = sandbox();
      box.writeRepoConfig(auditLogOn);
      const result = await box.event(claudeCode.bash("git push --force origin main"));
      expectBlocked(result, /force/);
      const [entry, ...more] = box.auditLog();
      expect(more).toEqual([]);
      expect(entry!.expect).toEqual({ decision: observe(result).decision });
      expect(entry!.payload.tool_input.command).toBe("git push --force origin main");
      const hooks = entry!.audit.hooks as { hook: string; decision: string; reason?: string; error?: string; ms: number }[];
      expect(hooks.map(({ hook, decision }) => ({ hook, decision }))).toEqual([
        { hook: "block-destructive-shell", decision: "none" },
        { hook: "git-guard", decision: "block" },
        { hook: "protect-secrets", decision: "none" },
      ]);
      expect(hooks[1]!.reason).toMatch(/force/);
      for (const run of hooks) expect(run.ms).toBeGreaterThanOrEqual(0);
    });

    it.skipIf(isWindows)("see a Guard's error", async () => {
      const box = sandbox();
      box.writeRepoConfig(auditLogOn);
      brokenGit(box, "fails");
      expectBlocked(await box.event(claudeCode.bash("rm -rf src")));
      const hooks = box.auditLog()[0]!.audit.hooks as { hook: string; error?: string }[];
      expect(hooks.find((run) => run.hook === "block-destructive-shell")?.error).toMatch(/git ls-files/);
    });

    it("time each Hook on its own, not including the other Hooks' work", async () => {
      const box = sandbox();
      box.fakeNodePackage("prettier", "prettier", { delayMs: 1_500 });
      box.writeFile(".prettierrc", "{}\n");
      box.writeFile("a.ts", "let x\n");
      box.writeUserConfig({ hooks: { "audit-log": { enabled: true }, check: { enabled: true, editCommand: `node -e ""` } } });
      await box.trust();
      await box.event(claudeCode.postToolUse("Write", { file_path: "a.ts", content: "let x\n" }));
      const hooks = box.auditLog()[0]!.audit.hooks as { hook: string; ms: number }[];
      const ms = Object.fromEntries(hooks.map((run) => [run.hook, run.ms]));
      expect(ms["format-on-edit"]).toBeGreaterThanOrEqual(1_500);
      expect(ms.check).toBeLessThan(1_000);
    });

    it("can't change what the Host sees, even by throwing", async () => {
      const box = sandbox();
      box.writeRepoConfig(auditLogOn);
      // A file where audit-log's directory should be: every write fails.
      mkdirSync(box.stateDir, { recursive: true });
      writeFileSync(join(box.stateDir, "audit-log"), "");
      const result = await box.event(claudeCode.bash("git branch -D old"));
      expectAsked(result, /branch -D/);
      expect(result.stderr).toBe("");
    });

    it("only observe Events they were selected for", async () => {
      const box = sandbox();
      box.writeUserConfig({ hooks: { check: { enabled: true, command: failingCommand } } });
      expectBlocked(await box.event(claudeCode.stop()), /failed \(exit 1\)/);
      expect(box.auditLog()).toEqual([]);
    });
  });

  it("only runs Hooks for the tool kinds they handle", async () => {
    const box = sandbox();
    box.writeRepoConfig(auditLogOn);
    await box.event(claudeCode.bash("ls"));
    await box.event(claudeCode.preToolUse("Read", { file_path: "a.ts" }));
    const selected = box.auditLog().map((entry) => entry.audit.hooks.map((run: { hook: string }) => run.hook));
    expect(selected).toEqual([["block-destructive-shell", "git-guard", "protect-secrets"], ["protect-secrets"]]);
  });

  it("runs a Hook only on the Events its options make active", async () => {
    const box = sandbox();
    box.writeUserConfig({ hooks: { check: { enabled: true, command: failingCommand } } });
    expectBlocked(await box.event(claudeCode.stop()), /failed \(exit 1\)/);
    expectNoDecision(await box.event(claudeCode.subagentStop()));

    box.writeUserConfig({ hooks: { check: { enabled: true, command: failingCommand, subagentStop: true } } });
    expectBlocked(await box.event(claudeCode.subagentStop()), /failed \(exit 1\)/);
  });

  it("skips Hooks disabled in config", async () => {
    const box = sandbox();
    box.writeRepoConfig({ hooks: { "git-guard": { enabled: false } } });
    expectNoDecision(await box.event(claudeCode.bash("git push --force origin main")));
  });

  it("blocks when the payload is unreadable and a Guard handles the Event", async () => {
    expectBlocked(await sandbox().event("{not json", { event: "PreToolUse" }), /payload/i);
  });

  it("stays silent on an unreadable payload when only fail-open Hooks handle the Event", async () => {
    // PostToolUse under standard: only format-on-edit, which fails open.
    expectNoDecision(await sandbox().event("{not json", { event: "PostToolUse" }));
  });

  it("renders a Stop block as a top-level decision with a reason", async () => {
    const box = sandbox();
    box.writeUserConfig({ hooks: { check: { enabled: true, command: `node -e "console.log('tests are failing'); process.exit(1)"` } } });
    const result = await box.event(claudeCode.stop());
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block" });
    expectBlocked(result, /tests are failing/);
  });

  it("shows a message to the user without blocking or adding context", async () => {
    const box = sandbox();
    const npm = box.fakeProgram("npm");
    box.writeUserConfig({ hooks: { check: { enabled: true } } });
    box.writeFile("package.json", JSON.stringify({ scripts: { lint: "eslint ." } }));
    await box.trust();
    const result = await box.event(claudeCode.stop());
    const observed = expectMessage(result, /\[hardhooks\/check\] ran `npm run lint` \(detected from package\.json scripts lint\): passed/);
    expect(observed.decision).toBe("none");
    expect(observed.context).toBeUndefined();
    expect(npm.calls().map((call) => call.argv)).toEqual([["run", "lint"]]);
  });

  it("keeps messages beside another Hook's block", async () => {
    const box = sandbox();
    // The repo's command is withheld in this untrusted project, so the user's (failing) one runs, and the user is told.
    box.writeUserConfig({ hooks: { check: { enabled: true, command: failingCommand } } });
    box.writeRepoConfig({ hooks: { check: { command: `node -e ""` } } });
    const result = await box.event(claudeCode.stop());
    expectBlocked(result, /failed \(exit 1\)/);
    expectMessage(result, /\[hardhooks\/check\] skipped check\.command from \.hardhooks\.json/);
  });

  it("adds context at SessionStart", async () => {
    const result = await sandbox({ git: true }).event(claudeCode.sessionStart("startup"));
    expectContext(result, /Branch: main/);
    expect(observe(result).decision).toBe("none");
  });

  it("hands the Host a Hook's terminal sequence to write, alongside the merged Decision", async () => {
    const box = sandbox();
    // notify with no desktop notifier on PATH falls back to OSC 9 for a turn over 30 s.
    box.writeUserConfig({ hooks: { notify: { enabled: true }, check: { enabled: true, command: failingCommand } } });
    expectNoDecision(await box.event(claudeCode.userPromptSubmit("refactor"), { now: "2026-01-01T09:00:00Z" }));
    const result = await box.event(claudeCode.stop(), { now: "2026-01-01T09:00:45Z" });
    expectBlocked(result, /failed \(exit 1\)/);
    expect(observe(result).terminalSequence).toMatch(/^\u001b]9;[^\u0007]*Finished after 45s\u0007$/);
  });

  it("gives Hooks a Host-neutral Event built from the payload", async () => {
    const box = sandbox({ now: "2026-01-01T09:00:00Z" });
    box.writeRepoConfig(auditLogOn);
    await box.event(claudeCode.bash("git status"));
    expect(box.auditLog()).toEqual([
      expect.objectContaining({
        name: "PreToolUse Bash at 2026-01-01T09:00:00.000Z",
        event: "PreToolUse",
        host: "claude-code",
        audit: expect.objectContaining({ project: box.project, tool: "Bash", session: "test-session" }),
      }),
    ]);
  });
});
