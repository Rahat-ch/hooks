/**
 * The JSON Schema shipped for `.hardhooks.json` (`hardhooks.schema.json`),
 * checked with an independent validator (ajv) rather than our own DSL.
 * Regenerate it with `npm run schema` after changing a Hook's options.
 */
import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { presetNames } from "../src/config";
import { configFileSchema, configJsonSchema } from "../src/config/load";
import * as s from "../src/config/schema";
import { defineHook } from "../src/hooks/hook";
import { hooks } from "../src/hooks/registry";
import { claudeCode, expectBlocked, fakeEnvironment, runEvent } from "./helpers";

const schemaFile = fileURLToPath(new URL("../hardhooks.schema.json", import.meta.url));
const examplesDir = fileURLToPath(new URL("../examples/", import.meta.url));
const examples = readdirSync(examplesDir).filter((name) => name.endsWith(".json")).sort();

/** The first test pins the generated schema to the shipped file, so validating with either is the same. */
function shippedSchemaValidator() {
  return new Ajv({ allErrors: true, strict: true }).compile(configJsonSchema(hooks));
}

describe("hardhooks.schema.json", () => {
  it("is generated from the registered Hooks' option schemas (run `npm run schema` to update)", async () => {
    await expect(`${JSON.stringify(configJsonSchema(hooks), null, 2)}\n`).toMatchFileSnapshot(schemaFile);
  });

  it("ships example configs", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)("accepts examples/%s, and so does the dispatcher", async (name) => {
    const validate = shippedSchemaValidator();
    const example = JSON.parse(readFileSync(join(examplesDir, name), "utf8"));
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);

    const env = fakeEnvironment();
    copyFileSync(join(examplesDir, name), join(env.cwd, ".hardhooks.json"));
    const { reason } = expectBlocked(await runEvent(claudeCode.bash("git push --force"), { env }));
    expect(reason).not.toMatch(/config is invalid/);
  });

  it.each([
    { problem: "an unknown top-level key", config: { presets: "strict" } },
    { problem: "an unknown Hook", config: { hooks: { "git-gaurd": {} } } },
    { problem: "an unknown option", config: { hooks: { "git-guard": { typo: true } } } },
    { problem: "a wrong type", config: { hooks: { "git-guard": { enabled: "yes" } } } },
    { problem: "an unknown preset", config: { preset: "paranoid" } },
  ])("rejects $problem, as the dispatcher does", ({ config }) => {
    expect(shippedSchemaValidator()(config)).toBe(false);
  });
});

describe("every registered Hook", () => {
  it.each(hooks.map((hook) => [hook.name, hook] as const))(
    "%s declares a valid option value for every option under every Preset",
    (_name, hook) => {
      const schema = hook.optionsSchema ?? s.object({});
      for (const preset of presetNames) {
        const issues = schema.validate(hook.defaults[preset].options, [preset]);
        expect(issues.map((i) => `${s.formatPath(i.path)}: ${i.message}`)).toEqual([]);
      }
    },
  );
});

describe("the options schema DSL", () => {
  const everyType = defineHook({
    name: "every-type",
    description: "test-only Hook using every schema type",
    events: ["Stop"],
    failMode: "open",
    optionsSchema: s.object({
      flag: s.boolean(),
      label: s.string(),
      timeoutMs: s.number({ integer: true, minimum: 0 }),
      ratio: s.number({ maximum: 1 }),
      mode: s.oneOf(["fast", "slow"]),
      paths: s.array(s.string()),
      webhook: s.optional(s.object({ url: s.string(), kind: s.oneOf(["ntfy", "slack"]) })),
    }),
    defaults: {
      standard: { enabled: false, options: { flag: true, label: "x", timeoutMs: 1, ratio: 0.5, mode: "fast", paths: [] } },
      strict: { enabled: true, options: { flag: true, label: "x", timeoutMs: 1, ratio: 0.5, mode: "fast", paths: [] } },
    },
    run: () => undefined,
  });
  const ajvValidate = new Ajv({ allErrors: true, strict: true }).compile(configJsonSchema([everyType]));
  const dslSchema = configFileSchema([everyType]);
  const entry = (options: Record<string, unknown>) => ({ hooks: { "every-type": options } });

  it.each([
    { valid: true, config: entry({}) },
    { valid: true, config: entry({ flag: false, label: "y", timeoutMs: 0, ratio: -2, mode: "slow", paths: ["a"] }) },
    { valid: true, config: entry({ webhook: { url: "https://ntfy.sh/x", kind: "ntfy" } }) },
    { valid: false, config: entry({ flag: "true" }) },
    { valid: false, config: entry({ label: 1 }) },
    { valid: false, config: entry({ timeoutMs: 1.5 }) },
    { valid: false, config: entry({ timeoutMs: -1 }) },
    { valid: false, config: entry({ ratio: 2 }) },
    { valid: false, config: entry({ mode: "medium" }) },
    { valid: false, config: entry({ paths: [1] }) },
    { valid: false, config: entry({ paths: "a" }) },
    { valid: false, config: entry({ webhook: { url: "https://x" } }) },
    { valid: false, config: entry({ webhook: { url: "https://x", kind: "slack", extra: 1 } }) },
    { valid: false, config: entry({ nope: 1 }) },
  ])("validator and emitted JSON Schema agree that $config is valid: $valid", ({ valid, config }) => {
    expect(ajvValidate(config)).toBe(valid);
    expect(dslSchema.validate(config, []).length === 0).toBe(valid);
  });
});

