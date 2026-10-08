import { join } from "node:path";
import { describe, it } from "vitest";
import { claudeCode, expectBlocked, expectNoDecision, fakeEnvironment, runEvent } from "../../../test/helpers";

const read = (file_path: string) => claudeCode.preToolUse("Read", { file_path });
const edit = (file_path: string) => claudeCode.preToolUse("Edit", { file_path, old_string: "a", new_string: "b" });
const write = (file_path: string) => claudeCode.preToolUse("Write", { file_path, content: "x" });

describe("protect-secrets", () => {
  describe("file tools", () => {
    it("blocks reading `.env`, naming the pattern", async () => {
      expectBlocked(await runEvent(read(".env")), /`\.env`/);
    });

    it.each([
      ["Read", read],
      ["Edit", edit],
      ["Write", write],
    ] as const)("%s of `.env`, `.env.local` and `~/.ssh/id_rsa` is blocked, naming the pattern", async (_, tool) => {
      const env = fakeEnvironment();
      expectBlocked(await runEvent(tool(".env"), { env }), /pattern `\.env`/);
      expectBlocked(await runEvent(tool(join(env.cwd, ".env.local")), { env }), /pattern `\.env\.\*`/);
      expectBlocked(await runEvent(tool(join(env.home, ".ssh", "id_rsa")), { env }), /pattern `~\/\.ssh\/`/);
      expectBlocked(await runEvent(tool("~/.ssh/id_rsa"), { env }), /pattern `~\/\.ssh\/`/);
    });

    it.each([
      "MultiEdit",
      "NotebookEdit",
    ])("blocks %s of a secret", async (tool) => {
      expectBlocked(await runEvent(claudeCode.preToolUse(tool, { file_path: "config/.env.production", notebook_path: "x.pem" })));
    });

    it.each([".env.example", ".env.sample", ".env.template", "config/.env.example", "src/env.ts", "README.md", "id_rsa.pub"])(
      "allows `%s`",
      async (path) => {
        expectNoDecision(await runEvent(read(path)));
        expectNoDecision(await runEvent(write(path)));
      },
    );

    it.each([
      ["server.pem", "*.pem"],
      ["certs/tls.key", "*.key"],
      ["store.p12", "*.p12"],
      ["deploy/id_ed25519", "id_ed25519*"],
      ["~/.aws/credentials", "~/.aws/credentials"],
      ["~/.config/gcloud/application_default_credentials.json", "~/.config/gcloud/"],
      ["~/.azure/msal_token_cache.json", "~/.azure/"],
      ["~/.kube/config", "~/.kube/config"],
      ["~/.docker/config.json", "~/.docker/config.json"],
      ["~/.netrc", ".netrc"],
      ["~/.git-credentials", "~/.git-credentials"],
    ])("blocks `%s` (pattern %s)", async (path, pattern) => {
      const result = await runEvent(read(path));
      expectBlocked(result, new RegExp(`pattern \`${pattern.replace(/[.*/]/g, "\\$&")}\``));
    });

    it("allows the public half of an SSH key pair", async () => {
      expectNoDecision(await runEvent(read("~/.ssh/id_ed25519.pub")));
    });

    it("allows files inside a Python virtualenv named `.env`", async () => {
      expectNoDecision(await runEvent(read(".env/bin/activate")));
    });
  });

  describe("search tools", () => {
    it("blocks a search targeting a protected path", async () => {
      expectBlocked(await runEvent(claudeCode.preToolUse("Grep", { pattern: "KEY", path: ".env" })), /`\.env`/);
      expectBlocked(await runEvent(claudeCode.preToolUse("Grep", { pattern: "KEY", path: "~/.ssh" })), /\.ssh/);
      expectBlocked(await runEvent(claudeCode.preToolUse("Glob", { pattern: "*", path: "~/.aws/sso/cache" })));
    });

    it("blocks a content search whose file glob selects secrets", async () => {
      expectBlocked(await runEvent(claudeCode.preToolUse("Grep", { pattern: "KEY", glob: ".env*" })), /\.env/);
      expectBlocked(await runEvent(claudeCode.preToolUse("Grep", { pattern: "BEGIN", glob: "**/*.pem" })), /\*\.pem/);
    });

    it("allows broad searches that don't target a protected path", async () => {
      expectNoDecision(await runEvent(claudeCode.preToolUse("Grep", { pattern: "TODO" })));
      expectNoDecision(await runEvent(claudeCode.preToolUse("Grep", { pattern: "TODO", path: "src", glob: "*.ts" })));
      expectNoDecision(await runEvent(claudeCode.preToolUse("Glob", { pattern: "**/*.ts" })));
      expectNoDecision(await runEvent(claudeCode.preToolUse("Glob", { pattern: ".env*" })));
    });
  });
});
