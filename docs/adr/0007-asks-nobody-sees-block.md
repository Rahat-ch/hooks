# An ask nobody will see becomes a block, under every Preset

A Guard's `ask` is only a safeguard if a human answers it. So the dispatcher passes a PreToolUse `ask` through only when it can reach a human: the Host honours `ask` (`hostCapabilities` in `src/hosts/`) and the payload's `permission_mode` is not one in which nobody is asked (Claude Code's `auto`, `bypassPermissions` and `dontAsk`). A missing or unknown mode counts as attended. Everywhere else the `ask` becomes a block under both Presets. The reason keeps the Guards' reasons and adds why nobody would be asked (for example "Claude Code is in auto mode, where confirmation prompts can't be relied on") and tells the agent to ask the user to run it themselves.

This reverses the v1 spec (#1: "Where `ask` is unsupported, it falls back to allow plus a warning under `standard`, and to block under `strict`"). In a real Claude Code session in auto mode (#26), block-destructive-shell answered `ask` for `rm -rf src` and Claude Code ran it with no prompt, deleting tracked files. Claude Code's hooks docs say a hook's `ask` still prompts in auto mode; it didn't. The standard Preset's allow-with-a-warning fallback had the same flaw on Hosts that ignore `ask`: the warning reaches the user after the command has run.

## Considered Options

- **Trust the Host's docs and keep asking in auto mode.** Rejected: the observed behaviour contradicts them, and the cost of being wrong is lost work.
- **Keep allow-with-a-warning under `standard` for Hosts that can't ask.** Rejected for the same reason: an `ask` means "a human must confirm this first", and a warning confirms nothing.
- **Escalate only under `strict`.** Rejected: `standard` is the default, and the commands that ask (deleting tracked work, `branch -D`, `--force-with-lease`) are the ones the user wanted to see first.

## Consequences

- In auto, don't-ask and bypass-permissions modes, and on Cursor, Devin CLI, Continue CLI and the Copilot cloud agent, the agent can't do what a Guard asks about. The user runs it themselves (in Claude Code, with `!`), or switches to a mode that prompts.
- The dispatcher no longer has a warning of its own; `Outcome.warning` is gone.
- Copilot CLI's payload carries no permission mode, so its `--allow-all-tools` sessions can't be told apart; an `ask` there still asks. If a Host later documents such a field, it goes in `unansweredAskReason()` in `src/hosts/index.ts`.
- `hardhooks test` builds payloads with `permission_mode: "default"`, so cases expecting `ask` keep passing; a case can set `payload.permission_mode` to test an unattended mode.
