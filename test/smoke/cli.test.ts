/**
 * Real-process smoke tests: spawn the bundled CLI with node, feed stdin, and
 * check what the Host would see. Requires `npm run build` first
 * (`npm run test:smoke` does both). Keep this set small; behaviour belongs in
 * dispatcher-seam tests.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { claudeCode, expectBlocked, expectNoDecision } from "../helpers";

const distDir = fileURLToPath(new URL("../../dist/", import.meta.url));
const bundle = fileURLToPath(new URL("../../dist/hardhooks.mjs", import.meta.url));

function hardhooks(args: string[], stdin: string, nodeArgs: string[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, bundle, ...args], { input: stdin, encoding: "utf8", ...options });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? -1 };
}

describe("hardhooks CLI (bundled)", () => {
  beforeAll(() => {
    if (!existsSync(bundle)) throw new Error(`${bundle} is missing: run \`npm run build\` first`);
  });

  it("`run PreToolUse` denies `git push --force origin main` and exits 0", () => {
    const result = hardhooks(["run", "PreToolUse"], JSON.stringify(claudeCode.bash("git push --force origin main")));
    expectBlocked(result, /force/i);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
  });

  it("`run PreToolUse` allows `git status` with no output", () => {
    expectNoDecision(hardhooks(["run", "PreToolUse"], JSON.stringify(claudeCode.bash("git status"))));
  });

  it("reads .hardhooks.json from its working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "hardhooks-smoke-"));
    try {
      // Point every user-config location into the temp dir so a developer's own config can't interfere.
      const env = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config"), APPDATA: join(root, "config") };
      const forcePush = JSON.stringify(claudeCode.bash("git push --force origin main"));
      writeFileSync(join(root, ".hardhooks.json"), JSON.stringify({ hooks: { "git-guard": { enabled: false } } }));
      expectNoDecision(hardhooks(["run", "PreToolUse"], forcePush, [], { cwd: root, env }));
      writeFileSync(join(root, ".hardhooks.json"), JSON.stringify({ hooks: { "git-guard": { enabled: "no" } } }));
      expectBlocked(hardhooks(["run", "PreToolUse"], forcePush, [], { cwd: root, env }), /hooks\.git-guard\.enabled/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("`init` writes a settings entry that runs this bundle, and `uninstall` removes it", () => {
    const root = mkdtempSync(join(tmpdir(), "hardhooks-smoke-"));
    try {
      const project = join(root, "project");
      mkdirSync(project);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config"), APPDATA: join(root, "config") };
      delete env.CLAUDE_CONFIG_DIR;
      const settingsFile = join(project, ".claude", "settings.json");

      const declined = hardhooks(["init"], "n\n", [], { cwd: project, env });
      expect(declined.stdout).toMatch(/^\+.*"PreToolUse"/m);
      expect(existsSync(settingsFile)).toBe(false);

      const accepted = hardhooks(["init"], "y\n", [], { cwd: project, env });
      expect(accepted.exitCode, accepted.stderr).toBe(0);
      const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
      const [group] = settings.hooks.PreToolUse;
      expect(group.matcher).toContain("Bash");
      const [handler] = group.hooks;
      expect(handler).toEqual({ type: "command", command: "node", args: [realpathSync(bundle), "run", "PreToolUse"] });

      // Run the written command the way the Host would (exec form: no shell).
      const forcePush = spawnSync(handler.command, handler.args, {
        input: JSON.stringify(claudeCode.bash("git push --force origin main")),
        encoding: "utf8",
        cwd: project,
        env,
      });
      expectBlocked({ stdout: forcePush.stdout, stderr: forcePush.stderr, exitCode: forcePush.status ?? -1 }, /force/i);

      const removed = hardhooks(["uninstall", "--yes"], "", [], { cwd: project, env });
      expect(removed.exitCode, removed.stderr).toBe(0);
      expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("`trust` gates the repo's own commands: refused from a pipe, granted with --yes, reported and revoked", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hardhooks-smoke-")));
    try {
      const project = join(root, "project");
      mkdirSync(join(project, ".git"), { recursive: true });
      const config = join(root, "config");
      // Keep config and trust state in the temp dir, and run as a person would (not inside an agent's shell).
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: config,
        APPDATA: config,
        XDG_STATE_HOME: join(root, "state"),
        LOCALAPPDATA: join(root, "local"),
      };
      delete env.CLAUDECODE;
      const marker = join(project, "check-ran");
      const command = `node -e "require('fs').writeFileSync('check-ran', '')"`;
      writeFileSync(join(project, ".hardhooks.json"), JSON.stringify({ hooks: { check: { enabled: true, command } } }));
      const stop = JSON.stringify(claudeCode.stop({ cwd: project }));
      const run = (args: string[], stdin = "") => hardhooks(args, stdin, [], { cwd: project, env });

      const untrusted = run(["run", "Stop"], stop);
      expect(existsSync(marker)).toBe(false);
      expect(JSON.parse(untrusted.stdout).systemMessage).toMatch(/not trusted.*hardhooks trust/);

      const piped = run(["trust"], "y\n");
      expect([piped.exitCode, piped.stderr]).toEqual([1, expect.stringMatching(/needs a terminal/)]);
      expect(piped.stdout).toContain(`check: command from .hardhooks.json: ${command}`);
      expect(run(["trust", "--status"]).exitCode).toBe(1);

      const granted = run(["trust", "--yes"]);
      expect(granted.exitCode, granted.stderr).toBe(0);
      expect(run(["trust", "--status"]).stdout).toContain(`${project} is trusted.`);
      run(["run", "Stop"], stop);
      expect(existsSync(marker)).toBe(true);

      expect(run(["trust", "--revoke"]).stdout).toContain(`No longer trusting ${project}.`);
      expect(run(["trust", "--status"]).exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 0 silently for an Event no Hook handles", () => {
    expectNoDecision(hardhooks(["run", "Notification"], JSON.stringify(claudeCode.notification("idle"))));
  });

  it("names the Node requirement and refuses to run on Node <20", () => {
    const fakeOldNode =
      "data:text/javascript," +
      encodeURIComponent(
        'Object.defineProperty(process.versions, "node", { value: "18.19.0" });' +
          'Object.defineProperty(process, "version", { value: "v18.19.0" });',
      );
    const result = hardhooks(["run", "PreToolUse"], JSON.stringify(claudeCode.bash("git status")), [
      "--import",
      fakeOldNode,
    ]);
    expect(result.stderr).toMatch(/Node\.js 20 or later/);
    expect(result.stderr).toMatch(/18\.19\.0/);
    // PreToolUse: exit 2 is a blocking error, so Guards fail closed (ADR-0004).
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });

  // POSIX: `hardhooks init --dry-run | head -1`. Windows pipes report closed readers differently.
  it.skipIf(process.platform === "win32")(
    "ends quietly with 141 (128 + SIGPIPE) when the reader closes its output pipe early",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "hardhooks-smoke-"));
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
        delete env.CLAUDE_CONFIG_DIR;
        for (const args of [["init", "--dry-run"], ["test"]]) {
          const child = spawn(process.execPath, [bundle, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
          // Close the read end before the CLI writes anything, as `head` does once it has its line.
          child.stdout.destroy();
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
          const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
          expect(stderr, args.join(" ")).not.toMatch(/EPIPE|internal error|\n\s+at /);
          expect(status, args.join(" ")).toBe(141);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("prints usage and exits 1 for an unknown command", () => {
    const result = hardhooks(["frobnicate"], "");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/usage/i);
  });

  it("is one self-contained JS file with no package imports", () => {
    expect(readdirSync(distDir)).toEqual(["hardhooks.mjs"]);
    const source = readFileSync(bundle, "utf8");
    const imports = [...source.matchAll(/^\s*import\b[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    const isBuiltin = (specifier: string) => specifier.startsWith("node:") || builtinModules.includes(specifier);
    expect(imports.filter((specifier) => !isBuiltin(specifier!))).toEqual([]);
    expect(source).not.toMatch(/\brequire\(["'][^"']+\.node["']\)/);
  });
});
