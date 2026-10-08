import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import { addContext, allow, ask, block, terminalSequence, type Decision } from "../src/decision";
import type { EventName, ToolKind } from "../src/event";
import { defineHook, type Hook } from "../src/hooks/hook";
import {
  claudeCode,
  expectAllowedWithWarning,
  expectAsked,
  expectBlocked,
  expectContext,
  expectNoDecision,
  fakeEnvironment,
  hermeticGitEnvironment,
  hostPayloadFields,
  initRealGitRepo,
  observe,
  runEvent,
  writeProjectFile,
} from "./helpers";

function testHook(
  name: string,
  decide: () => Decision | undefined | Promise<Decision | undefined>,
  overrides: { events?: EventName[]; tools?: ToolKind[]; failMode?: "open" | "closed"; timeoutMs?: number } = {},
): Hook<Record<string, never>> {
  return defineHook({
    name,
    description: "test-only Hook",
    events: overrides.events ?? ["PreToolUse"],
    ...(overrides.tools ? { tools: overrides.tools } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    failMode: overrides.failMode ?? "open",
    defaults: { standard: { enabled: true, options: {} }, strict: { enabled: true, options: {} } },
    run: decide,
  });
}

const bash = claudeCode.bash("echo hi");

describe("dispatcher", () => {
  it("reports nothing when no Hook handles the Event", async () => {
    expectNoDecision(await runEvent(claudeCode.notification("idle"), { hooks: [testHook("a", () => block("x"))] }));
  });

  it("asks the Host when a Hook asks", async () => {
    expectAsked(await runEvent(bash, { hooks: [testHook("asker", () => ask("please confirm"))] }), /please confirm/);
  });

  it("never emits an explicit allow, so the Host's own permission prompts still apply", async () => {
    expectNoDecision(await runEvent(bash, { hooks: [testHook("allower", () => allow())] }));
  });

  it("block beats ask beats allow, and names every Hook behind the winning Decision", async () => {
    const result = await runEvent(bash, {
      hooks: [
        testHook("allower", () => allow()),
        testHook("asker", () => ask("maybe not")),
        testHook("blocker-one", () => block("first reason")),
        testHook("blocker-two", () => block("second reason")),
      ],
    });
    const observed = expectBlocked(result);
    expect(observed.reason).toContain("blocker-one");
    expect(observed.reason).toContain("first reason");
    expect(observed.reason).toContain("blocker-two");
    expect(observed.reason).toContain("second reason");
    expect(observed.reason).not.toContain("maybe not");
  });

  it("a Guard that throws blocks, naming the Hook and the error", async () => {
    const result = await runEvent(bash, {
      hooks: [testHook("broken-guard", () => { throw new Error("kaboom"); }, { failMode: "closed" })],
    });
    expectBlocked(result, /broken-guard[\s\S]*kaboom/);
  });

  it("a fail-open Hook that throws contributes nothing and doesn't affect other Hooks", async () => {
    const result = await runEvent(bash, {
      hooks: [
        testHook("broken-formatter", () => { throw new Error("kaboom"); }),
        testHook("asker", () => ask("confirm")),
      ],
    });
    expectAsked(result, /confirm/);
  });

  describe("two Guards on one Event", () => {
    it("a command matching both Guards returns one block whose reason includes both", async () => {
      const observed = expectBlocked(await runEvent(claudeCode.bash("git push --force origin main && rm -rf ~")));
      expect(observed.reason).toMatch(/\[hardhooks\/git-guard\][^\n]*force/);
      expect(observed.reason).toMatch(/\[hardhooks\/block-destructive-shell\][^\n]*home directory/);
    });

    it("one ask plus one allow merges to ask", async () => {
      const env = hermeticGitEnvironment();
      initRealGitRepo(env);
      writeProjectFile(env.cwd, ".gitignore", "node_modules/\n");
      writeProjectFile(env.cwd, "node_modules/x/index.js");
      const result = await runEvent(claudeCode.bash("rm -rf node_modules && git push --force-with-lease"), { env });
      expectAsked(result, /\[hardhooks\/git-guard\][^\n]*force-with-lease/);
      expectAsked(
        await runEvent(bash, { hooks: [testHook("allower", () => allow()), testHook("asker", () => ask("confirm"))] }),
        /asker\] confirm/,
      );
    });

    it("one ask plus one block merges to block, giving only the block's reason", async () => {
      const observed = expectBlocked(await runEvent(claudeCode.bash("git branch -D old && rm -rf /")));
      expect(observed.reason).toMatch(/block-destructive-shell[^\n]*root/);
      expect(observed.reason).not.toMatch(/git-guard/);
    });

    it("a throwing Guard contributes a block without changing the other Guard's Decision", async () => {
      const observed = expectBlocked(
        await runEvent(bash, {
          hooks: [
            testHook("broken-guard", () => { throw new Error("kaboom"); }, { failMode: "closed" }),
            testHook("working-guard", () => block("really dangerous"), { failMode: "closed" }),
          ],
        }),
      );
      expect(observed.reason).toMatch(/broken-guard[\s\S]*kaboom/);
      expect(observed.reason).toMatch(/\[hardhooks\/working-guard\] really dangerous/);
    });
  });

  describe("Host detection and the ask fallback", () => {
    const hostOf = defineHook({
      ...testHook("host-of", () => undefined),
      run: (event) => addContext(`host=${event.host} kind=${event.tool?.kind}`),
    });
    const asker = testHook("asker", () => ask("please confirm"));
    const strict = { preset: "strict" as const, hooks: {} };

    it.each([
      ["no markers", claudeCode.bash("ls"), {}, "claude-code"],
      ["CLAUDECODE alone", claudeCode.bash("ls"), { CLAUDECODE: "1" }, "claude-code"],
      ["a Cursor payload", claudeCode.bash("ls", hostPayloadFields.cursor), {}, "cursor"],
      ["Cursor's env", claudeCode.bash("ls", { transcript_path: undefined }), { CURSOR_VERSION: "1.7.2" }, "cursor"],
      ["a Cursor payload inside Claude Code's env", claudeCode.bash("ls", hostPayloadFields.cursor), { CLAUDECODE: "1" }, "cursor"],
      ["a Copilot CLI payload", claudeCode.bash("ls", hostPayloadFields.copilotCli), {}, "copilot-cli"],
      ["Copilot cloud agent", claudeCode.bash("ls", hostPayloadFields.copilotCli), { COPILOT_AGENT_PROMPT: "fix it" }, "copilot-cloud"],
      ["a Continue payload", claudeCode.bash("ls", hostPayloadFields.continueCli), {}, "continue-cli"],
      ["Devin's env", claudeCode.bash("ls", { transcript_path: undefined }), { DEVIN_PROJECT_DIR: "/p" }, "devin-cli"],
      ["Claude Code's payload despite another Host's env", claudeCode.bash("ls"), { CURSOR_VERSION: "1.7.2" }, "claude-code"],
    ])("detects the Host from %s", async (_, payload, vars, host) => {
      const env = fakeEnvironment({ env: vars });
      expectContext(await runEvent(payload, { env, hooks: [hostOf] }), new RegExp(`host=${host} `));
    });

    it("reads Cursor's `Shell` tool as a shell tool", async () => {
      const payload = claudeCode.preToolUse("Shell", { command: "ls" }, hostPayloadFields.cursor);
      expectContext(await runEvent(payload, { hooks: [hostOf] }), /kind=shell/);
    });

    it("asks on Hosts that support ask, under either Preset", async () => {
      expectAsked(await runEvent(bash, { hooks: [asker] }), /please confirm/);
      expectAsked(await runEvent(bash, { hooks: [asker], config: strict }), /please confirm/);
      expectAsked(await runEvent(claudeCode.bash("ls", hostPayloadFields.copilotCli), { hooks: [asker] }), /please confirm/);
    });

    it("under standard, allows with a warning where the Host can't ask", async () => {
      const result = await runEvent(claudeCode.bash("ls", hostPayloadFields.cursor), { hooks: [asker] });
      expectAllowedWithWarning(result, /Cursor[\s\S]*please confirm/);
    });

    it("under strict, blocks where the Host can't ask", async () => {
      const env = fakeEnvironment({ env: { DEVIN_PROJECT_DIR: "/p" } });
      const result = await runEvent(claudeCode.bash("ls", { transcript_path: undefined }), { env, hooks: [asker], config: strict });
      expectBlocked(result, /Devin CLI[\s\S]*strict[\s\S]*please confirm/);
    });

    it("a real Guard's ask falls back too", async () => {
      const payload = claudeCode.bash("git branch -D old-feature", hostPayloadFields.cursor);
      expectAllowedWithWarning(await runEvent(payload), /git-guard[\s\S]*branch -D/);
      expectBlocked(await runEvent(payload, { config: strict }), /git-guard[\s\S]*branch -D/);
    });

    it("leaves blocks alone where the Host can't ask", async () => {
      const result = await runEvent(claudeCode.bash("ls", hostPayloadFields.cursor), {
        hooks: [asker, testHook("blocker", () => block("no"))],
      });
      expect(expectBlocked(result).reason).not.toMatch(/can't ask/);
    });
  });

  describe("per-Hook timeout", () => {
    const never = () => new Promise<undefined>(() => {});

    it("a Guard that times out blocks, saying so", async () => {
      const hooks = [testHook("slow-guard", never, { failMode: "closed", timeoutMs: 20 })];
      expectBlocked(await runEvent(bash, { hooks }), /slow-guard[\s\S]*timed out/);
    });

    it("any other Hook that times out is ignored, and the rest still decide", async () => {
      const hooks = [testHook("slow-formatter", never, { timeoutMs: 20 }), testHook("asker", () => ask("confirm"))];
      const result = await runEvent(bash, { hooks });
      expectAsked(result, /confirm/);
      expect(result.stderr).toMatch(/slow-formatter[\s\S]*timed out/);
    });
  });

  it("only runs Hooks for the tool kinds they handle", async () => {
    const hooks = [testHook("edit-only", () => block("no edits"), { tools: ["edit"] })];
    expectNoDecision(await runEvent(bash, { hooks }));
    expectBlocked(await runEvent(claudeCode.preToolUse("Edit", { file_path: "a.ts" }), { hooks }), /no edits/);
  });

  it("skips Hooks disabled in config", async () => {
    const config = { ...defaultConfig(), hooks: { blocker: { enabled: false, options: {} } } };
    expectNoDecision(await runEvent(bash, { config, hooks: [testHook("blocker", () => block("x"))] }));
  });

  it("blocks when the payload is unreadable and a Guard handles the Event", async () => {
    const hooks = [testHook("guard", () => undefined, { failMode: "closed" })];
    expectBlocked(await runEvent("{not json", { event: "PreToolUse", hooks }), /payload/i);
  });

  it("stays silent on an unreadable payload when only fail-open Hooks handle the Event", async () => {
    expectNoDecision(await runEvent("{not json", { event: "PreToolUse", hooks: [testHook("open", () => block("x"))] }));
  });

  it("renders a Stop block as a top-level decision with a reason", async () => {
    const result = await runEvent(claudeCode.stop(), {
      hooks: [testHook("check", () => block("tests are failing"), { events: ["Stop"] })],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block" });
    expectBlocked(result, /tests are failing/);
  });

  it("adds context at SessionStart", async () => {
    const result = await runEvent(claudeCode.sessionStart("startup"), {
      hooks: [testHook("session-context", () => addContext("Branch: main"), { events: ["SessionStart"] })],
    });
    expectContext(result, /Branch: main/);
    expect(observe(result).decision).toBe("none");
  });

  it("hands the Host every Hook's terminal sequence to write, alongside the merged Decision", async () => {
    const result = await runEvent(claudeCode.stop(), {
      hooks: [
        testHook("check", () => block("tests are failing"), { events: ["Stop"] }),
        testHook("bell", () => terminalSequence("\u0007"), { events: ["Stop"] }),
        testHook("osc", () => terminalSequence("\u001b]9;done\u0007"), { events: ["Stop"] }),
      ],
    });
    expectBlocked(result, /tests are failing/);
    expect(observe(result).terminalSequence).toBe("\u0007\u001b]9;done\u0007");
  });

  it("gives Hooks a Host-neutral Event built from the payload", async () => {
    const env = fakeEnvironment();
    const echo = defineHook({
      ...testHook("echo", () => undefined),
      run: (event) =>
        addContext(JSON.stringify({ name: event.name, host: event.host, cwd: event.cwd, tool: event.tool })),
    });
    const result = await runEvent(claudeCode.bash("git status"), { env, hooks: [echo] });
    expect(JSON.parse(observe(result).context ?? "{}")).toMatchObject({
      name: "PreToolUse",
      host: "claude-code",
      cwd: env.cwd,
      tool: { name: "Bash", kind: "shell", command: "git status" },
    });
  });
});
