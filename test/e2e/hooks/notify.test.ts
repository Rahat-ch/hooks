/**
 * notify through `hardhooks run <Event>` exactly as a Host runs it (ADR-0006).
 *
 * - Turn length: UserPromptSubmit and Stop at different `HARDHOOKS_NOW`
 *   times, with the state dir carrying the turn start between them.
 * - What a notification says: a sandbox has no native notifier on PATH (no
 *   `systemPath`, so macOS's /usr/bin/osascript stays out of reach), so
 *   notify falls back to OSC 9, which the Host sees on stdout on every OS.
 * - Delivery: fake notifiers and a fake curl on PATH record the detached
 *   processes notify starts (`waitForCalls`). notify spawns them by bare
 *   name without a shell, which on Windows finds only real `.exe` files
 *   (powershell.exe, and System32's real curl.exe), so those cases are POSIX
 *   only, and no test can ever show a real notification or post a real webhook.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  expectNoDecision,
  observe,
  sandbox,
  type CliResult,
  type FakeCall,
  type FakeProgram,
  type Sandbox,
} from "../helpers";

const isWindows = process.platform === "win32";

/** The CLI's clock at the start of every turn. */
const start = Date.parse("2026-03-02T09:00:00.000Z");
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

/** A sandbox with notify (opt-in under `standard`) enabled with `options` in the repo config, and nothing else changed. */
function notifySandbox(options: Record<string, unknown> = {}): Sandbox {
  const box = sandbox();
  box.writeRepoConfig({ hooks: { notify: { enabled: true, ...options } } });
  return box;
}

/** Submit a prompt, let `seconds` pass, then stop the turn. Returns the Stop's result. */
async function turnLasting(box: Sandbox, seconds: number): Promise<CliResult> {
  expectNoDecision(await box.event(claudeCode.userPromptSubmit("refactor the parser"), { now: at(0) }));
  return box.event(claudeCode.stop(), { now: at(seconds) });
}

/** The OSC 9 notification the Host is asked to write to its terminal (no native notifier installed). */
function osc9(result: CliResult): string | undefined {
  expect(result.exitCode, result.stderr).toBe(0);
  const observed = observe(result);
  expect(observed.decision).toBe("none");
  return observed.terminalSequence;
}

/** Exit 0 with nothing at all on stdout or stderr: no Decision, no OSC 9, no warning. */
function expectSilent(result: CliResult): void {
  expectNoDecision(result);
  expect(result.stderr).toBe("");
}

/** The program notify uses on this OS when it is the only notifier installed (POSIX). */
const nativeNotifier = process.platform === "darwin" ? "osascript" : "notify-send";

/**
 * Give detached processes notify may have started time to show up in a fake's
 * record before asserting they didn't (or that no more did).
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

/** argv, plus the values of variables the notifier got beyond the CLI's own (powershell.exe gets title and body that way). */
const passed = (call: FakeCall) => [...call.argv, call.env.HARDHOOKS_NOTIFY_TITLE ?? "", call.env.HARDHOOKS_NOTIFY_BODY ?? ""].join("\n");

describe("notify", () => {
  // A fake notifier stands in for the real one: POSIX only (see the top of the file).
  it.skipIf(isWindows)(
    "sends exactly one desktop notification for a Notification Event, naming the project and the Host's message",
    async () => {
      const box = notifySandbox();
      const notifier = box.fakeProgram(nativeNotifier);
      const result = await box.event(claudeCode.notification("Claude needs your permission to use Bash"));

      expectSilent(result);
      const [call] = await notifier.waitForCalls();
      expect(call!.argv.join(" ")).toContain(basename(box.project));
      expect(call!.argv.join(" ")).toContain("Claude needs your permission to use Bash");
      await settle();
      expect(notifier.calls()).toHaveLength(1);
    },
  );

  it("notifies when a turn ran longer than 30 seconds, saying how long it took", async () => {
    const box = notifySandbox();
    const sequence = osc9(await turnLasting(box, 45));
    expect(sequence).toContain(basename(box.project));
    expect(sequence).toContain("45s");
  });

  it("stays quiet after a short turn", async () => {
    const box = notifySandbox();
    expectSilent(await turnLasting(box, 5));
  });

  // The notifier is a POSIX script on PATH that takes 2 s and then leaves a marker (see the top of the file).
  it.skipIf(isWindows)("returns to the Host while the notifier is still running: it only starts detached processes", async () => {
    const box = notifySandbox();
    const marker = join(box.root, "notified");
    const script = `setTimeout(function () { require('fs').writeFileSync(process.argv[1], process.argv.slice(2).join(' ')); }, 2000)`;
    const notifier = join(box.bin, nativeNotifier);
    writeFileSync(notifier, `#!/bin/sh\nexec node -e "${script}" '${marker}' "$@"\n`);
    chmodSync(notifier, 0o755);

    const result = await box.event(claudeCode.notification("Claude needs your permission"));

    expectSilent(result);
    expect(result.durationMs).toBeLessThan(1500);
    expect(existsSync(marker)).toBe(false);
    // The detached notifier carries on after the CLI has exited.
    for (let waited = 0; waited < 10_000 && !existsSync(marker); waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readFileSync(marker, "utf8")).toContain("Claude needs your permission");
  });

  // Each row runs on its own OS. The powershell.exe row never runs: it can't be faked (spawned by bare name, without a shell).
  for (const { platform, programs, command, runs } of [
    { platform: "darwin", programs: ["osascript"], command: "osascript", runs: process.platform === "darwin" },
    { platform: "darwin", programs: ["osascript", "terminal-notifier"], command: "terminal-notifier", runs: process.platform === "darwin" },
    { platform: "linux", programs: ["notify-send"], command: "notify-send", runs: process.platform === "linux" },
    { platform: "win32", programs: ["powershell.exe"], command: "powershell.exe", runs: false },
  ]) {
    it.runIf(runs)(`on ${platform} with ${programs.join(", ")} available, notifies with ${command}`, async () => {
      const box = notifySandbox();
      const fakes = Object.fromEntries(programs.map((name) => [name, box.fakeProgram(name)])) as Record<string, FakeProgram>;

      expectSilent(await box.event(claudeCode.notification("Claude needs your permission")));
      const [call] = await fakes[command]!.waitForCalls();
      expect(passed(call!)).toContain(basename(box.project));
      expect(passed(call!)).toContain("Claude needs your permission");
      await settle();
      expect(Object.entries(fakes).map(([name, fake]) => [name, fake.calls().length])).toEqual(
        programs.map((name) => [name, name === command ? 1 : 0]),
      );
    });
  }

  // No notifier is on PATH on any OS; each row runs on its own OS.
  for (const platform of ["darwin", "linux", "win32"]) {
    it.runIf(process.platform === platform)(
      `on ${platform} with no native notifier, falls back to an OSC 9 terminal notification the Host emits`,
      async () => {
        const box = notifySandbox();
        const result = await box.event(claudeCode.notification("Claude is waiting for your input"));
        expect(osc9(result)).toBe(`\u001b]9;${basename(box.project)}: Claude is waiting for your input\u0007`);
      },
    );
  }

  it("strips control characters from the OSC 9 text, so a message can't end the sequence early", async () => {
    const box = notifySandbox();
    const result = await box.event(claudeCode.notification("done\u0007\u001b]52;c;aGk=\u0007 now"));
    expect(osc9(result)).toBe(`\u001b]9;${basename(box.project)}: done]52;c;aGk= now\u0007`);
  });

  // Each row runs on its own OS. The powershell.exe row never runs: it can't be faked (spawned by bare name, without a shell).
  for (const { platform, program, sound, runs } of [
    { platform: "darwin", program: "osascript", sound: /sound name/, runs: process.platform === "darwin" },
    { platform: "darwin", program: "terminal-notifier", sound: /-sound/, runs: process.platform === "darwin" },
    { platform: "linux", program: "notify-send", sound: /sound-name/, runs: process.platform === "linux" },
    { platform: "win32", program: "powershell.exe", sound: /Notification\.Default/, runs: false },
  ]) {
    it.runIf(runs)(`on ${platform} via ${program}, plays a sound unless \`sound\` is off`, async () => {
      const notifyWith = async (options: Record<string, unknown>) => {
        const box = notifySandbox(options);
        const notifier = box.fakeProgram(program);
        await box.event(claudeCode.notification("Claude needs your permission"));
        const [call] = await notifier.waitForCalls();
        return call!.argv.join("\n");
      };
      expect(await notifyWith({})).toMatch(sound);
      expect(await notifyWith({ sound: true })).toMatch(sound);
      expect(await notifyWith({ sound: false })).not.toMatch(sound);
    });
  }

  it.each(["permission_prompt", "idle_prompt", "elicitation_dialog", "agent_needs_input"])(
    "notifies for a %s Notification",
    async (type) => {
      const box = notifySandbox();
      const result = await box.event(claudeCode.notification("Claude needs you", { notification_type: type }));
      expect(osc9(result)).toContain("Claude needs you");
    },
  );

  it.each(["auth_success", "elicitation_complete", "elicitation_response"])(
    "stays quiet for a %s Notification, which needs nothing from the user",
    async (type) => {
      const box = notifySandbox();
      expectSilent(await box.event(claudeCode.notification("Done", { notification_type: type })));
    },
  );

  // Fake notifier and curl: POSIX only (see the top of the file).
  it.skipIf(isWindows)("calls no webhook unless one is configured", async () => {
    const box = notifySandbox();
    const notifier = box.fakeProgram(nativeNotifier);
    const curl = box.fakeProgram("curl");
    await box.event(claudeCode.notification("Claude needs your permission"));

    await notifier.waitForCalls();
    await settle();
    expect(curl.calls()).toEqual([]);
  });

  /** The body the one detached curl POSTed, and where to. */
  async function webhookPost(curl: FakeProgram) {
    await curl.waitForCalls();
    await settle();
    const posts = curl.calls();
    expect(posts).toHaveLength(1);
    const { argv } = posts[0]!;
    return { url: argv[argv.indexOf("--url") + 1], body: argv[argv.indexOf("--data-raw") + 1]! };
  }

  // Fake notifier and curl: POSIX only (see the top of the file).
  it.skipIf(isWindows)("posts the notification to a configured ntfy topic, as well as the desktop notification", async () => {
    const box = notifySandbox({ webhook: { kind: "ntfy", url: "https://ntfy.sh/my-agent" } });
    const notifier = box.fakeProgram(nativeNotifier);
    const curl = box.fakeProgram("curl");
    expectSilent(await box.event(claudeCode.notification("Claude needs your permission")));

    expect(await notifier.waitForCalls()).toHaveLength(1);
    const { url, body } = await webhookPost(curl);
    expect(url).toBe("https://ntfy.sh/my-agent");
    expect(body).toContain(basename(box.project));
    expect(body).toContain("Claude needs your permission");
  });

  // Fake curl: POSIX only (see the top of the file).
  it.skipIf(isWindows)("posts a Slack message to a configured Slack webhook", async () => {
    const box = notifySandbox({ webhook: { kind: "slack", url: "https://hooks.slack.com/services/T/B/X" } });
    const curl = box.fakeProgram("curl");
    await box.event(claudeCode.notification("Claude needs your permission"));

    const { url, body } = await webhookPost(curl);
    expect(url).toBe("https://hooks.slack.com/services/T/B/X");
    const { text } = JSON.parse(body) as { text: string };
    expect(text).toContain(basename(box.project));
    expect(text).toContain("Claude needs your permission");
  });

  // Non-executable programs on PATH make the spawns fail: POSIX only (on Windows notify only looks for powershell.exe).
  it.skipIf(isWindows)("swallows a delivery failure without a word to the Host", async () => {
    const box = notifySandbox({ webhook: { kind: "ntfy", url: "https://ntfy.sh/t" } });
    for (const name of [nativeNotifier, "curl"]) writeFileSync(join(box.bin, name), "", { mode: 0o644 });
    expectSilent(await box.event(claudeCode.notification("Claude needs your permission")));
  });

  it("swallows an unwritable state directory and an unreadable turn record", async () => {
    const box = notifySandbox();
    mkdirSync(dirname(box.stateDir), { recursive: true });
    writeFileSync(box.stateDir, "not a directory");
    expectSilent(await turnLasting(box, 45));

    const corrupt = notifySandbox();
    expectSilent(await turnLasting(corrupt, 1));
    const turns = join(corrupt.stateDir, "notify", "turns");
    const [file] = readdirSync(turns);
    writeFileSync(join(turns, file!), "{oops");
    expectSilent(await corrupt.event(claudeCode.stop(), { now: at(45) }));
  });

  it.each([
    { preset: "standard", notified: 0 },
    { preset: "strict", notified: 1 },
  ])("is enabled by the $preset Preset: $notified notification(s)", async ({ preset, notified }) => {
    const box = sandbox();
    box.writeRepoConfig({ preset });
    const sequence = osc9(await box.event(claudeCode.notification("Claude needs your permission")));
    expect(sequence === undefined ? 0 : 1).toBe(notified);
  });

  it("times each session's turn separately", async () => {
    const box = notifySandbox();
    const session = (id: string) => ({ session_id: id });

    await box.event(claudeCode.userPromptSubmit("long task", session("a")), { now: at(0) });
    await box.event(claudeCode.userPromptSubmit("quick question", session("b")), { now: at(40) });
    expectSilent(await box.event(claudeCode.stop(session("b")), { now: at(45) }));
    expect(osc9(await box.event(claudeCode.stop(session("a")), { now: at(45) }))).toContain("45s");
  });

  it("stays quiet at Stop when it never saw the turn start", async () => {
    expectSilent(await notifySandbox().event(claudeCode.stop()));
  });

  it.each([
    { seconds: 125, said: "2m 5s" },
    { seconds: 3720, said: "1h 2m" },
  ])("says a $seconds s turn took $said", async ({ seconds, said }) => {
    expect(osc9(await turnLasting(notifySandbox(), seconds))).toContain(`after ${said}`);
  });

  it.each([
    { thresholdSeconds: 10, seconds: 15, notified: 1 },
    { thresholdSeconds: 60, seconds: 45, notified: 0 },
  ])(
    "uses the configured threshold: $seconds s turn with thresholdSeconds $thresholdSeconds notifies $notified time(s)",
    async ({ thresholdSeconds, seconds, notified }) => {
      const box = notifySandbox({ thresholdSeconds });
      const sequence = osc9(await turnLasting(box, seconds));
      expect(sequence === undefined ? 0 : 1).toBe(notified);
    },
  );
});
