import { describe, it } from "vitest";
import {
  claudeCode,
  expectBlocked,
  expectFixture,
  expectNoDecision,
  loadFixtures,
  runEvent,
} from "../../../test/helpers";

describe("git-guard", () => {
  it("blocks `git push --force` with a reason", async () => {
    const result = await runEvent(claudeCode.bash("git push --force origin main"));
    expectBlocked(result, /force/i);
  });

  it.each(["git push -f", "git push -uf origin feature", "git -C repo push origin main --force"])(
    "blocks force-push variant `%s`",
    async (command) => {
      expectBlocked(await runEvent(claudeCode.bash(command)), /force/i);
    },
  );

  it("blocks a force-push hidden in a command list or substitution", async () => {
    expectBlocked(await runEvent(claudeCode.bash("npm test && git push --force")));
    expectBlocked(await runEvent(claudeCode.bash('echo "$(git push -f)"')));
  });

  it.each(["git status", "git push origin main", "git commit -m 'never git push --force'", "ls -f"])(
    "allows `%s`",
    async (command) => {
      expectNoDecision(await runEvent(claudeCode.bash(command)));
    },
  );

  it("ignores non-shell tools", async () => {
    expectNoDecision(await runEvent(claudeCode.preToolUse("Write", { file_path: "notes.md", content: "git push -f" })));
  });

  it("blocks a command it cannot parse, saying so", async () => {
    expectBlocked(await runEvent(claudeCode.bash('git push "unterminated')), /parse/i);
  });

  it.each(loadFixtures(new URL("./fixtures", import.meta.url)))("fixture $file: $description", async (fixture) => {
    expectFixture(await runEvent(JSON.stringify(fixture.payload), { event: fixture.event }), fixture);
  });
});
