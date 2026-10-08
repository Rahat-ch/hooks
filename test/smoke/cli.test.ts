/**
 * Real-process smoke tests: spawn the bundled CLI with node, feed stdin, and
 * check what the Host would see. Requires `npm run build` first
 * (`npm run test:smoke` does both). Keep this set small; behaviour belongs in
 * dispatcher-seam tests.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { claudeCode, expectBlocked, expectNoDecision } from "../helpers";

const distDir = fileURLToPath(new URL("../../dist/", import.meta.url));
const bundle = fileURLToPath(new URL("../../dist/hardhooks.mjs", import.meta.url));

function hardhooks(args: string[], stdin: string, nodeArgs: string[] = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, bundle, ...args], { input: stdin, encoding: "utf8" });
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
