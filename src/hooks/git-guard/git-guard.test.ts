import { describe, it } from "vitest";
import {
  claudeCode,
  expectAsked,
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

  describe("sees through wrappers", () => {
    it.each([
      'bash -c "git push -f"',
      "sh -c 'git push --force'",
      'zsh -c "cd repo && git push -f"',
      'bash -lc "git push -f"',
      "env FOO=1 git push --force",
      "FOO=1 git push --force",
      "env -i PATH=/usr/bin git push -f",
      "sudo git push --force",
      "sudo -u deploy -E git push -f",
      "$(echo git) push --force",
      "`echo git` push --force",
      "$(printf git) push -f",
      "nice -n 10 git push -f",
      "timeout 30 git push -f",
      "timeout -s KILL 30s git push -f",
      "command git push -f",
      "exec git push -f",
      "nohup git push -f",
      'eval "git push -f"',
      "eval git push --force",
      "echo origin | xargs git push -f",
      "echo origin | xargs -n 1 -I{} git push -f {}",
      "(cd repo && git push -f)",
      "{ git status; git push -f; }",
      "git status; git push -f",
      "git status || git push -f",
      "git fetch | git push -f",
      "if true; then git push -f; fi",
      "for r in origin; do git push -f $r; done",
      "x=$(git push -f)",
      "cat <(git push -f)",
      "/usr/bin/git push -f",
      "\\git push -f",
      "g'i't push -f",
      "G=git; $G push -f",
      'bash -c "bash -c \\"git push -f\\""',
      'echo "git push -f" | bash',
      "bash <<< 'git push -f'",
      "sh <<EOF\ngit push -f\nEOF",
      "find . -maxdepth 0 -exec git push -f \\;",
    ])("`%s`", async (command) => {
      expectBlocked(await runEvent(claudeCode.bash(command)), /force/i);
    });
  });

  it.each(["git push origin +main", "git push origin +HEAD:main", "git push origin feature +main:main"])(
    "blocks force-pushing a `+refspec`: `%s`",
    async (command) => {
      expectBlocked(await runEvent(claudeCode.bash(command)), /\+|force/i);
    },
  );

  it.each([
    "git reset --hard",
    "git reset --hard HEAD~3",
    "git reset --hard origin/main",
    "git reset --har",
    "sudo git reset --hard",
    "git -C repo reset -q --hard",
  ])("blocks `%s`, which destroys uncommitted work", async (command) => {
    expectBlocked(await runEvent(claudeCode.bash(command)), /reset --hard/);
  });

  it.each([
    "git clean -f",
    "git clean -fdx",
    "git clean -x -f -d",
    "git clean -dfx",
    "git clean -ffd",
    "git clean -d --force",
    "git clean --force -e keep.txt",
    "git clean -e f -fd",
    "bash -c 'git clean -xdf'",
  ])("blocks `%s`, which deletes untracked files", async (command) => {
    expectBlocked(await runEvent(claudeCode.bash(command)), /clean/);
  });

  it.each([
    "git commit --no-verify -m 'wip'",
    "git commit -m 'wip' --no-verify",
    "git commit -n -m wip",
    "git commit -nm wip",
    "git commit -anm wip",
    "git push --no-verify",
    "git push --no-verify origin feature",
    "git commit --no-verif -m wip",
  ])("blocks `%s`, which skips the user's git hooks", async (command) => {
    expectBlocked(await runEvent(claudeCode.bash(command)), /no-verify/);
  });

  it.each([
    "git reset --soft HEAD~1",
    "git reset HEAD file.ts",
    "git reset",
    "git clean -n",
    "git clean -nd",
    "git clean --dry-run -d",
    "git push -n origin main",
    "git commit -m 'skip hooks with --no-verify? no'",
    "git commit -m wip -m 'details: reset --hard'",
    "git stash",
  ])("allows `%s`", async (command) => {
    expectNoDecision(await runEvent(claudeCode.bash(command)));
  });

  it.each([
    ["git push --force-with-lease", /force-with-lease/],
    ["git push --force-with-lease=main:abc123 origin main", /force-with-lease/],
    ["git push --force-with-lease --force-if-includes origin feature", /force-with-lease/],
    ["git checkout -- .", /discard/],
    ["git checkout .", /discard/],
    ["git checkout HEAD -- .", /discard/],
    ["git checkout -f main", /discard/],
    ["git restore .", /discard/],
    ["git restore --source=HEAD~1 :/", /discard/],
    ["git restore --staged --worktree .", /discard/],
    ["git branch -D old-feature", /branch -D/],
    ["git branch --delete --force old-feature", /branch -D/],
    ["git branch -df old-feature", /branch -D/],
  ])("asks before `%s`", async (command, reason) => {
    expectAsked(await runEvent(claudeCode.bash(command)), reason);
  });

  it("blocks rather than asks when a command line both force-pushes and asks", async () => {
    expectBlocked(await runEvent(claudeCode.bash("git branch -D tmp && git push --force")), /force/);
    expectBlocked(await runEvent(claudeCode.bash("git push --force-with-lease --force")), /force/);
  });

  it.each([
    "git checkout feature",
    "git checkout -b feature",
    "git checkout -- src/file.ts",
    "git restore src/file.ts",
    "git restore --staged .",
    "git branch -d merged-feature",
    "git branch -m old new",
  ])("allows `%s`", async (command) => {
    expectNoDecision(await runEvent(claudeCode.bash(command)));
  });

  describe("treats prose and data as data", () => {
    it.each([
      "git status",
      "git push",
      "git push origin main",
      "git push -u origin feature",
      "git commit -m 'never git push --force'",
      'git commit -m "stop using git push --force"',
      'git commit -m "$(cat <<\'EOF\'\nfix: stop running git push --force and git reset --hard\nEOF\n)"',
      'echo "git reset --hard"',
      "echo git push --force",
      "printf '%s\\n' 'git clean -fdx'",
      "cat <<EOF > notes.md\ngit push --force\ngit reset --hard\nEOF",
      "cat <<'EOF' > deploy.sh\ngit push -f origin main\nEOF",
      "tee runbook.md <<< 'git push --force'",
      'grep -rn "git push -f" docs/',
      "rg 'git reset --hard' src",
      "git log --grep='push --force'",
      "ls -f",
      "command -v git",
      "# git push --force\ngit status",
      "git status # then git push --force",
    ])("allows `%s`", async (command) => {
      expectNoDecision(await runEvent(claudeCode.bash(command)));
    });
  });

  it("ignores non-shell tools", async () => {
    expectNoDecision(await runEvent(claudeCode.preToolUse("Write", { file_path: "notes.md", content: "git push -f" })));
  });

  it.each([
    'git push "unterminated',
    "echo $(git push -f",
    "bash -c 'git push \"unterminated'",
    "eval 'git push \"unterminated'",
    "if true; then git status",
  ])("blocks `%s`, which it cannot parse, saying it couldn't be analysed", async (command) => {
    expectBlocked(await runEvent(claudeCode.bash(command)), /couldn't be analysed/);
  });

  it("does not fail on unparseable prose inside data", async () => {
    expectNoDecision(await runEvent(claudeCode.bash(`git commit -m "don't run 'git push --force (please"`)));
    expectNoDecision(await runEvent(claudeCode.bash("cat <<'EOF' > notes.md\nit's \"unbalanced ( prose\nEOF")));
  });

  it.each(loadFixtures(new URL("./fixtures", import.meta.url)))("fixture $file: $description", async (fixture) => {
    expectFixture(await runEvent(JSON.stringify(fixture.payload), { event: fixture.event }), fixture);
  });
});
