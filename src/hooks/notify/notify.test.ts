import { mkdirSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../config";
import type { ProcessRunner } from "../../environment";
import {
  claudeCode,
  expectNoDecision,
  fakeEnvironment,
  observe,
  runEvent,
  type FakeEnvironment,
  type FakeEnvironmentOptions,
  writeRepoConfig,
} from "../../../test/helpers";

/** notify is opt-in under `standard`; tests enable just notify so no other Hook speaks. */
function notifyConfig(options: Record<string, unknown> = {}): ResolvedConfig {
  return { preset: "standard", hooks: { notify: { enabled: true, options } } };
}

/** A temp directory holding (empty) programs with these names, for PATH lookups. */
function binDir(env: FakeEnvironment, programs: readonly string[]): string {
  const dir = join(env.home, "bin");
  mkdirSync(dir, { recursive: true });
  for (const name of programs) writeFileSync(join(dir, name), "", { mode: 0o755 });
  return dir;
}

/** An Environment on `platform` whose PATH offers exactly `programs`. */
function envWith(platform: NodeJS.Platform, programs: readonly string[], options: FakeEnvironmentOptions = {}) {
  const env = fakeEnvironment({ platform, ...options });
  const path = [binDir(env, programs), ...(options.env?.PATH ? [options.env.PATH] : [])].join(delimiter);
  return { ...env, env: { ...env.env, PATH: path } } as FakeEnvironment;
}

function spawns(env: FakeEnvironment) {
  return env.recorder!.spawns;
}

/** An Environment whose clock can be moved forward, as a turn takes time. */
function withMovableClock(env: FakeEnvironment) {
  let now = env.clock.now().getTime();
  const moved: FakeEnvironment = { ...env, clock: { now: () => new Date(now) } };
  return { env: moved, advanceSeconds: (seconds: number) => void (now += seconds * 1000) };
}

/** Submit a prompt, let `seconds` pass, then stop the turn. Returns the Stop's result. */
async function turnLasting(seconds: number, env: FakeEnvironment, config: ResolvedConfig = notifyConfig()) {
  const { env: timed, advanceSeconds } = withMovableClock(env);
  expectNoDecision(await runEvent(claudeCode.userPromptSubmit("refactor the parser"), { env: timed, config }));
  advanceSeconds(seconds);
  return runEvent(claudeCode.stop(), { env: timed, config });
}

describe("notify", () => {
  it("sends exactly one desktop notification for a Notification Event, naming the project and the Host's message", async () => {
    const env = envWith("linux", ["notify-send"]);
    const result = await runEvent(claudeCode.notification("Claude needs your permission to use Bash"), {
      env,
      config: notifyConfig(),
    });

    expectNoDecision(result);
    expect(result.stderr).toBe("");
    expect(spawns(env)).toHaveLength(1);
    const [spawn] = spawns(env);
    expect(spawn!.command).toBe("notify-send");
    expect(spawn!.args.join(" ")).toContain(basename(env.cwd));
    expect(spawn!.args.join(" ")).toContain("Claude needs your permission to use Bash");
  });

  it("notifies when a turn ran longer than 30 seconds, saying how long it took", async () => {
    const env = envWith("linux", ["notify-send"]);
    const result = await turnLasting(45, env);

    expectNoDecision(result);
    expect(spawns(env)).toHaveLength(1);
    expect(spawns(env)[0]!.args.join(" ")).toContain(basename(env.cwd));
    expect(spawns(env)[0]!.args.join(" ")).toContain("45s");
  });

  it("stays quiet after a short turn", async () => {
    const env = envWith("linux", ["notify-send"]);
    expectNoDecision(await turnLasting(5, env));
    expect(spawns(env)).toHaveLength(0);
  });

  it("returns to the Host without waiting for delivery: it only starts detached processes", async () => {
    const started: string[] = [];
    const neverFinishes: ProcessRunner = {
      run: () => new Promise(() => {}),
      spawnDetached: (command) => void started.push(command),
    };
    const env = envWith("linux", ["notify-send"], { processRunner: neverFinishes });

    expectNoDecision(await runEvent(claudeCode.notification("Claude is waiting for your input"), { env, config: notifyConfig() }));
    expect(started).toEqual(["notify-send"]);
  });

  it.each([
    { platform: "darwin", programs: ["osascript"], command: "osascript" },
    { platform: "darwin", programs: ["osascript", "terminal-notifier"], command: "terminal-notifier" },
    { platform: "linux", programs: ["notify-send"], command: "notify-send" },
    { platform: "win32", programs: ["powershell.exe"], command: "powershell.exe" },
  ] as const)("on $platform with $programs available, notifies with $command", async ({ platform, programs, command }) => {
    const env = envWith(platform, programs);
    expectNoDecision(await runEvent(claudeCode.notification("Claude needs your permission"), { env, config: notifyConfig() }));
    expect(spawns(env).map((spawn) => spawn.command)).toEqual([command]);
    const { args, options } = spawns(env)[0]!;
    const passed = [...args, ...Object.values(options.env ?? {})].join("\n");
    expect(passed).toContain(basename(env.cwd));
    expect(passed).toContain("Claude needs your permission");
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "on %s with no native notifier, falls back to an OSC 9 terminal notification the Host emits",
    async (platform) => {
      const env = envWith(platform, []);
      const result = await runEvent(claudeCode.notification("Claude is waiting for your input"), {
        env,
        config: notifyConfig(),
      });

      expect(spawns(env)).toHaveLength(0);
      const observed = observe(result);
      expect(observed.decision).toBe("none");
      expect(observed.terminalSequence).toBe(
        `\u001b]9;${basename(env.cwd)}: Claude is waiting for your input\u0007`,
      );
    },
  );

  it("strips control characters from the OSC 9 text, so a message can't end the sequence early", async () => {
    const env = envWith("linux", []);
    const result = await runEvent(claudeCode.notification("done\u0007\u001b]52;c;aGk=\u0007 now"), {
      env,
      config: notifyConfig(),
    });
    expect(observe(result).terminalSequence).toBe(`\u001b]9;${basename(env.cwd)}: done]52;c;aGk= now\u0007`);
  });

  it.each([
    { platform: "darwin", programs: ["osascript"], sound: /sound name/ },
    { platform: "darwin", programs: ["terminal-notifier"], sound: /-sound/ },
    { platform: "linux", programs: ["notify-send"], sound: /sound-name/ },
    { platform: "win32", programs: ["powershell.exe"], sound: /Notification\.Default/ },
  ] as const)("on $platform via $programs, plays a sound unless `sound` is off", async ({ platform, programs, sound }) => {
    const notifyWith = async (options: Record<string, unknown>) => {
      const env = envWith(platform, programs);
      await runEvent(claudeCode.notification("Claude needs your permission"), { env, config: notifyConfig(options) });
      return spawns(env)[0]!.args.join("\n");
    };
    expect(await notifyWith({})).toMatch(sound);
    expect(await notifyWith({ sound: true })).toMatch(sound);
    expect(await notifyWith({ sound: false })).not.toMatch(sound);
  });

  it("calls no webhook unless one is configured", async () => {
    const env = envWith("linux", ["notify-send", "curl"]);
    await runEvent(claudeCode.notification("Claude needs your permission"), { env, config: notifyConfig() });
    expect(spawns(env).map((spawn) => spawn.command)).toEqual(["notify-send"]);
  });

  /** The body a detached curl would POST, and where to. */
  function webhookPost(env: FakeEnvironment) {
    const posts = spawns(env).filter((spawn) => spawn.command === "curl");
    expect(posts).toHaveLength(1);
    const { args } = posts[0]!;
    return { url: args[args.indexOf("--url") + 1], body: args[args.indexOf("--data-raw") + 1]! };
  }

  it("posts the notification to a configured ntfy topic, as well as the desktop notification", async () => {
    const env = envWith("linux", ["notify-send"]);
    writeRepoConfig(env, {
      hooks: { notify: { enabled: true, webhook: { kind: "ntfy", url: "https://ntfy.sh/my-agent" } } },
    });
    await runEvent(claudeCode.notification("Claude needs your permission"), { env });

    expect(spawns(env).map((spawn) => spawn.command)).toEqual(["notify-send", "curl"]);
    const { url, body } = webhookPost(env);
    expect(url).toBe("https://ntfy.sh/my-agent");
    expect(body).toContain(basename(env.cwd));
    expect(body).toContain("Claude needs your permission");
  });

  it("posts a Slack message to a configured Slack webhook", async () => {
    const env = envWith("linux", []);
    const config = notifyConfig({ webhook: { kind: "slack", url: "https://hooks.slack.com/services/T/B/X" } });
    await runEvent(claudeCode.notification("Claude needs your permission"), { env, config });

    const { url, body } = webhookPost(env);
    expect(url).toBe("https://hooks.slack.com/services/T/B/X");
    const { text } = JSON.parse(body) as { text: string };
    expect(text).toContain(basename(env.cwd));
    expect(text).toContain("Claude needs your permission");
  });

  it.each([
    { thresholdSeconds: 10, seconds: 15, notified: 1 },
    { thresholdSeconds: 60, seconds: 45, notified: 0 },
  ])(
    "uses the configured threshold: $seconds s turn with thresholdSeconds $thresholdSeconds notifies $notified time(s)",
    async ({ thresholdSeconds, seconds, notified }) => {
      const env = envWith("linux", ["notify-send"]);
      writeRepoConfig(env, { hooks: { notify: { enabled: true, thresholdSeconds } } });
      const { env: timed, advanceSeconds } = withMovableClock(env);

      expectNoDecision(await runEvent(claudeCode.userPromptSubmit("go"), { env: timed }));
      advanceSeconds(seconds);
      expectNoDecision(await runEvent(claudeCode.stop(), { env: timed }));
      expect(spawns(env)).toHaveLength(notified);
    },
  );
});
