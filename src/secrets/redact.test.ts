import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsDeep } from "./redact";

describe("redactSecrets", () => {
  it.each([
    ["an OpenAI key", "use sk-proj-Ab3dEf6hIj9kLm2nOp5q to call", "use [REDACTED] to call"],
    ["an Anthropic key", "sk-ant-api03-Zx8yW7vU6tS5rQ4pO3nM", "[REDACTED]"],
    ["a classic GitHub token", "git clone https://ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8@github.com/o/r", "git clone https://[REDACTED]@github.com/o/r"],
    ["a fine-grained GitHub token", "github_pat_11AAAAAAA0abcdefghij_KLMNOPQRSTUVWXYZ0123456789", "[REDACTED]"],
    ["a Slack bot token", "token xoxb-1234567890-0987654321-AbCdEfGhIjKl", "token [REDACTED]"],
    ["an AWS access key id", "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE", "aws configure set aws_access_key_id [REDACTED]"],
    [
      "a JWT",
      "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U done",
      "jwt=[REDACTED] done",
    ],
    ["a bearer token", 'curl -H "Authorization: Bearer abc123def456ghi789" https://api.example.com', 'curl -H "Authorization: Bearer [REDACTED]" https://api.example.com'],
    ["password=", "mysql --password=hunter2 -u root", "mysql --password=[REDACTED] -u root"],
    ["an env assignment", "export STRIPE_SECRET_KEY=whsec_not_a_known_prefix && npm start", "export STRIPE_SECRET_KEY=[REDACTED] && npm start"],
    ["a quoted JSON value", '{"password": "correct horse", "user": "me"}', '{"password": "[REDACTED]", "user": "me"}'],
    ["a YAML value", "api_key: 0123abcd\nname: demo", "api_key: [REDACTED]\nname: demo"],
    ["URL credentials", "postgres://admin:s3cretpw@db.internal:5432/app", "postgres://admin:[REDACTED]@db.internal:5432/app"],
    [
      "a private key block",
      "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\nafter",
      "before\n[REDACTED]\nafter",
    ],
  ])("redacts %s", (_, text, expected) => {
    expect(redactSecrets(text)).toBe(expected);
  });

  it.each([
    ["a force-push", "git push --force origin main"],
    ["a token count", "max_tokens: 1024"],
    ["the working directory variable", "PWD=/home/user/demo"],
    ["prose about tokens", "the token expired, so ask for a new one"],
    ["a package name", "pip install scikit-learn sk-video"],
    ["a placeholder", "password=[REDACTED]"],
  ])("leaves %s alone", (_, text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactSecretsDeep", () => {
  it("redacts every string in a JSON value, keeping its shape", () => {
    const value = { command: "echo sk-proj-Ab3dEf6hIj9kLm2nOp5q", n: 3, ok: true, list: ["password=hunter2", null] };
    expect(redactSecretsDeep(value)).toEqual({ command: "echo [REDACTED]", n: 3, ok: true, list: ["password=[REDACTED]", null] });
  });
});
