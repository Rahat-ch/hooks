import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import { addContext, allow, ask, block, message, type Decision } from "../src/decision";
import type { EventName, ToolKind } from "../src/event";
import { defineHook, type Hook } from "../src/hooks/hook";
import {
  claudeCode,
  expectAsked,
  expectBlocked,
  expectContext,
  expectMessage,
  expectNoDecision,
  fakeEnvironment,
  observe,
  runEvent,
} from "./helpers";

function testHook(
  name: string,
  decide: () => Decision | undefined,
  overrides: { events?: EventName[]; tools?: ToolKind[]; failMode?: "open" | "closed" } = {},
): Hook<Record<string, never>> {
  return defineHook({
    name,
    description: "test-only Hook",
    events: overrides.events ?? ["PreToolUse"],
    ...(overrides.tools ? { tools: overrides.tools } : {}),
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

  it("shows a message to the user without blocking or adding context", async () => {
    const result = await runEvent(claudeCode.stop(), {
      hooks: [testHook("check", () => message("ran `npm run lint`: passed"), { events: ["Stop"] })],
    });
    const observed = expectMessage(result, /\[hardhooks\/check\] ran `npm run lint`: passed/);
    expect(observed.decision).toBe("none");
    expect(observed.context).toBeUndefined();
  });

  it("keeps messages beside another Hook's block", async () => {
    const result = await runEvent(claudeCode.stop(), {
      hooks: [
        testHook("announcer", () => message("heads up"), { events: ["Stop"] }),
        testHook("blocker", () => block("not yet"), { events: ["Stop"] }),
      ],
    });
    expectBlocked(result, /not yet/);
    expectMessage(result, /heads up/);
  });

  it("adds context at SessionStart", async () => {
    const result = await runEvent(claudeCode.sessionStart("startup"), {
      hooks: [testHook("session-context", () => addContext("Branch: main"), { events: ["SessionStart"] })],
    });
    expectContext(result, /Branch: main/);
    expect(observe(result).decision).toBe("none");
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
