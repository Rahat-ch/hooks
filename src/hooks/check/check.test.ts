import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeCode,
  expectBlocked,
  expectMessage,
  expectNoDecision,
  fakeEnvironment,
  runEvent,
  writeRepoConfig,
  type FakeEnvironment,
} from "../../../test/helpers";

/**
 * Check commands run through the platform shell (sh on POSIX, cmd.exe on
 * Windows), so test commands stick to `node -e "..."` with double quotes and
 * `&&`, which mean the same in both.
 */
const node = (script: string) => `node -e "${script}"`;

/** A temp project with real processes and enough of the real environment (PATH) to find node, git and the shell. */
function realEnvironment(): FakeEnvironment {
  const passthrough = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP", "WINDIR"];
  const env = Object.fromEntries(passthrough.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
  return fakeEnvironment({ processRunner: "real", env });
}

function enableCheck(env: FakeEnvironment, options: Record<string, unknown> = {}) {
  writeRepoConfig(env, { hooks: { check: { enabled: true, ...options } } });
}

describe("check", () => {
  it("blocks Stop when the configured command fails, with its output in the reason", async () => {
    const env = realEnvironment();
    enableCheck(env, { command: node("console.error('lint: 3 problems in src/a.ts'); process.exit(1)") });

    const { reason } = expectBlocked(await runEvent(claudeCode.stop(), { env }), /3 problems in src\/a\.ts/);
    expect(reason).toContain("node -e");
  });

  it("allows Stop when the configured command passes", async () => {
    const env = realEnvironment();
    enableCheck(env, { command: node("process.exit(0)") });
    expectNoDecision(await runEvent(claudeCode.stop(), { env }));
  });

  it("truncates long failure output to the byte budget, keeping its start and end", async () => {
    const env = realEnvironment();
    const noisy = "console.log('FIRST-LINE'); for (let i = 0; i < 5000; i++) console.log('noise line ' + i); console.log('LAST-LINE'); process.exit(1)";
    enableCheck(env, { command: node(noisy), outputBytes: 1000 });

    const { reason } = expectBlocked(await runEvent(claudeCode.stop(), { env }), /FIRST-LINE[\s\S]*omitted[\s\S]*LAST-LINE/);
    expect(Buffer.byteLength(reason!)).toBeLessThan(1500);
  });

  describe("with no command configured", () => {
    it("detects a package.json `lint` script, runs it and announces it", async () => {
      const env = realEnvironment();
      enableCheck(env);
      writePackageJson(env, { lint: node("require('fs').writeFileSync('lint-ran', '')") });

      expectMessage(await runEvent(claudeCode.stop(), { env }), /`npm run lint`.*package\.json/);
      expect(existsSync(join(env.cwd, "lint-ran"))).toBe(true);
    });

    it("names the detected command when it blocks", async () => {
      const env = realEnvironment();
      enableCheck(env);
      writePackageJson(env, { lint: node("console.log('2 lint errors'); process.exit(1)") });

      expectBlocked(await runEvent(claudeCode.stop(), { env }), /`npm run lint`[\s\S]*package\.json[\s\S]*2 lint errors/);
    });

    it.each([
      {
        project: "package.json with lint, typecheck and test scripts",
        files: { "package.json": scripts({ test: "vitest run", typecheck: "tsc", lint: "eslint ." }) },
        command: "npm run lint && npm run typecheck && npm run test",
      },
      {
        project: "a pnpm lockfile",
        files: { "package.json": scripts({ test: "vitest run" }), "pnpm-lock.yaml": "" },
        command: "pnpm run test",
      },
      {
        project: "a yarn lockfile",
        files: { "package.json": scripts({ lint: "eslint ." }), "yarn.lock": "" },
        command: "yarn run lint",
      },
      {
        project: "ruff configured in pyproject.toml",
        files: { "pyproject.toml": "[project]\nname = 'x'\n\n[tool.ruff]\nline-length = 100\n" },
        command: "ruff check .",
      },
      { project: "a ruff.toml", files: { "ruff.toml": "line-length = 100\n" }, command: "ruff check ." },
      { project: "a go.mod", files: { "go.mod": "module example.com/x\n" }, command: "go vet ./..." },
      { project: "a Cargo.toml", files: { "Cargo.toml": "[package]\nname = 'x'\n" }, command: "cargo check" },
      {
        project: "package.json scripts before go.mod",
        files: { "package.json": scripts({ lint: "eslint ." }), "go.mod": "module example.com/x\n" },
        command: "npm run lint",
      },
    ])("detects `$command` in a project with $project", async ({ files, command }) => {
      const env = fakeEnvironment();
      enableCheck(env);
      for (const [name, content] of Object.entries(files)) writeFileSync(join(env.cwd, name), content);

      expectMessage(await runEvent(claudeCode.stop(), { env }), new RegExp(`ran \`${escapeRegExp(command)}\` \\(detected`));
    });

    it.each([
      { project: "no recognised check", files: { "README.md": "# hi\n" } },
      { project: "only npm init's placeholder test script", files: { "package.json": scripts({ test: 'echo "Error: no test specified" && exit 1' }) } },
      { project: "pyproject.toml without ruff", files: { "pyproject.toml": "[project]\nname = 'x'\n" } },
    ])("does nothing in a project with $project", async ({ files }) => {
      const env = fakeEnvironment();
      enableCheck(env);
      for (const [name, content] of Object.entries(files)) writeFileSync(join(env.cwd, name), content);
      expectNoDecision(await runEvent(claudeCode.stop(), { env }));
    });
  });
});

function scripts(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "fixture", private: true, scripts });
}

function writePackageJson(env: FakeEnvironment, packageScripts: Record<string, string>) {
  writeFileSync(join(env.cwd, "package.json"), scripts(packageScripts));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
