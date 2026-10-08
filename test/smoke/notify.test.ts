/**
 * Real-process smoke test for notify's detached delivery: the bundled CLI must
 * exit while the notifier it started is still running. A slow fake notifier
 * stands in for the real one, so no notification is ever shown.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCode } from "../helpers";

const bundle = fileURLToPath(new URL("../../dist/hardhooks.mjs", import.meta.url));

// The fake is a shell script, so it can stand in for osascript or notify-send but not powershell.exe.
describe.skipIf(process.platform === "win32")("notify (bundled)", () => {
  it("returns to the Host while the notifier is still running", async () => {
    const root = mkdtempSync(join(tmpdir(), "hardhooks-smoke-"));
    try {
      const bin = join(root, "bin");
      const marker = join(root, "notified");
      mkdirSync(bin);
      const fake = process.platform === "darwin" ? "osascript" : "notify-send";
      writeFileSync(join(bin, fake), `#!/bin/sh\nsleep 2\necho "$@" > "${marker}"\n`, { mode: 0o755 });
      writeFileSync(join(root, ".hardhooks.json"), JSON.stringify({ hooks: { notify: { enabled: true } } }));
      const env = {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
      };

      const start = performance.now();
      const payload = JSON.stringify({ ...claudeCode.notification("Claude needs your permission"), cwd: root });
      const result = spawnSync(process.execPath, [bundle, "run", "Notification"], { input: payload, encoding: "utf8", cwd: root, env });
      const elapsed = performance.now() - start;

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(elapsed).toBeLessThan(1500);
      expect(existsSync(marker)).toBe(false);

      // The detached notifier carries on after the CLI has exited.
      for (let waited = 0; waited < 10_000 && !existsSync(marker); waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(readFileSync(marker, "utf8")).toContain("Claude needs your permission");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
