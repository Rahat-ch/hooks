# Contributing to hardhooks

Thanks for helping. This page covers setting up, the one testing rule that matters most, and what kinds of change we take as pull requests.

Before you start, read [`CONTEXT.md`](CONTEXT.md) for the vocabulary (Hook, Host, Event, Guard, Decision, Preset) and [`docs/adr/`](docs/adr/) for the decisions behind it. [`AGENTS.md`](AGENTS.md) is the detailed map of the code, written for humans and coding agents alike.

## Setup

You need Node 20 or later and npm.

```sh
npm ci
npm run typecheck
npm run test:e2e      # builds dist/hardhooks.mjs once; every test runs the real CLI
npm test              # the in-process tests still being converted (#22)
npm run test:smoke    # packaging checks on the bundled CLI
npm run check         # all of the above
```

To try your build in Claude Code, run `npm run build && claude --plugin-dir .`. To try it in another repo, run `node /path/to/hooks/dist/hardhooks.mjs init` from that repo.

CI runs typecheck, e2e, unit and smoke tests on Linux, macOS and Windows, each on Node 20, 22 and 24. It also validates the packed Claude Code plugin. `dist/` is build output and is never committed.

## How the code is shaped

- **The dispatcher is the core.** `dispatch()` in `src/dispatcher/` takes an Event name, the raw Host payload and an `Environment` (cwd, home, env, platform, clock, process runner, state dir), and returns `{ stdout, stderr, exitCode }`. That's exactly what the Host sees. The CLI only wraps it.
- **One directory per Hook.** `src/hooks/<name>/index.ts` exports `defineHook({...})`, next to `<name>.test.ts` and `fixtures/*.json`. Register it in `src/hooks/registry.ts`, one line per Hook, sorted by name.
- **Hooks are Host-neutral.** They read the normalized `HookEvent`, match tools by kind (`shell`, `edit`, …), and return a Decision. They never write to stdout or exit the process, and they run external programs only through `env.processRunner`.
- **Guards use shell analysis.** They go through `analyzeShell()` in `src/shell/` and never use regexes over the raw command line. Guards fail closed: when they can't decide, they block and say why ([ADR-0004](docs/adr/0004-guards-fail-closed.md)).
- **Options are typed.** Each Hook declares `optionsSchema` and `defaults: { standard, strict }`. After changing a schema, run `npm run schema` to regenerate `hardhooks.schema.json`. A test fails if it drifts.

## Tests run the real CLI and assert what the Host sees

This is the rule that matters most ([ADR-0006](docs/adr/0006-tests-run-the-real-cli.md)). Every test spawns the bundled CLI, `node dist/hardhooks.mjs …`, exactly as a Host does: a payload on stdin, the project as the working directory, a temp home. Assert only what the Host or user sees: the Decision (`expectBlocked`, `expectAsked`, `expectNoDecision`, `expectContext`, `expectMessage`, `expectAllowedWithWarning`), stderr, and files hardhooks writes for the user. Never call internals, inject test-only Hooks or configs, or fake the clock in-process. That way the protocol, config lookup, the merge rules, the fail modes and the bundle itself are tested every time, and refactors don't break tests.

The harness is in `test/e2e/helpers/`. A test makes its own `sandbox()`, a hermetic world under a temp dir:

```ts
const box = sandbox({ git: true });                   // a real git repo, isolated from your git config
box.writeRepoConfig({ preset: "strict" });             // or writeUserConfig, writeFile
const result = await box.event(claudeCode.bash("git push origin main"));
expectBlocked(result, /main/);
```

- `box.event(payload, { now?, env?, cwd? })` runs `hardhooks run <Event>`; `box.run(args)` runs any command.
- `box.trust()` runs the real `hardhooks trust --yes`, for tests of a project's own commands.
- `box.fakeProgram("npm", { exitCode: 1, stdout: "…" })` puts a fake on PATH that records each call (`calls()`, `waitForCalls()`); `fakeNodePackage` fakes prettier, biome or dprint. On Windows, programs hardhooks starts by bare name without a shell (git, notifiers, gofmt) can't be faked, so those tests are skipped there.
- `box.auditLog()` reads what audit-log wrote: the detected Host and every Hook's Decision.
- `sandbox({ now: "2026-01-01T09:00:00Z" })` fixes the CLI's clock through `HARDHOOKS_NOW`, the one testing knob in the product.

The in-process tests (`runEvent`, `fakeEnvironment`, `runInit`, `runTrust` in `test/helpers/`) are being converted ([#22](https://github.com/Rahat-ch/hooks/issues/22)); don't add new ones.

## Fixtures and corpora

- **Fixtures ship to users.** Every `src/hooks/<name>/fixtures/*.json` is inlined into the bundle and replayed by `hardhooks test` against the *user's* config. A good fixture is a real Host payload with the Decision it should produce. If the expected Decision depends on a Preset or option, declare that with `"assumes": { "preset": "strict", "options": { … } }`, or the fixture fails for users who changed it. The format is in `src/testing/cases.ts`.
- **Captured payloads are the most valuable fixtures.** Turn on `audit-log`, reproduce the behaviour in a real Host, and copy the line from the day's JSONL file. Each line is already a valid case. Scrub anything personal before committing it.
- **Corpora for Guards.** False positives cost as much as false negatives, because every parse failure blocks. A pattern PR should add cases on both sides. Add at least one command that must now be blocked or asked, and at least one harmless near-miss that must still be allowed: the commit message, the `echo` string, the heredoc.

## What to send as a pull request

Send these as pull requests:

- bug fixes, especially Guard bypasses and false positives (each with a failing case first);
- new fixtures, above all captured payloads from Copilot CLI, Cursor, Devin CLI and Continue ([#15](https://github.com/Rahat-ch/hooks/issues/15));
- new Guard patterns: destructive commands, git footguns, secret file locations;
- formatter and check-command detection for more ecosystems;
- shell-analysis coverage: more wrappers unwrapped, more syntax understood;
- Host captures that correct the detection rules or capability table in `src/hosts/index.ts`;
- docs fixes.

Open an issue first for:

- **a new Hook.** Each Hook is a maintenance and false-positive commitment, and has to fit the Preset model.
- new Presets, new config keys that change existing behaviour, new CLI commands, or Adapters for new Hosts.

## Where ideas may come from

hardhooks is MIT-licensed, and it borrows only from MIT- or Apache-2.0-licensed sources, with attribution where code or data is copied. Several of the best existing hook collections are **design references only**. Read them for ideas if you like, but don't copy their code, pattern lists or test data:

| Project | Why it can't be borrowed from |
| --- | --- |
| dcg (destructive_command_guard) | MIT plus a rider barring Anthropic/OpenAI and ML use |
| disler/claude-code-hooks-mastery | no license |
| swiz | PolyForm Noncommercial |
| oh-my-openagent | Sustainable Use License |

[`docs/research/hook-patterns-catalog.md`](docs/research/hook-patterns-catalog.md) has the wider survey with sources. If you aren't sure about a source's license, ask in the issue before you copy anything. Don't add runtime dependencies. The bundle is self-contained, and any new build-time dependency that gets bundled needs a permissive license and its notice preserved.

## Commits and pull requests

- **One logical change per commit.** Write the subject in the imperative mood, in about 72 characters or fewer, and name the area where that helps: `git-guard: ask before git stash clear`, `Shell analysis: unwrap doas`. Explain the *why* in the body, especially for a Guard change: what was bypassed or wrongly blocked.
- **Reference the issue** (`#12`) in the subject or body.
- **Before you push,** `npm run check` must pass. If you changed an options schema, commit the regenerated `hardhooks.schema.json`.
- **Use the glossary terms** from `CONTEXT.md` in code, docs and messages.
- **Branch from `main`.** Keep PRs small enough to review in one sitting.
