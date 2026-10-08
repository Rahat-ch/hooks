/**
 * The e2e harness itself: sandboxes are hermetic, the clock knob works, and
 * fake programs record what the real CLI ran.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCode, expectContext, expectNoDecision, sandbox } from "./helpers";

describe("e2e harness", () => {
  it("passes nothing from the test process's environment but what the sandbox sets", async () => {
    const box = sandbox({ env: { EXTRA: "1" } });
    const echo = box.fakeProgram("echo-env");
    box.writeUserConfig({ hooks: { "session-context": { commands: [["node", "-e", "require('child_process').spawnSync('echo-env', {stdio: 'inherit', shell: true})"]] } } });
    expectContext(await box.event(claudeCode.sessionStart()), /Today:/);
    const [call] = await echo.waitForCalls();
    expect(call!.env.HOME).toBe(box.home);
    expect(call!.env.EXTRA).toBe("1");
    for (const name of ["CLAUDECODE", "CURSOR_VERSION", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "APPDATA", "HARDHOOKS_NOW"]) {
      expect(call!.env[name], name).toBeUndefined();
    }
  });

  it("fixes the CLI's clock with `now` (HARDHOOKS_NOW), per sandbox or per run", async () => {
    const box = sandbox({ now: "2026-03-14T12:00:00Z" });
    expectContext(await box.event(claudeCode.sessionStart()), /^Today: 2026-03-14 \(Saturday\)$/m);
    expectContext(await box.event(claudeCode.sessionStart(), { now: "2027-01-01T12:00:00Z" }), /^Today: 2027-01-01 \(Friday\)$/m);
  });

  it("ignores an unparseable HARDHOOKS_NOW and uses the real clock", async () => {
    const box = sandbox({ now: "not a date" });
    const year = new Date().getUTCFullYear();
    expectContext(await box.event(claudeCode.sessionStart()), new RegExp(`^Today: ${year}-`, "m"));
  });

  it("trusts the project through the real `hardhooks trust --yes`, under the sandbox's state dir", async () => {
    const box = sandbox();
    await box.trust();
    expect((await box.run(["trust", "--status"])).stdout).toContain("is trusted.");
    expect(existsSync(join(box.stateDir, "trust", "projects"))).toBe(true);
  });

  it("records a fake program's argv and stdin, and answers by rule", async () => {
    const box = sandbox();
    const tool = box.fakeProgram("tool", { exitCode: 3, rules: [{ match: /^ok\b/, stdout: "fine\n" }] });
    box.writeUserConfig({
      hooks: { "session-context": { commands: [["node", "-e", "for (const a of ['ok go', 'nope']) console.log(require('child_process').spawnSync('tool ' + a, { shell: true, input: 'in-' + a }).status)"]] } },
    });
    expectContext(await box.event(claudeCode.sessionStart()), /^0\n3$/m);
    const calls = tool.calls();
    expect(calls.map((call) => [call.argv, call.stdin])).toEqual([
      [["ok", "go"], "in-ok go"],
      [["nope"], "in-nope"],
    ]);
  });

  it("runs every test in a fresh project with no config and no Hook state", async () => {
    const box = sandbox();
    expectNoDecision(await box.event(claudeCode.bash("git status")));
    expect(existsSync(box.stateDir)).toBe(false);
    expect(box.auditLog()).toEqual([]);
  });
});
