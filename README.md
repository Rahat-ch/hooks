# hardhooks

**Deterministic guardrails for nondeterministic agents.**

hardhooks is a set of eight tested, configurable hooks for AI coding agents. It blocks destructive shell and git commands, keeps secrets out of the conversation, formats edited files, briefs the agent at session start, runs your checks before it says "done", and notifies or logs what happened. You write the hooks once in Claude Code's hook format, and Claude Code, Copilot CLI, Cursor, Devin CLI and Continue all read it from `.claude/settings.json`.

Why not copy a hook script from a blog post?

- **Parser-based, not regex.** The three Guards parse the command line with a real bash parser ([`unbash`](https://github.com/webpro-nl/unbash)). They see through `bash -c`, `sudo`, `env`, `xargs`, `eval`, `$()`, pipelines and `&&` chains, and they treat flag orders like `-rf`, `-r -f` and `--recursive --force` as the same command. A commit message or an `echo` string that only *mentions* `rm -rf /` doesn't trigger them.
- **Tested.** Every Hook ships fixtures. `hardhooks test` replays them against *your* config, together with your own cases, so CI can prove that force-pushing to `main` is blocked in your repo.
- **Correct protocol.** Hooks answer with Claude Code's documented JSON output, never with `exit 1`. Guards fail closed: a parse error, timeout, crash or invalid config blocks with a reason instead of silently allowing.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Presets](#presets)
- [Hooks](#hooks)
- [Configuration](#configuration)
- [Trust](#trust)
- [Testing your setup: `hardhooks test`](#testing-your-setup-hardhooks-test)
- [Audit log](#audit-log)
- [Host compatibility](#host-compatibility)
- [Uninstall](#uninstall)
- [Limitations](#limitations)
- [License](#license)

## Requirements

- **Node.js 20 or later** on the `PATH` the agent uses. On older versions every hook prints a clear error, and PreToolUse blocks, so the Guards still fail closed.
- **git** for the git-aware features: `git-guard`'s protected branches, `session-context`'s branch summary, `check`'s skip-when-unchanged, and gitignore-aware deletes in `block-destructive-shell`. Without git these features do nothing and the Hooks still run.
- macOS, Linux or Windows. CI tests all three on Node 20, 22 and 24.

## Install

Pick **one** of these two methods. If you use both, Claude Code runs the dispatcher twice for every Event (once from your settings, once from the plugin), so every Guard, notification and audit-log entry happens twice.

### npm (all Hosts)

```sh
npm i -g hardhooks
cd your-repo
hardhooks init
```

`init` prints the entries it will add to `.claude/settings.json` as a diff and asks before writing. It adds one entry per Event, and only for the Events your enabled Hooks need. It keeps every existing setting and hook, and you can run it again whenever you enable or disable a Hook.

```
hardhooks init [--user] [--dry-run] [--yes]
```

- `--user` writes your user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`), so the Hooks run in every repo.
- `--dry-run` prints the diff and writes nothing.
- `--yes` writes without asking.

The entries run `node <absolute path to the bundle> run <Event>`, never `npx`, because spawning through `npx` costs about 147 ms per Event against about 19 ms. With a global install, that path is specific to your machine. Re-run `init` if it moves, for example after switching Node versions under nvm. To commit `.claude/settings.json` for a team, install hardhooks into the project instead, so the entries point at `${CLAUDE_PROJECT_DIR}/node_modules/hardhooks/…`:

```sh
npm i -D hardhooks
npx hardhooks init
```

`npx` is fine for running `init` once. Only the hook entries themselves avoid it.

### Claude Code plugin (Claude Code only)

```sh
claude plugin marketplace add Rahat-ch/hooks
claude plugin install hardhooks@hardhooks
```

The plugin runs the dispatcher for every Event, and `.hardhooks.json` decides which Hooks act. Nothing is written to your settings.

## Presets

Set a Preset in `.hardhooks.json`. With no config at all, you get `standard`.

| Hook | Kind | `standard` (default) | `strict` |
| --- | --- | --- | --- |
| [`block-destructive-shell`](#block-destructive-shell) | Guard | on, temp dirs deletable | on, no paths outside the project deletable |
| [`git-guard`](#git-guard) | Guard | on, direct commits to `main` allowed | on, commits and pushes to `main`, `master` and the default branch blocked |
| [`protect-secrets`](#protect-secrets) | Guard | on | on |
| [`format-on-edit`](#format-on-edit) | | on | on |
| [`session-context`](#session-context) | | on | on |
| [`check`](#check) | | off | on |
| [`notify`](#notify) | | off | on |
| [`audit-log`](#audit-log-1) | | off | on |
| `ask` on a Host that can't ask | | allowed, with a warning | blocked |

Some Decisions are `ask`: the Host asks you to confirm, as with `--force-with-lease`. A few Hosts ignore `ask` (see [Host compatibility](#host-compatibility)). There, `standard` lets the command run and shows a warning, and `strict` blocks it.

## Hooks

**Fail modes:** a Guard *fails closed*. If it can't parse the command, times out (30 s), crashes or gets an invalid config, it blocks and gives the reason. Every other Hook *fails open*: it swallows its own errors and stays out of the way. Each Hook runs in isolation, so one Hook's failure can't affect another.

### block-destructive-shell

Stops shell commands that can destroy the machine, the home directory or the project.

- **Events:** PreToolUse (Bash).
- **Fail mode:** closed.
- **Blocks:**
  - recursive deletes of `/`, `~` (or any directory containing it), the project (or any directory containing it), and paths outside the project;
  - `mkfs` and similar filesystem-formatting commands;
  - raw device writes (`dd of=/dev/disk0`, `> /dev/sda`);
  - downloads piped into a shell (`curl … | sh`).
- **Asks:** before recursively deleting tracked or untracked work inside the project, anything in a project without git, or `.git`. Also before deletes whose targets are only known at run time (`rm -rf "$DIR"`).
- **Allows:** deleting gitignored output inside the project, such as `node_modules` or `dist`.

| Option | Type | `standard` | `strict` | |
| --- | --- | --- | --- | --- |
| `allowedPaths` | string[] | `["/tmp", "/var/tmp", "$TMPDIR", "$TEMP"]` | `[]` | Directories outside the project whose contents may be deleted recursively. `~`, `$VAR` and `${VAR}` are expanded, and an entry whose variable is unset is skipped. |

### git-guard

Stops git commands that rewrite shared history, destroy uncommitted work or skip your git hooks.

- **Events:** PreToolUse (Bash).
- **Fail mode:** closed.
- **Blocks:**
  - `push --force`, `-f` and `+refspec` pushes;
  - `reset --hard`;
  - `clean -f` in any flag combination;
  - `--no-verify` on commit or push, and `-c core.hooksPath=…`, which skips the hooks the same way.
- **Asks:** before `push --force-with-lease`, a checkout or restore that discards all changes (`git checkout -- .`, `git restore .`), and `branch -D`.
- **Protected branches:** blocks commits and pushes that target a protected branch. Protection is on under `strict`, or whenever you configure it.

| Option | Type | `standard` | `strict` | |
| --- | --- | --- | --- | --- |
| `protectedBranches` | string[] | `[]` | `["main", "master"]` | Commits and pushes may not target these branches directly. Names must match exactly (no globs). A non-empty list turns protection on. |
| `protectDefaultBranch` | boolean | `false` | `true` | Also protect the repository's default branch (from `origin/HEAD`). |

### protect-secrets

Keeps the Host from reading or writing secrets.

- **Events:** PreToolUse (Bash, Read, Edit, MultiEdit, NotebookEdit, Write, Grep, Glob).
- **Fail mode:** closed. It also blocks when an ignore file exists but can't be read.
- **Protected by default:**
  - `.env` and `.env.*`, except `.env.example`, `.env.sample` and `.env.template`;
  - private keys and keystores (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.ppk`, `*.jks`, `*.keystore`, `id_rsa*` and friends, `~/.ssh/`), except `*.pub`;
  - cloud credentials (`~/.aws/credentials`, the AWS SSO and CLI caches, gcloud and Azure config);
  - `~/.kube/config` and `~/.docker/config.json`;
  - `.netrc`, `.pgpass`, `~/.git-credentials`, `~/.npmrc` and `~/.pypirc`.
- **Also protected:** the patterns in `.claudeignore`, `.cursorignore` and `.aiignore` at the project root.
- **How it checks:** file tools by their path, search tools by their path and file glob, and shell commands by every operand and redirection of every command that executes. Metadata-only programs such as `ls` and `stat` are allowed, and so is a broad search that doesn't target a protected path. The block reason names the pattern that matched.

| Option | Type | Default (both Presets) | |
| --- | --- | --- | --- |
| `protect` | string[] | `[]` | Extra protected patterns, in gitignore syntax, relative to the project root (`~/` for home). |
| `allow` | string[] | `[]` | Exceptions, in gitignore syntax. A path matching one is never protected, even by a built-in pattern. |
| `ignoreFiles` | string[] | `[".claudeignore", ".cursorignore", ".aiignore"]` | Ignore files at the project root whose patterns are also protected. Set `[]` to ignore them. |

### format-on-edit

Formats each file the Host edits or writes with your project's own formatter, and only that file.

- **Events:** PostToolUse (Edit, MultiEdit, NotebookEdit, Write).
- **Fail mode:** open. If no formatter is found, the formatter fails, it times out or the binary is missing, the file is left as it is, silently.
- **Behaviour:** never installs anything, never blocks and adds no context.
- **Detection:** walks up from the file to the repository root. In each directory it checks the configs of prettier, biome, ruff, black, gofmt (`go.mod`), rustfmt and dprint, in that order, so the config nearest the file wins.
- **Binaries:** prefers project-local ones: `node_modules/<package>` for Node formatters and `.venv`/`venv` for Python ones. Otherwise it uses `PATH`.

| Option | Type | Default (both Presets) | |
| --- | --- | --- | --- |
| `command` | string[] | unset (detect) | Use this command instead of detecting one, e.g. `["black", "--quiet", "{file}"]`. It runs without a shell. `{file}` is replaced by the file's absolute path, which is appended if `{file}` is absent. On Windows, name an `.exe`, not a `.cmd` shim. |
| `timeoutMs` | integer | `10000` | Give up after this many milliseconds. |

### session-context

Tells the Host where it is when a session starts, and again after compaction.

- **Events:** SessionStart (startup, resume, clear, compact).
- **Fail mode:** open.
- **Adds:**
  - today's date;
  - in a git repo: the branch, ahead/behind its upstream, the dirty files (truncated) and the last five commit subjects;
  - then any configured extras.
- **Size:** the whole context is capped at 1 KB.

| Option | Type | Default (both Presets) | |
| --- | --- | --- | --- |
| `files` | string[] | `[]` | Files, relative to the project, whose contents are added after the git summary. They share the 1 KB budget. |
| `commands` | string[][] | `[]` | Commands whose output is added after the files, each an argument list run without a shell (`["gh", "pr", "list"]`) with a 3 s timeout. They share the 1 KB budget. |

### check

Runs your checks when the Host tries to stop, and blocks the stop while they fail, so the agent can't say "done" while checks are red.

- **Events:**
  - Stop;
  - SubagentStop, if you opt in with `subagentStop`;
  - PostToolUse (edits and writes), only when `editCommand` is set.
- **Fail mode:** open. If the command times out or can't start, the Host may stop, and you get a warning message.
- **Command:** the one you configure, or one detected from:
  1. `package.json` scripts `lint`, `typecheck` and `test` (all that exist, through the lockfile's package manager);
  2. ruff;
  3. `go vet ./...`;
  4. `cargo check`.

  A detected command is announced.
- **Runs:** through the platform shell (`sh -c`, or `cmd.exe` on Windows), so `npm run lint && npm test` works everywhere.
- **Loop protection:** it honours the Host's "stop hook already active" signal and gives up after `maxBlocks` consecutive blocks. It also skips when the git working tree hasn't changed since the last pass.

| Option | Type | Default (both Presets) | |
| --- | --- | --- | --- |
| `command` | string | unset (detect) | Command line to run when the Host stops. |
| `timeoutSeconds` | integer | `300` | Kill the check after this long and let the Host stop unchecked. Keep it below the Host's hook timeout (Claude Code: 600). |
| `outputBytes` | integer (200–9000) | `4000` | Most bytes of failure output in the block reason. |
| `maxBlocks` | integer | `3` | Consecutive blocks before check lets the Host stop. Keep it below Claude Code's own cap (8). |
| `subagentStop` | boolean | `false` | Also check when a subagent stops. |
| `editCommand` | string | unset | Per-edit mode: run after each edit, with `{file}` replaced by the edited file (appended if absent). Failures go back to the Host as context and never block. |
| `editTimeoutSeconds` | integer | `30` | Timeout for `editCommand`. |
| `editOutputBytes` | integer (100–9000) | `1000` | Most bytes of `editCommand` output fed back. |

### notify

Sends a desktop notification when the Host needs you, or when it finishes a long turn. It never delays the Host.

- **Events:**
  - Notification: permission requests, questions and idle;
  - Stop: when the turn took longer than `thresholdSeconds`;
  - UserPromptSubmit: silently records when the turn started.
- **Fail mode:** open, and silent.
- **Delivery:**
  - macOS: `terminal-notifier` or `osascript`;
  - Linux: `notify-send`;
  - Windows: a PowerShell toast;
  - otherwise: an OSC 9 terminal escape.

  Delivery runs in a detached process.

| Option | Type | Default (both Presets) | |
| --- | --- | --- | --- |
| `thresholdSeconds` | number | `30` | Notify at Stop only when the turn ran longer than this. |
| `sound` | boolean | `true` | Play the platform's notification sound. |
| `webhook` | `{ url, kind: "ntfy" \| "slack" }` | unset | Also post each notification to an ntfy topic or a Slack incoming webhook. |

### audit-log

Records every Event as one JSONL line: the tool, its input, and each Hook's Decision and timing.

- **Events:** all of them.
- **Fail mode:** open, and silent.
- **Location:** written to your user state directory (see [Audit log](#audit-log)), never into the repo.
- **Redaction:** input and output around protected paths are redacted using protect-secrets' patterns. Token-like values are redacted everywhere, and tool output is truncated.
- **Retention:** one file per project per UTC day. Days past the retention limit are deleted.

| Option | Type | Default (both Presets) | |
| --- | --- | --- | --- |
| `maxOutputBytes` | integer | `4096` | Keep at most this many bytes of a tool's output (and of its input, except the command and path) per entry. |
| `retentionDays` | integer | `30` | Delete day files older than this. |

## Configuration

One file, `.hardhooks.json`, at the repository root. hardhooks uses the nearest one found walking up from the working directory, stopping at the git root:

```json
{
  "$schema": "https://unpkg.com/hardhooks/hardhooks.schema.json",
  "preset": "standard",
  "hooks": {
    "git-guard": { "protectedBranches": ["main", "develop"] },
    "protect-secrets": { "allow": ["config/dev.key"] },
    "check": { "enabled": true, "command": "npm test" },
    "notify": { "enabled": true, "webhook": { "url": "https://ntfy.sh/my-topic", "kind": "ntfy" } }
  }
}
```

- **`$schema`** gives your editor autocomplete and validation. The same schema ships in the package as `hardhooks.schema.json`. More examples are in [`examples/`](examples/).
- **`hooks.<name>`** takes `enabled` plus that Hook's options. Anything you leave out comes from the Preset.
- **Invalid config:** unknown keys and wrong types make the config invalid. An invalid config blocks wherever a Guard would run, with a message saying what's wrong, so a typo can never quietly turn your protection off.

**User-level config.** Personal defaults that you don't commit, such as notification settings, go here:

| OS | Path |
| --- | --- |
| macOS, Linux | `$XDG_CONFIG_HOME/hardhooks/config.json` (default `~/.config/hardhooks/config.json`) |
| Windows | `%APPDATA%\hardhooks\config.json` |

**Precedence**, lowest first: Preset defaults, then the user config, then the repo config. Values are merged option by option, and the repo wins. Arrays and objects are replaced, not merged.

## Trust

Some Hooks run commands that come from the project itself (ADR-0005):

- command options set in the repo's `.hardhooks.json`: `check`'s `command` and `editCommand`, `format-on-edit`'s `command` and `session-context`'s `commands`;
- commands `check` autodetects: `package.json` scripts, ruff, `go vet`, `cargo check`;
- every formatter `format-on-edit` detects, because formatter configs and project-local binaries can run the project's own code.

Anyone who can commit to a repo, or get you to clone one, controls these. So, like direnv, hardhooks runs them only in a project you trusted:

```sh
hardhooks trust            # list what the project would run, then ask
hardhooks trust --status   # trusted, not trusted, or changed since you trusted it
hardhooks trust --revoke   # forget the project
```

`--yes` skips the question, but is refused when run from inside Claude Code, so the agent can't trust a project for you.

Until you trust a project, those commands are skipped and the Host shows a one-line notice once per session. Nothing is blocked, and everything else works as usual, including all three Guards. Commands set in your user config always run.

Trust is tied to the project path and a hash of the files that decide what runs: `.hardhooks.json`, the `scripts` and `prettier` fields of `package.json`, and formatter config files. If one of them changes, for example after a `git pull`, run `hardhooks trust` again.

## Testing your setup: `hardhooks test`

```
hardhooks test [--cases <path>]
```

`hardhooks test` runs two sets of cases through the real dispatcher against your resolved config:

- **The shipped fixtures:** payloads for every Hook. A fixture is skipped when its Hook is disabled, or when it assumes a Preset or option value you changed.
- **Your own cases:** `.hardhooks/tests/*.json` in the project, or the file or directory you pass with `--cases`.

It exits 1 if any case fails, so you can run it in CI. It also warns when an enabled Hook's Event isn't installed in your Host settings, which means you need to re-run `init`.

A case file holds one case or an array of them:

```json
[
  { "name": "force-push to main is blocked", "bash": "git push --force origin main", "expect": "block" },
  { "name": "--force-with-lease asks first", "bash": "git push --force-with-lease origin feature", "expect": "ask" },
  {
    "name": "force-push hidden in bash -c is blocked, saying why",
    "event": "PreToolUse",
    "tool": "Bash",
    "input": { "command": "bash -c 'git push -f origin main'" },
    "expect": { "decision": "block", "reason": "force" }
  },
  {
    "name": "sessions start with today's date",
    "event": "SessionStart",
    "payload": { "source": "startup" },
    "expect": { "context": "Today: \\d{4}-\\d{2}-\\d{2}" }
  }
]
```

| Field | Meaning |
| --- | --- |
| `name` | Required. |
| `bash`, `read`, `write`, `edit` | Shorthand for a tool call: a command or a file path (relative to `cwd`). The Event defaults to PreToolUse. |
| `event`, `tool`, `input` | The Event, and the tool name and input, written out in full. |
| `payload` | Extra payload fields. A payload with `hook_event_name` is a complete Host payload and is sent exactly as written. |
| `host` | Which Host to simulate: `claude-code` (default), `copilot-cli`, `copilot-cloud`, `cursor`, `devin-cli` or `continue-cli`. |
| `cwd` | Working directory for the case (default: the project). |
| `expect` | `"block"`, `"ask"`, `"allow"` or `"none"`, or `{ decision?, reason?, context? }`, where `reason` and `context` are case-insensitive regular expressions. |

The cases run with no real processes: git reports "not a git repository" and every other program succeeds silently. See [`examples/tests/`](examples/tests/).

## Audit log

When `audit-log` is enabled, entries go to:

| OS | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/hardhooks/state/audit-log/` |
| Linux | `$XDG_STATE_HOME/hardhooks/audit-log/` (default `~/.local/state/hardhooks/audit-log/`) |
| Windows | `%LOCALAPPDATA%\hardhooks\state\audit-log\` |

Each entry is written to `<project>-<hash>/<YYYY-MM-DD>.jsonl`, and the files are readable only by you (mode 0600 on macOS and Linux). Every line is a valid `hardhooks test` case that replays to the Decision the Host saw. So `hardhooks test --cases <day>.jsonl` replays a whole day, and you can copy a single line into `.hardhooks/tests/` to turn a real event into a regression test.

## Host compatibility

> **Documented, pending real-Host verification ([#15](https://github.com/Rahat-ch/hooks/issues/15)).** This table comes from each Host's documentation and source, not yet from captured sessions.

Every Host below reads hardhooks' entries from `.claude/settings.json`, so one `init` covers all five. The `ask` column comes from `src/hosts/index.ts`.

| Host | Reads `.claude/settings.json` | Honours `ask` | Documented gaps |
| --- | --- | --- | --- |
| Claude Code | yes | yes | none |
| Copilot CLI | yes | yes | none known |
| Cursor | yes (by default) | no: `ask` isn't enforced, so the Preset fallback applies | no Notification Event, so `notify` only fires on long turns. Bash is reported as `Shell`. |
| Devin CLI | yes (by default) | no: only approve/block | no Notification or SubagentStop Event |
| Continue (`cn` CLI) | yes | no: only `deny` is acted on | none known |

The Copilot cloud agent is detected too. It treats `ask` as `deny`, so the Preset fallback applies there as well.

## Uninstall

```sh
hardhooks uninstall            # project settings
hardhooks uninstall --user     # user settings
npm rm -g hardhooks
```

`uninstall` takes the same `--dry-run` and `--yes` flags as `init`, and removes only the entries hardhooks wrote. Your `.hardhooks.json` and the audit log are left alone, so delete them yourself if you want them gone. For the plugin, run `claude plugin uninstall hardhooks@hardhooks`.

## Limitations

- **Bash syntax only.** The Guards parse POSIX shell and bash. PowerShell commands, whether from a PowerShell tool or from `pwsh -c '…'`, are not analysed. Neither are other interpreters (`python -c`, `node -e`).
- **Run-time values can hide commands.** `bash -c "$CMD"` and `eval "$CMD"` run a string that doesn't exist until run time, so there is nothing to inspect, and they are allowed. Scripts run from files (`./cleanup.sh`) are not opened either. If part of a command *is* known statically, it is still checked: `rm -rf "$DIR"` asks, and `bash -c "git push -f $REMOTE"` is blocked.
- **Guards see what the agent asks to run.** They don't see what a program does once it's running. A build script, a git hook or a Makefile target can still delete files.
- **It isn't a sandbox.** hardhooks catches the common, catastrophic mistakes of a well-meaning agent. It doesn't contain a hostile one. For untrusted code, use real isolation (containers, VMs, OS sandboxing) as well.
- **One Node spawn per Event**, about 19 ms. Through the plugin, every Event spawns, even ones no enabled Hook handles. Those exit immediately.
- **Host support** beyond Claude Code is still unverified (see above).

## License

[MIT](LICENSE). The bundled `unbash` parser is ISC-licensed. Its notice is kept at the top of `dist/hardhooks.mjs`.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
