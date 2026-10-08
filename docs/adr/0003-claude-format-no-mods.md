# Claude Code's command-hook format is canonical; no mods in v1

Hooks target Claude Code's command-hook protocol (JSON on stdin; Decision via exit code or JSON on stdout) and are installed into `.claude/settings.json`. Copilot CLI, Cursor, Devin CLI and Continue read that file natively, so v1 covers five Hosts without Adapters. Codex and Gemini Adapters follow in v1.1. We do not ship Claude Code mods (in-process function hooks) in v1: they launched on 2026-10-01, their API is marked as subject to change without notice, they only run in Claude Code, and admins can block them separately (`allowManagedModsOnly`) while settings hooks keep running.

## Consequences

- A Guard must never exist only as a mod. Any later mod (a notify toast, a status line) supplements a command Hook rather than replacing it.
- Decision logic stays Host-neutral so Adapters and mods can wrap it.
