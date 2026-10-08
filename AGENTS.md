# AGENTS.md

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `Rahat-ch/hooks` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Development

npm, Node ≥20. `npm ci`, then `npm run typecheck`, `npm test` (unit), `npm run test:smoke` (builds `dist/hardhooks.mjs`, then spawns it). CI runs all of these on Linux, macOS and Windows × Node 20/22/24. `dist/` is build output, never committed.

- **Seam.** `dispatch()` in `src/dispatcher/` takes an Event name, the raw Host payload, a `ResolvedConfig` and an `Environment` (cwd, home, env, platform, clock, process runner, state dir) and returns `{ stdout, stderr, exitCode }`. The CLI (`src/cli.ts` → `src/commands/`) only wraps it. Tests drive `dispatch` via `runEvent` and assert only Host-visible output (`expectBlocked`, `expectAsked`, `expectNoDecision`, `expectContext`), never internals.
- **Test helpers** live in `test/helpers/`: `claudeCode.*` payload builders per Event, `fakeEnvironment()` (temp dirs removed after each test, fixed clock, recording process runner, or `processRunner: "real"` for real git in temp repos; call it inside a test), `loadFixtures`/`expectFixture` for JSON fixture payloads.
- **One directory per Hook**: `src/hooks/<name>/index.ts` exports a `defineHook({...})`, beside `<name>.test.ts` and `fixtures/*.json`. Register it in `src/hooks/registry.ts`: one import and one array entry per line, sorted by name, so parallel branches merge cleanly. Same rule for commands in `src/cli.ts`.
- **Hooks are Host-neutral**: they read the normalized `HookEvent` (`src/event.ts`), match tools by kind (`shell`, `edit`, ...), return a Decision from `src/decision.ts` (`block`, `ask`, `allow`, `addContext`) or `undefined`, and use `env.processRunner` for external programs. Only the dispatcher writes output; Claude Code translation lives in `src/hosts/claude-code.ts`.
- **Shell analysis** for Guards goes through `analyzeShell()` in `src/shell/`.
