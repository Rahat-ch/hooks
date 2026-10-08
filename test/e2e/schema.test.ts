/**
 * The JSON Schema shipped for `.hardhooks.json` (`hardhooks.schema.json`):
 * an independent validator (ajv) reading the shipped file must agree with
 * what the real CLI accepts and rejects. Regenerate the file with
 * `npm run schema` after changing a Hook's options.
 *
 * Two checks here read the source rather than run the CLI, because no CLI
 * command prints the schema or the Presets' option values: the shipped file
 * must equal the schema generated from the registered Hooks (drift), and each
 * Hook's Preset defaults (taken from the registry as input) must be a config
 * both the shipped schema and the CLI accept.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { configJsonSchema } from "../../src/config/load";
import { hooks } from "../../src/hooks/registry";
import { claudeCode, expectBlocked, expectNoDecision, sandbox } from "./helpers";

const schemaFile = fileURLToPath(new URL("../../hardhooks.schema.json", import.meta.url));
const examplesDir = fileURLToPath(new URL("../../examples/", import.meta.url));
const examples = readdirSync(examplesDir).filter((name) => name.endsWith(".json")).sort();

/** The shipped schema file, compiled by ajv. */
function shippedSchemaValidator() {
  return new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(schemaFile, "utf8")));
}

/** Run the real CLI with `config` as the project's `.hardhooks.json`: it accepts it, or blocks naming the problem. */
async function expectCliAgrees(config: unknown, valid: boolean): Promise<void> {
  const box = sandbox();
  box.writeRepoConfig(config as object);
  const result = await box.event(claudeCode.bash("ls"));
  if (valid) {
    expectNoDecision(result);
    expect(result.stderr).not.toMatch(/invalid config/);
  } else {
    expectBlocked(result, /config is invalid/);
  }
}

describe("hardhooks.schema.json", () => {
  it("is generated from the registered Hooks' option schemas (run `npm run schema` to update)", async ({ expect }) => {
    await expect(`${JSON.stringify(configJsonSchema(hooks), null, 2)}\n`).toMatchFileSnapshot(schemaFile);
  });

  it("ships example configs", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)("accepts examples/%s, and so does the CLI", async (name) => {
    const validate = shippedSchemaValidator();
    const text = readFileSync(join(examplesDir, name), "utf8");
    expect(validate(JSON.parse(text)), JSON.stringify(validate.errors)).toBe(true);

    const box = sandbox();
    box.writeRepoConfig(text);
    const { reason } = expectBlocked(await box.event(claudeCode.bash("git push --force")));
    expect(reason).not.toMatch(/config is invalid/);
  });

  it.each([
    { problem: "an unknown top-level key", config: { presets: "strict" } },
    { problem: "an unknown Hook", config: { hooks: { "git-gaurd": {} } } },
    { problem: "an unknown option", config: { hooks: { "git-guard": { typo: true } } } },
    { problem: "a wrong type", config: { hooks: { "git-guard": { enabled: "yes" } } } },
    { problem: "an unknown preset", config: { preset: "paranoid" } },
  ])("rejects $problem, as the CLI does", async ({ config }) => {
    expect(shippedSchemaValidator()(config)).toBe(false);
    await expectCliAgrees(config, false);
  });
});

describe("every registered Hook", () => {
  it.each(hooks.map((hook) => [hook.name, hook] as const))(
    "%s's options under every Preset, written out in full, are a config the schema and the CLI accept",
    async (name, hook) => {
      const validate = shippedSchemaValidator();
      for (const preset of ["standard", "strict"] as const) {
        const config = { preset, hooks: { [name]: hook.defaults[preset].options } };
        expect(validate(config), `${preset}: ${JSON.stringify(validate.errors)}`).toBe(true);
        await expectCliAgrees(config, true);
      }
    },
  );
});

/**
 * Each option type the schema can express, through a real Hook option of that
 * type (there are no test-only Hooks): the shipped schema and the CLI agree.
 */
describe("option types", () => {
  it.each([
    // An empty Hook entry.
    { valid: true, config: { hooks: { notify: {} } } },
    // A value of every type: boolean, string, integer at its minimum, number below its maximum, enum, array of strings.
    {
      valid: true,
      config: {
        hooks: {
          notify: { sound: false, thresholdSeconds: 2.5, webhook: { url: "https://ntfy.sh/x", kind: "slack" } },
          check: { command: "y", outputBytes: 8999 },
          "audit-log": { maxOutputBytes: 0 },
          "session-context": { files: ["a"] },
        },
      },
    },
    // An optional object with an enum inside.
    { valid: true, config: { hooks: { notify: { webhook: { url: "https://ntfy.sh/x", kind: "ntfy" } } } } },
    // A string for a boolean.
    { valid: false, config: { hooks: { notify: { sound: "true" } } } },
    // A number for a string.
    { valid: false, config: { hooks: { check: { command: 1 } } } },
    // A fraction for an integer.
    { valid: false, config: { hooks: { "audit-log": { maxOutputBytes: 1.5 } } } },
    // Below the minimum.
    { valid: false, config: { hooks: { "audit-log": { maxOutputBytes: -1 } } } },
    // Above the maximum.
    { valid: false, config: { hooks: { check: { outputBytes: 9001 } } } },
    // Not one of the enum's values.
    { valid: false, config: { hooks: { notify: { webhook: { url: "https://x", kind: "medium" } } } } },
    // A wrong array item.
    { valid: false, config: { hooks: { "session-context": { files: [1] } } } },
    // A string for an array.
    { valid: false, config: { hooks: { "session-context": { files: "a" } } } },
    // A nested object missing a required key.
    { valid: false, config: { hooks: { notify: { webhook: { url: "https://x" } } } } },
    // A nested object with an unknown key.
    { valid: false, config: { hooks: { notify: { webhook: { url: "https://x", kind: "slack", extra: 1 } } } } },
    // An unknown option.
    { valid: false, config: { hooks: { notify: { nope: 1 } } } },
  ])("the shipped schema and the CLI agree that $config is valid: $valid", async ({ valid, config }) => {
    expect(shippedSchemaValidator()(config)).toBe(valid);
    await expectCliAgrees(config, valid);
  });
});
