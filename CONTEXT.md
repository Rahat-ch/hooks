# hardhooks

Deterministic guardrails for nondeterministic agents: an open-source library of reusable, tested hooks for AI coding agents, written once against Claude Code's hook format and run on any host that speaks it.

## Language

**Hook**:
One reusable unit this library ships, such as `git-guard` or `format-on-edit`.
_Avoid_: script, rule, handler

**Host**:
The coding agent that runs a Hook, such as Claude Code, Cursor or Copilot CLI.
_Avoid_: agent, harness, client

**Event**:
A named moment in a Host's loop at which Hooks run, such as PreToolUse or Stop.
_Avoid_: trigger, lifecycle hook

**Guard**:
A Hook whose purpose is to block an action the Host is about to take.
_Avoid_: blocker, policy, gate

**Adapter**:
The translation layer that lets a Hook run on a Host that does not speak Claude Code's hook format.
_Avoid_: shim, bridge, driver

**Decision**:
What a Hook returns to the Host for one Event: allow, block, ask, or add context.
_Avoid_: verdict, response, output

**Preset**:
A named bundle of which Hooks are enabled and how strictly Guards behave, such as `standard` or `strict`.
_Avoid_: profile, level, mode

**Project command**:
A command hardhooks would run because the project chose it: a command option in the repo's `.hardhooks.json`, or one a Hook autodetects from the project's files. One from the user's own config is not a Project command.
_Avoid_: repo command, detected command

**Trust**:
A user's per-project permission for hardhooks to run that project's Project commands. It lapses when any file that chooses them changes.
_Avoid_: allowlist, approval, allow
