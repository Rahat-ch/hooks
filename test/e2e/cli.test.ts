/**
 * The CLI as a whole, as a Host or a person runs it (was
 * test/smoke/cli.test.ts): a Decision on stdout, config from the working
 * directory, trust from a pipe, the Node version check, closed pipes, usage,
 * and a bundle that needs nothing beside it.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { bundlePath, claudeCode, expectBlocked, expectNoDecision, sandbox } from "./helpers";

const forcePush = claudeCode.bash("git push --force origin main");

describe("hardhooks CLI", () => {
  it("`run PreToolUse` denies `git push --force origin main` and exits 0", async () => {
    const result = await sandbox().event(forcePush);
    expectBlocked(result, /force/i);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
  });

  it("`run PreToolUse` allows `git status` with no output", async () => {
    expectNoDecision(await sandbox().event(claudeCode.bash("git status")));
  });

  it("reads .hardhooks.json from its working directory", async () => {
    const box = sandbox();
    box.writeRepoConfig({ hooks: { "git-guard": { enabled: false } } });
    expectNoDecision(await box.event(forcePush));
    box.writeRepoConfig({ hooks: { "git-guard": { enabled: "no" } } });
    expectBlocked(await box.event(forcePush), /hooks\.git-guard\.enabled/);
  });

  it("`trust` gates the repo's own commands: refused from a pipe, granted with --yes, reported and revoked", async () => {
    const box = sandbox({ git: true });
    const marker = join(box.project, "check-ran");
    const command = `node -e "require('fs').writeFileSync('check-ran', '')"`;
    box.writeRepoConfig({ hooks: { check: { enabled: true, command } } });
    const stop = claudeCode.stop();

    const untrusted = await box.event(stop);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(untrusted.stdout).systemMessage).toMatch(/not trusted.*hardhooks trust/);

    const piped = await box.run(["trust"], { stdin: "y\n" });
    expect([piped.exitCode, piped.stderr]).toEqual([1, expect.stringMatching(/needs a terminal/)]);
    expect(piped.stdout).toContain(`check: command from .hardhooks.json: ${command}`);
    expect((await box.run(["trust", "--status"])).exitCode).toBe(1);

    const granted = await box.run(["trust", "--yes"]);
    expect(granted.exitCode, granted.stderr).toBe(0);
    expect((await box.run(["trust", "--status"])).stdout).toContain(`${box.project} is trusted.`);
    await box.event(stop);
    expect(existsSync(marker)).toBe(true);

    expect((await box.run(["trust", "--revoke"])).stdout).toContain(`No longer trusting ${box.project}.`);
    expect((await box.run(["trust", "--status"])).exitCode).toBe(1);
  });

  it("exits 0 silently for an Event no Hook handles", async () => {
    expectNoDecision(await sandbox().event(claudeCode.notification("idle")));
  });

  it("names the Node requirement and refuses to run on Node <20", async () => {
    const fakeOldNode =
      "data:text/javascript," +
      encodeURIComponent(
        'Object.defineProperty(process.versions, "node", { value: "18.19.0" });' +
          'Object.defineProperty(process, "version", { value: "v18.19.0" });',
      );
    const result = await sandbox().event(claudeCode.bash("git status"), { env: { NODE_OPTIONS: `--import=${fakeOldNode}` } });
    expect(result.stderr).toMatch(/Node\.js 20 or later/);
    expect(result.stderr).toMatch(/18\.19\.0/);
    // PreToolUse: exit 2 is a blocking error, so Guards fail closed (ADR-0004).
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });

  // POSIX: `hardhooks init --dry-run | head -1`. Windows pipes report closed readers differently.
  it.skipIf(process.platform === "win32")("ends quietly with 141 (128 + SIGPIPE) when the reader closes its output pipe early", async () => {
    const box = sandbox();
    const { node, bundle } = inject("hardhooksE2E");
    const env = Object.fromEntries(Object.entries(box.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    for (const args of [["init", "--dry-run"], ["test"]]) {
      const child = spawn(node, [bundle, ...args], { cwd: box.project, env, stdio: ["ignore", "pipe", "pipe"] });
      // Close the read end before the CLI writes anything, as `head` does once it has its line.
      child.stdout.destroy();
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
      expect(stderr, args.join(" ")).not.toMatch(/EPIPE|internal error|\n\s+at /);
      expect(status, args.join(" ")).toBe(141);
    }
  });

  it("prints usage and exits 1 for an unknown command", async () => {
    const result = await sandbox().run(["frobnicate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
  });

  it("is one self-contained JS file with no package imports", () => {
    const bundle = bundlePath();
    expect(readdirSync(dirname(bundle))).toEqual(["hardhooks.mjs"]);
    const source = readFileSync(bundle, "utf8");
    const imports = [...source.matchAll(/^\s*import\b[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    const isBuiltin = (specifier: string) => specifier.startsWith("node:") || builtinModules.includes(specifier);
    expect(imports.filter((specifier) => !isBuiltin(specifier!))).toEqual([]);
    expect(source).not.toMatch(/\brequire\(["'][^"']+\.node["']\)/);
  });
});
