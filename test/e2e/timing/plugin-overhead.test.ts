/**
 * Timed runs of the real CLI. The `timing` vitest project runs these files
 * after every other test has finished (`sequence.groupOrder`), and
 * `describe.sequential` keeps their measurements from overlapping, so they
 * measure on a quiet machine: under the rest of the suite's concurrent load,
 * the plugin overhead below measured 100-200 ms instead of about 5 ms.
 */
import { describe, expect, it } from "vitest";
import { everyEvent, expectNoDecision, installPlugin, runPluginHook, sandbox, spawnAsHost } from "../helpers";

describe.sequential("Events no enabled Hook handles", () => {
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

  // The static plugin hooks file runs the dispatcher on every Event, so the
  // ones with nothing to do must cost little more than starting Node. No
  // `standard` Hook handles these Events.
  it.each(["Notification", "SessionEnd", "PreCompact"] as const)(
    "`run %s` through the plugin exits 0 with no output, within 100 ms of a bare `node` start",
    async (event) => {
      const box = sandbox();
      const plugin = await installPlugin(box);
      const payload = everyEvent[event];
      const runs = 5;
      const baseline: number[] = [];
      const hardhooks: number[] = [];
      for (let i = 0; i < runs; i++) {
        const bare = await spawnAsHost("node", ["-e", ""], { cwd: box.project, env: box.env, stdin: JSON.stringify(payload) });
        baseline.push(bare.durationMs);
        const result = await runPluginHook(box, plugin, event, payload);
        expectNoDecision(result);
        expect(result.stderr).toBe("");
        hardhooks.push(result.durationMs);
      }
      // Generous bound for slow CI runners; locally the overhead is about 5 ms.
      expect(median(hardhooks) - median(baseline)).toBeLessThan(100);
    },
  );
});
