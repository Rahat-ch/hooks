# Claude Code hooks: why they can "bloat a session", and how to keep them invisible

**Answer in one paragraph.** A hook bloats a session in two distinct ways, and the docs treat them separately. (1) *Context bloat*: anything a hook returns as `additionalContext`, as plain stdout on `SessionStart`/`UserPromptSubmit`/`UserPromptExpansion`/`PostModelSwitch`, as a `decision: "block"` `reason`, as exit-2 stderr on events that "feed it to Claude", or as `stopReason`, is wrapped in a system reminder and inserted into the conversation at the point the hook fired; it is saved to the transcript, replayed on resume, and stays in the prompt for every later request until compaction (https://code.claude.com/docs/en/hooks#add-context-for-claude). A hook that fires per prompt or per tool call therefore accumulates N firings x payload, append-only (issue evidence: https://github.com/anthropics/claude-code/issues/86061), and tool-level `additionalContext` has been reported to invalidate the prompt cache (https://github.com/anthropics/claude-code/issues/83913). (2) *Transcript/latency bloat*: hooks are synchronous by default and all matching hooks run in parallel before Claude continues; a successful, silent hook shows nothing in the UI, but every non-zero-exit or malformed-JSON hook prints a `<hook name> hook error` notice, and prompt/agent hooks make an extra model call per firing (https://code.claude.com/docs/en/hooks#exit-code-output, https://code.claude.com/docs/en/hooks#prompt-based-hooks). The documented way to make a command hook fully background is `"async": true` (command hooks only): Claude continues immediately, the hook's `timeout` is not enforced, completion notices are hidden unless verbose mode is on, and only `additionalContext`/`systemMessage` from its JSON are delivered, on the next turn, to Claude (https://code.claude.com/docs/en/hooks#run-hooks-in-the-background). A hook that exits 0 with empty stdout on a non-context event leaves no trace in either the model context or the transcript; `suppressOutput` is documented as having no effect (https://code.claude.com/docs/en/hooks#json-output).

Research date: 2026-09-14. Local Claude Code version: 2.1.270. Docs fetched as raw Markdown from `code.claude.com/docs/en/<page>.md`.

---

## 1. How hook output enters the model context

### Exit code semantics (all events, command hooks)

Source: https://code.claude.com/docs/en/hooks#exit-code-output

- **Exit 0.** "For most events, Claude Code writes stdout to the debug log and doesn't show it in the transcript. The exceptions are `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, and `PostModelSwitch`, where Claude Code adds plain-text stdout as context that Claude can see and act on." Stdout that starts with `{` and ends with `}` is parsed as JSON; anything else is plain text. "Stderr from a hook that exits 0 goes to the debug log only, never the transcript, and Claude never sees it."
- **Exit 2.** Blocking error. "The blocking message is the reason from your JSON's blocking decision when it makes one, and your stderr text otherwise." Where it lands is per event (table below); JSON fields on stdout are still read.
- **Any other exit code (e.g. 1).** Does not block. With valid schema-passing JSON on stdout the JSON alone decides and no error is reported. With plain-text or empty stdout it is "a non-blocking error for most hook events: the action proceeds, and the transcript shows a `<hook name> hook error` notice followed by the first line of stderr, prefixed with `Failed with non-blocking status code:`." A hook that can't start (exit 127) produces the same notice.
- **Timeout.** Sync hooks that hit `timeout` are cancelled and their output discarded; on `PreToolUse` a timed-out command hook does *not* block the tool call (https://code.claude.com/docs/en/hooks#timeouts).

### Universal JSON fields

Source: https://code.claude.com/docs/en/hooks#json-output

| Field | Where it goes | In model context? |
| :-- | :-- | :-- |
| `continue: false` | Stops Claude entirely; "takes precedence over any event-specific decision fields" | n/a (ends processing) |
| `stopReason` | "Message shown to the user when `continue` is `false`. It stays in the conversation, so Claude sees it if the conversation continues" | Yes (persisted) |
| `suppressOutput` | "Has no effect: Claude Code accepts the field but doesn't act on it. A successful hook's stdout is never shown in the transcript and is recorded in the debug log" | No |
| `systemMessage` | "Warning message shown to the user." Some events discard it (`PreCompact`, `PostCompact`, `MessageDisplay`, `Setup`) or deliver it elsewhere. **Async hooks are the exception: their `systemMessage` is delivered to Claude on the next turn and not shown to the user** (https://code.claude.com/docs/en/hooks#how-async-hooks-execute). `DirectoryAdded` with `slash_command` source also delivers it to Claude (https://code.claude.com/docs/en/hooks#directoryadded) | No for sync hooks; **yes** for async hooks |
| `terminalSequence` | OSC escape emitted on your behalf (bell, title, desktop notification) | No |
| `decision: "block"` + `reason` (top-level) | Used by `UserPromptSubmit`, `UserPromptExpansion`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `SubagentStop`, `ConfigChange`, `PreCompact`. For `PostToolUse` the reason is "added next to the tool result"; for `Stop` it "tells Claude why it should continue"; for `UserPromptSubmit` the reason is "Shown to the user ... Not added to context" (https://code.claude.com/docs/en/hooks#decision-control) | Event-dependent (see table) |
| `hookSpecificOutput.additionalContext` | "Claude Code wraps the string in a system reminder and inserts it into the conversation at the point where the hook fired. Claude reads the reminder on the next model request, but it doesn't appear as a chat message in the interface." Saved in the transcript; replayed on `--resume`/`--continue` rather than re-run (https://code.claude.com/docs/en/hooks#add-context-for-claude) | **Yes, persisted** |
| `hookSpecificOutput.permissionDecisionReason` (PreToolUse) | "For `allow` and `ask`, shown to the user but not Claude. For `deny`, shown to Claude" (https://code.claude.com/docs/en/hooks#pretooluse-decision-control) | Only on deny |
| `hookSpecificOutput.updatedToolOutput` (PostToolUse) | Replaces what Claude sees as the tool result | Yes (replaces, does not add) |
| `hookSpecificOutput.classifierContext` (PostToolUse) | Note for the auto-mode classifier, not Claude; 2,000-char cap; ignored from async hooks (https://code.claude.com/docs/en/hooks#annotate-a-result-for-the-auto-mode-classifier) | No |

**Size cap.** "Hook output strings, including `additionalContext`, `systemMessage`, and plain stdout, are capped at 10,000 characters. Output that exceeds this limit is saved to a file and replaced with a preview and file path" (https://code.claude.com/docs/en/hooks#json-output). Changelog 2.1.89 introduced this as a 50K threshold ("Changed hook output over 50K characters to be saved to disk with a file path + preview instead of being injected directly into context", https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); the current docs say 10,000. Issue reports say the preview is ~2 KB and that there is no user-visible warning when the cut happens (https://github.com/anthropics/claude-code/issues/91614, https://github.com/anthropics/claude-code/issues/84021, https://github.com/anthropics/claude-code/issues/94358 -- issue evidence, not documented behaviour).

### Per-event table: what stdout / exit codes do, and whether it lands in context

Sources: https://code.claude.com/docs/en/hooks#exit-code-0, https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event, https://code.claude.com/docs/en/hooks#add-context-for-claude, and each event's own section on the same page.

| Event | Exit 0: plain stdout | Exit 0: JSON that reaches Claude | Exit 2 | Lands in model context? |
| :-- | :-- | :-- | :-- | :-- |
| `SessionStart` | **Added to Claude's context** at start of conversation | `additionalContext` (start of conversation) | Can't block; "Shows stderr to user only" as a `hook error` notice | Yes, on any output |
| `Setup` | Ignored | All JSON fields discarded | Ignored | No |
| `UserPromptSubmit` | **Added to context** as a system reminder alongside the prompt; "Neither channel produces a visible transcript entry" | `additionalContext` | Blocks and erases the prompt; stderr shown to user, "isn't added to context" | Yes, on exit 0 output |
| `UserPromptExpansion` | Added to context (same family as above) | `additionalContext` | Blocks the expansion | Yes, on exit 0 output |
| `PreToolUse` | Debug log only | `additionalContext` (next to the tool result); `permissionDecisionReason` only on deny | Blocks tool call; "Claude sees the stderr message as the denial reason" | Only via `additionalContext`, deny reason, or exit 2 |
| `PermissionRequest` | Debug log only | `decision.message` on deny "tells Claude why" | "Exit code 2 isn't honored ... stderr is discarded" | Only on deny message. Transcript shows "Allowed by PermissionRequest hook" (https://code.claude.com/docs/en/hooks-guide#auto-approve-specific-permission-prompts) |
| `PostToolUse` | Debug log only | `additionalContext` (next to tool result); `decision: "block"` + `reason` (next to tool result; Claude still sees original output); `updatedToolOutput` replaces the result | "Shows stderr to Claude; the tool already ran" | Only via `additionalContext`, block reason, or exit 2 |
| `PostToolUseFailure` | Debug log only | `additionalContext` (alongside the error) | "Shows stderr to Claude; the tool already failed" | Only via `additionalContext` or exit 2 |
| `PostToolBatch` | Debug log only | `additionalContext`; `decision: "block"`/`continue: false` stops the loop; message "stays in the conversation, so Claude sees it" | Stops the agentic loop before the next model call | Only via `additionalContext` or a block |
| `PermissionDenied` | Debug log only | `hookSpecificOutput.retry: true` | Ignored | No text; only a retry flag |
| `Notification` | Debug log only | No decision control | "Exit code and stderr are ignored" | No |
| `SubagentStart` | Debug log only | `additionalContext` at start of subagent conversation (re-injected only if the subagent's context no longer holds it, e.g. after subagent auto-compaction) | "Shows stderr to user only" in the subagent's transcript | Subagent context only |
| `SubagentStop` | Debug log only | `decision: "block"` + `reason`; `additionalContext` ("Stop hook feedback") | Prevents the subagent from stopping; stderr fed back as reason | Only when blocking / giving feedback |
| `TaskCreated` | Debug log only | `decision: "block"` + `reason` returned to Claude as the tool error; `continue: false` ignored | Rolls back the task; stderr returned to Claude as the tool error | Only when blocking |
| `TaskCompleted` | Debug log only | `continue: false` + `stopReason` (teammate case only) | "the stderr message is fed back to the model as feedback" | Only when blocking |
| `Stop` | Debug log only | `decision: "block"` + `reason` ("Tells Claude why it should continue"); `additionalContext` shown in transcript as "Stop hook feedback" and fed to Claude | "Prevents Claude from stopping"; stderr is the reason Claude receives | Only when blocking / giving feedback. Capped at 8 consecutive blocks (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) |
| `StopFailure` | Ignored | Ignored except `terminalSequence` | Ignored | No |
| `PreCompact` | Debug log only | `decision: "block"` blocks compaction; `systemMessage` and `continue` discarded | Blocks compaction; for manual `/compact` stderr shown to user | No |
| `PostCompact` | Debug log only | No decision control; `systemMessage`/`continue` discarded | "Shows stderr to user only" | No |
| `SessionEnd` | Debug log only | No decision control; `systemMessage` supported since 1.0.x | "Shows stderr to user only"; 1.5 s shared budget | No |
| `PostModelSwitch` | **Added to context** with the next request | `additionalContext` | "Shows stderr to user only" | Yes, on exit 0 output |
| `MessageDisplay` | Debug log only | `displayContent` replaces on-screen text only; "Claude never sees the replacement" | Original text displayed | No |
| `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate/Remove`, `Elicitation*` | Side-effect / control events; stderr user-only or debug log | Event-specific control fields | Per table on the docs page | No conversational text (exception: `DirectoryAdded` `slash_command` delivers `systemMessage` to Claude) |

Note on subagents: the `SubagentStart` docs state that a re-injected copy is only added "when the subagent's context doesn't already hold the copy from an earlier run ... After auto-compaction discards that copy, Claude Code injects the next run's context again" (https://code.claude.com/docs/en/hooks#subagentstart). This is the one place the docs say explicitly that hook-injected context is discarded by compaction.

---

## 2. Hook execution model

Source unless noted: https://code.claude.com/docs/en/hooks#hook-handler-fields and https://code.claude.com/docs/en/hooks#run-hooks-in-the-background

- **Blocking by default.** "By default, hooks block Claude's execution until they complete."
- **Parallel.** "All matching hooks run in parallel. If you define the same handler in more than one settings file, it runs once." Also: "every hook's command runs to completion before Claude Code merges the results" (https://code.claude.com/docs/en/hooks-guide#combine-results-from-multiple-hooks).
- **Cadence.** "per session: `SessionStart` and `SessionEnd`; per turn: `UserPromptSubmit`, `Stop`, and `StopFailure`; on every tool call inside the agentic loop: `PreToolUse` and `PostToolUse`" (https://code.claude.com/docs/en/hooks#hook-lifecycle). `PostToolUse` "fires once per tool, which means it fires concurrently when Claude makes parallel tool calls"; `PostToolBatch` fires once per batch (https://code.claude.com/docs/en/hooks#posttoolbatch). A `PreToolUse`/`PostToolUse` hook with matcher `*` or omitted therefore spawns a process for every Read/Grep/Glob/Bash/Edit in a long session.
- **`async: true`.** "Add `"async": true` to a command hook's configuration to run it in the background without blocking Claude. This field is only available on `type: "command"` hooks." Async hooks "can't block or control Claude's behavior: response fields like `decision`, `permissionDecision`, and `continue` have no effect." "After the background process exits, Claude Code delivers the `additionalContext` and `systemMessage` fields from the hook's JSON response to Claude on the next conversation turn. Unlike a synchronous hook's `systemMessage`, neither field is shown to you." "Once an async hook is running in the background, Claude Code doesn't enforce `timeout` on it." "Hook output is delivered on the next conversation turn. If the session is idle, the response waits until the next user interaction." "Each execution creates a separate background process. There is no deduplication across multiple firings of the same async hook." In `-p` mode, async hooks still running at teardown are killed.
- **`asyncRewake: true`.** "runs in the background and wakes Claude on exit code 2. The hook's stderr, or stdout if stderr is empty, is shown to Claude as a system reminder." `timeout` is enforced on `asyncRewake` hooks.
- **`timeout` (seconds).** "Defaults: 600 for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`. Claude Code lowers the `command`, `http`, and `mcp_tool` default to 30 on `UserPromptSubmit`, `PreModelSwitch`, and `PostModelSwitch`, and to 10 on `MessageDisplay`. `SessionEnd` hooks share a 1.5-second budget" (raised to the highest configured per-hook timeout, up to 60 s; `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` overrides). `UserPromptSubmit`: "Because this hook runs before every prompt and blocks model processing until it completes, a stuck hook stalls the session" (https://code.claude.com/docs/en/hooks#userpromptsubmit).
- **Narrowing.** `matcher` filters by tool/agent/notification name (exact list or regex; `*`/omitted = everything) (https://code.claude.com/docs/en/hooks#matcher-patterns). The per-handler `if` field uses permission-rule syntax "so the hook process only spawns when the tool call matches", e.g. `"if": "Bash(git *)"` (https://code.claude.com/docs/en/hooks-guide#filter-by-tool-name-and-arguments-with-the-if-field).
- **Hot reload.** Settings-file edits to `hooks` apply without restart (https://code.claude.com/docs/en/settings#reload-settings). (Section anchor inferred from page text at line ~584 of the settings page.)

### Relevant changelog entries (https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

| Version | Entry |
| :-- | :-- |
| 1.0.41 | "Hooks: Enabled optional timeout configuration for each command" |
| 1.0.59 | "UserPromptSubmit now supports additionalContext in advanced JSON output" |
| 1.0.64 | "Added systemMessage field to hook JSON output for displaying warnings and context" |
| 1.0.115 | "Show condensed output for post-tool hooks to reduce visual clutter" |
| 2.1.0 | "Added support for prompt and agent hook types from plugins" |
| 2.1.3 | "Changed tool hook execution timeout from 60 seconds to 10 minutes" |
| 2.1.9 | "Added support for `PreToolUse` hooks to return `additionalContext` to the model" |
| 2.1.19 | "Fixed backgrounded hook commands not returning early, potentially causing the session to wait on a process that was intentionally backgrounded" |
| 2.1.72 | "...async hooks not receiving stdin with bash `read -r`..." |
| 2.1.73 | "Fixed JSON-output hooks injecting no-op system-reminder messages into the model's context on every turn" |
| 2.1.75 | "Suppressed async hook completion messages by default (visible with `--verbose` or transcript mode)" |
| 2.1.81 | "Fixed invisible hook attachments inflating the message count in transcript mode" |
| 2.1.89 | "Changed hook output over 50K characters to be saved to disk with a file path + preview instead of being injected directly into context" |
| 2.1.97 | "Improved session transcript size by skipping empty hook entries" |
| 2.1.98 | "Improved hook errors in the transcript to include the first line of stderr" |
| 2.1.119 | "Fixed async `PostToolUse` hooks that emit no response payload writing empty entries to the session transcript" |
| 2.1.163 | "Stop and SubagentStop hooks can now return `hookSpecificOutput.additionalContext` to give Claude feedback and keep the turn going without being labeled a hook error" |
| 2.1.199 | "Fixed `SessionStart`, `Setup`, and `SubagentStart` hooks silently hiding stderr when exiting with code 2 -- the error is now shown in the transcript" |
| 2.1.208 | "...async hook output retained after backgrounding..." (memory leak fix) |
| 2.1.247 | "Fixed a hook or background agent that printed megabytes of error output being able to overflow the conversation and wedge the session on 'Prompt is too long'" |
| 2.1.257 | "async hook completion notices that arrive together now appear on one line instead of one line per hook" |
| 2.1.261 / 2.1.267 | Resume fixes: hook output around parallel tool calls no longer dropped from the reloaded conversation |
| 2.1.268 | "`--continue` / `--resume`: the conversation appears immediately instead of waiting for SessionStart hooks" |

Taken together these show a steady stream of fixes for hooks writing into the transcript/context unintentionally (2.1.73, 2.1.81, 2.1.97, 2.1.119, 2.1.247), which is consistent with the "bloat" experience on older versions.

---

## 3. Hook types and cost profile

Source: https://code.claude.com/docs/en/hooks#prompt-based-hooks, https://code.claude.com/docs/en/hooks#agent-based-hooks, https://code.claude.com/docs/en/hooks-guide#how-hooks-work

| Type | What runs | Model tokens consumed by the hook itself | Default timeout | Can be async? |
| :-- | :-- | :-- | :-- | :-- |
| `command` | Shell command (`sh -c` or `args` form) | None, unless output is injected | 600 s (30 s on `UserPromptSubmit`) | Yes (`async`, `asyncRewake`) |
| `http` | POST to a URL; JSON body parsed like stdout | None, unless output is injected | 600 s | No (field is command-only) |
| `mcp_tool` | Calls a tool on a connected MCP server | None, unless output is injected | 600 s | No |
| `prompt` | "Send the hook input and your prompt to a Claude model, Haiku by default"; returns `{ok, reason, impossible}` | One LLM call per firing (separate from the main context); `reason` on `ok: false` is fed to Claude / shown as a warning depending on event | 30 s | No |
| `agent` | "spawns a subagent that can read files, search code ... After up to 50 turns, the subagent returns a structured `{ "ok": true/false }`". Marked experimental. | A multi-turn subagent run per firing | 60 s | No |

`prompt`/`agent` are supported only on `PermissionDenied`, `PermissionRequest`, `PostToolBatch`, `PostToolUse`, `PostToolUseFailure`, `PreToolUse`, `Stop`, `SubagentStop`, `TaskCompleted`, `TaskCreated`, `TeammateIdle`, `UserPromptExpansion`, `UserPromptSubmit`. `SessionStart`/`Setup` support only `command` and `mcp_tool`. A `prompt` hook on `PreToolUse` or `PostToolUse` therefore adds one Haiku round-trip to every matching tool call. `/goal` is documented as "a built-in shortcut for a session-scoped prompt-based Stop hook" (https://code.claude.com/docs/en/hooks#stop).

---

## 4. Transcript / UI noise

Sources: https://code.claude.com/docs/en/hooks-guide#debug-techniques, https://code.claude.com/docs/en/hooks#exit-code-output, https://code.claude.com/docs/en/hooks#run-hooks-in-the-background

- **A successful hook is silent.** "Press `Ctrl+O` to open the transcript view to check the outcome of a hook run: Successful run: you see nothing, unless the hook's JSON surfaces something, such as `systemMessage` or Stop hook feedback."
- **What is visible:** blocking feedback (the reason or stderr) on blockable events; `<hook name> hook error` notices for non-blocking errors (any non-zero exit other than 2 with plain/empty stdout, schema failures, JSON parse failures, missing script) with the first line of stderr; `Stop hook feedback` labels; "Allowed by PermissionRequest hook" lines; `[settings]`/`[plugin:<name>]`/`[skill]` labels on hook-requested `ask` prompts; `UserPromptSubmit` timeout notices ("The transcript shows a notice naming the hook, the timeout that fired, and that the output was discarded").
- **What is invisible but in context:** `additionalContext` "doesn't appear as a chat message in the interface"; `UserPromptSubmit` stdout/`additionalContext`: "Neither channel produces a visible transcript entry ... To confirm delivery, check the debug log." So the user can be consuming context without seeing it, and the only witness is `/context` or the debug log.
- **Async completion notices** are "suppressed by default. To see them, enable verbose mode with `Ctrl+O` or start Claude Code with `--verbose`" (changelog 2.1.75; 2.1.257 collapsed multiple notices to one line).
- **`suppressOutput`** does nothing: "A successful hook's stdout is never shown in the transcript and is recorded in the debug log" (https://code.claude.com/docs/en/hooks#json-output). It cannot suppress `additionalContext`, `systemMessage`, or error notices.
- **`systemMessage`** is UI-only for sync hooks ("Warning message shown to the user") but is routed to Claude for async hooks.
- **Post-tool hook output** has been rendered "condensed ... to reduce visual clutter" since 1.0.115 (changelog).
- Hooks cannot write to the terminal directly: "command hooks run in their own session without a controlling terminal ... can't open `/dev/tty`" (https://code.claude.com/docs/en/hooks#hook-input-and-output). Use `terminalSequence` for bells/notifications.

---

## 5. Practical mitigations (documented)

1. **Exit 0 with empty stdout on non-context events.** On `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, etc., plain stdout goes to the debug log only and nothing reaches Claude or the transcript (https://code.claude.com/docs/en/hooks#exit-code-0). On `SessionStart`/`UserPromptSubmit`/`UserPromptExpansion`/`PostModelSwitch` stdout *is* context, so redirect logging to a file there.
2. **Log to a file, not stdout/stderr.** The guide's own logging examples append to a file (`jq -r '.tool_input.command' >> ~/.claude/bash-command-log.txt`) and exit 0 (https://code.claude.com/docs/en/hooks-guide#filter-hooks-with-matchers). Stderr on exit 0 is debug-log only, so `2>/dev/null` is not required for context hygiene, but stderr on exit 2 becomes Claude-visible on `PostToolUse`/`PostToolUseFailure`/`Stop`.
3. **Never exit 1.** Exit 1 with plain/empty stdout is a non-blocking error that prints a `<hook name> hook error` notice on every firing (https://code.claude.com/docs/en/hooks#other-exit-codes). Guard scripts with `|| exit 0` if the side effect is best-effort.
4. **Keep stdout JSON-clean.** Shell-profile `echo` lines prepended to JSON make Claude Code treat the output as plain text (silently ignored on exit 0, or parse-error notice since 2.1.248) (https://code.claude.com/docs/en/hooks-guide#hook-json-has-no-effect).
5. **`async: true` for anything slow or side-effect-only** (formatters, test runs, notifications, logging). Claude continues immediately; timeout is not enforced; nothing is shown to the user; only `additionalContext`/`systemMessage` from the JSON reach Claude, next turn. Omit both fields for a fully silent background hook (https://code.claude.com/docs/en/hooks#run-hooks-in-the-background).
6. **Narrow the trigger.** Use exact `matcher` lists (`Edit|Write`, `Bash`) rather than `*`/omitted, and the `if` field (`"if": "Bash(git *)"`) so "the hook process only spawns when the tool call matches" (https://code.claude.com/docs/en/hooks-guide#filter-by-tool-name-and-arguments-with-the-if-field). Use `PostToolBatch` instead of `PostToolUse` when context should be injected once per batch rather than once per tool (https://code.claude.com/docs/en/hooks#posttoolbatch).
7. **Keep `SessionStart` and `UserPromptSubmit` fast.** "SessionStart runs on every session, so keep these hooks fast" (https://code.claude.com/docs/en/hooks#sessionstart); `UserPromptSubmit` blocks every prompt with a 30 s default timeout.
8. **Avoid `prompt`/`agent` hooks on per-tool events.** Each firing is an LLM call (Haiku by default) or a subagent run of up to 50 turns; agent hooks are experimental and "for production workflows, prefer command hooks" (https://code.claude.com/docs/en/hooks#agent-based-hooks).
9. **Prefer CLAUDE.md for static text.** "For instructions that never change, prefer CLAUDE.md. It loads without running a script" (https://code.claude.com/docs/en/hooks#add-context-for-claude). Use `additionalContext` only for dynamic state, keep it short (10,000-char hard cap; larger output becomes a file path + preview), and phrase it as facts, not commands, so it does not trip prompt-injection defences.
10. **Use `terminalSequence`/`Notification` for user-facing pings**, not `systemMessage` on hot-path events.
11. **Diagnose with the debug log, not by adding output.** `claude --debug-file /tmp/claude.log` shows which hooks matched, exit codes, stdout and stderr (https://code.claude.com/docs/en/hooks-guide#debug-techniques).

---

## 6. Compaction interaction

- **`SessionStart` re-runs after compaction** with `source: "compact"` (matcher `compact`), alongside `startup`, `resume`, `clear`, `fork` (https://code.claude.com/docs/en/hooks#sessionstart). `sessionTitle` is ignored on `compact`. The guide's "Re-inject context after compaction" recipe uses exactly this: "compaction summarizes the conversation to free space. This can lose important details. Use a `SessionStart` hook with a `compact` matcher to re-inject critical context after every compaction" (https://code.claude.com/docs/en/hooks-guide#re-inject-context-after-compaction).
- **Does hook-injected context survive compaction?** The docs do not state this directly for the main session. `additionalContext` is "inserted into the conversation" and is part of what compaction summarises; the recipe above only makes sense if injected reminders are not preserved verbatim. For subagents the docs are explicit: "After auto-compaction discards that copy, Claude Code injects the next run's context again" (https://code.claude.com/docs/en/hooks#subagentstart). Treat main-session behaviour as "summarised, not preserved" (inference from primary sources, flagged in the open-questions section).
- **Resume does not re-run mid-session hooks.** "For mid-session events like `PostToolUse` or `UserPromptSubmit`, when you resume ... Claude Code replays the saved text rather than re-running the hook for past turns, so values like timestamps or commit SHAs become stale" (https://code.claude.com/docs/en/hooks#add-context-for-claude). Injected context is therefore durable transcript weight, not ephemeral.
- **`PreCompact`/`PostCompact`** cannot inject context; their `systemMessage` and `continue` are discarded (https://code.claude.com/docs/en/hooks#precompact). `PostCompact` receives `compact_summary`, which is the documented hook for logging what compaction produced.
- **Implication for large `SessionStart` injections:** a hook that injects a big block on `startup` *and* `compact` pays that block on every compaction cycle; over 10,000 chars it becomes a file path plus preview, and issue reports say the cut is silent (https://github.com/anthropics/claude-code/issues/91614). Issue #86061 describes the append-only accumulation ("N turns x block size, permanently, and it pulls compaction forward") and asks for a replace-in-place block; no such mechanism is documented as of 2.1.270 (https://github.com/anthropics/claude-code/issues/86061).
- **Prompt-cache cost (issue evidence, not documented):** #83913 reports that `PreToolUse`/`PostToolUse` `additionalContext` is re-rendered differently during history rebuild, causing a ~22k-token prefix rewrite on the next prompt; workaround given is to "disable tool-level hooks that return `additionalContext` ... Tool-level hooks can also remain for side-effect-only logging if they emit no model context" (https://github.com/anthropics/claude-code/issues/83913). Related: #84011 (trailing newline loss), #89651 (regression since 2.1.237). Several of these were reportedly improved in 2.1.259 (#91707), unverified here.

---

## What would make a hook feel like bloat (ranked by likely impact)

1. **`additionalContext` / plain stdout on per-turn or per-tool events.** `UserPromptSubmit` stdout, `PreToolUse`/`PostToolUse` `additionalContext`, or `SessionStart` on `compact` each add a system reminder that persists in the conversation and transcript and is replayed on resume. Cost is N firings x payload, append-only, and it is invisible in the UI. (hooks#add-context-for-claude; issue #86061)
2. **Tool-level `additionalContext` breaking prompt caching.** Reported prefix rewrites of ~22k tokens per turn; the user "feels" this as cost/latency rather than context size. (issue #83913; issue evidence only)
3. **Exit-2 / `decision: "block"` feedback on hot events.** `PostToolUse` exit 2 puts stderr in front of Claude on every matching call; a `Stop` hook that blocks can extend a turn up to 8 times, each continuation adding assistant turns. (hooks#exit-code-2-behavior-per-event; hooks#stop)
4. **`prompt` / `agent` hooks on `PreToolUse`/`PostToolUse`.** One Haiku call (or up to 50 subagent turns) per tool call, synchronous. (hooks#prompt-based-hooks)
5. **Misconfigured or flaky hooks.** Exit 1, invalid JSON, wrong field nesting, or a missing script path print a `<hook name> hook error` line per firing. (hooks#other-exit-codes; hooks-guide#hook-json-has-no-effect)
6. **Synchronous latency.** Hooks block by default; `UserPromptSubmit` gates every prompt; `PostToolUse` fires concurrently for parallel calls and Claude waits for all of them. (hooks#run-hooks-in-the-background; hooks#posttoolbatch)
7. **Over-broad matchers.** `*`/omitted on `PreToolUse`/`PostToolUse` spawns a process for every Read/Grep/Glob too. (hooks#matcher-patterns)
8. **Oversized injections.** Anything over 10,000 chars becomes a file path + preview, silently. (hooks#json-output; issues #91614, #84021)
9. **Async `systemMessage`.** Counter-intuitively goes to Claude, not the user, so a "notify me" async hook adds context. (hooks#how-async-hooks-execute)
10. **UI-only noise.** Sync `systemMessage`, "Allowed by PermissionRequest hook" lines, `[settings]` labels, and async completion notices in verbose mode. These do not cost tokens.

Not a bloat source: a `statusLine` command (the only automation in this user's `~/.claude/settings.json`) is not a hook and produces no context.

---

## How to make a hook run in the background / stay invisible

Rules: (a) pick a non-context event or, on context events, print nothing; (b) exit 0 always; (c) log to a file; (d) `async: true` for anything slow or side-effect-only, and return no JSON (or JSON without `additionalContext`/`systemMessage`); (e) narrow with `matcher` + `if`; (f) return JSON only when you actually need a decision.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/format-quiet.sh",
            "async": true,
            "timeout": 120
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(git *)",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/git-guard.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.last_assistant_message' >> \"$HOME/.claude/stop-log.txt\"; exit 0",
            "async": true
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "printf 'Branch: %s\\n' \"$(git branch --show-current 2>/dev/null)\""
          }
        ]
      }
    ]
  }
}
```

`format-quiet.sh` (fully silent; nothing reaches Claude or the transcript):

```bash
#!/bin/bash
f=$(jq -r '.tool_input.file_path // empty')
[ -n "$f" ] || exit 0
prettier --write "$f" >> "$HOME/.claude/format.log" 2>&1
exit 0
```

`git-guard.sh` (silent unless it has to block; only the block reason ever reaches Claude):

```bash
#!/bin/bash
cmd=$(jq -r '.tool_input.command')
case "$cmd" in
  *"push --force"*|*"reset --hard"*) echo "Blocked by git-guard: $cmd" >&2; exit 2 ;;
esac
exit 0
```

Why each choice is invisible, per the docs: `PostToolUse`/`PreToolUse`/`Stop` stdout on exit 0 is debug-log only (hooks#exit-code-0); async hooks show nothing to the user and only deliver `additionalContext`/`systemMessage` to Claude, which these scripts never emit (hooks#run-hooks-in-the-background); the `if` filter avoids spawning on non-git Bash calls (hooks-guide#filter-by-tool-name-and-arguments-with-the-if-field); the `compact` re-injection is one short factual line rather than a document, and runs only on compaction, not per turn (hooks-guide#re-inject-context-after-compaction). A `SessionStart` hook must not be async-only-for-silence: it is a context event, so redirect any logging inside it to a file.

---

## The user's own configuration (local inspection, 2026-09-14)

- `~/.claude/settings.json`: no `hooks` key. Contains `model`, `agentPushNotifEnabled`, `statusLine` (a `jq`-based command; runs per status refresh, not a hook, no model context), and an `autoMode.environment` block.
- `~/.claude/settings.local.json`: absent.
- `/Users/rahat-clawd/dev/hooks/.claude/`: absent; no project hooks. No `.claude/settings*.json` with a `hooks` key found under `~/dev` to depth 4.
- `~/.claude/plugins/`: only `marketplaces/` source copies (`claude-security`, `ralph-loop`, `hookify`, `explanatory-output-style`, `learning-output-style`, `security-guidance` ship `hooks/hooks.json`); no installed/enabled plugin directory found, so none of these hooks appear active. Not verified against `/hooks` inside a live session.
- Installed skills `git-guardrails-claude-code` and `setup-pre-commit` describe how to add hooks but do not install any by themselves.

So as of today there are no user- or project-level hooks on this machine that could be bloating a session; the tweet's advice is about hooks in general, not this config.

---

## Sources (all fetched 2026-09-14)

Primary documentation (fetched as raw Markdown via `https://code.claude.com/docs/en/<page>.md`):
- https://code.claude.com/docs/en/hooks -- Hooks reference (sections cited: #hook-lifecycle, #hook-handler-fields, #matcher-patterns, #exit-code-output, #exit-code-0, #exit-code-2, #other-exit-codes, #timeouts, #exit-code-2-behavior-per-event, #json-output, #add-context-for-claude, #decision-control, #sessionstart, #userpromptsubmit, #pretooluse-decision-control, #permissionrequest-decision-control, #posttooluse-decision-control, #annotate-a-result-for-the-auto-mode-classifier, #posttoolusefailure, #posttoolbatch, #notification, #subagentstart, #subagentstop, #taskcreated, #taskcompleted, #stop, #precompact, #postcompact, #sessionend, #prompt-based-hooks, #agent-based-hooks, #run-hooks-in-the-background, #how-async-hooks-execute, #limitations)
- https://code.claude.com/docs/en/hooks-guide -- Hooks guide (#re-inject-context-after-compaction, #how-hooks-work, #combine-results-from-multiple-hooks, #hook-output, #structured-json-output, #filter-hooks-with-matchers, #filter-by-tool-name-and-arguments-with-the-if-field, #auto-approve-specific-permission-prompts, #limitations, #stop-hook-hits-the-block-cap, #hook-json-has-no-effect, #debug-techniques)
- https://code.claude.com/docs/en/settings -- Settings reference (settings-file locations; hot reload of `hooks`; `/config verbose`)
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md -- fetched via raw.githubusercontent.com; versions 1.0.41 through 2.1.270 cited above

GitHub issues (user-experience evidence, not documented behaviour):
- https://github.com/anthropics/claude-code/issues/86061 -- append-only `additionalContext`; request for replace-in-place block
- https://github.com/anthropics/claude-code/issues/83913 -- PreToolUse/PostToolUse `additionalContext` invalidates prompt cache on history rebuild
- https://github.com/anthropics/claude-code/issues/84011 -- PreToolUse `additionalContext` trailing-newline loss breaks cache
- https://github.com/anthropics/claude-code/issues/89651 -- prompt-caching regression since 2.1.237, hook context uncacheable
- https://github.com/anthropics/claude-code/issues/91707 -- turn-boundary cache misses, reported fixed in 2.1.259
- https://github.com/anthropics/claude-code/issues/84021 -- hook output over 10K silently dropped
- https://github.com/anthropics/claude-code/issues/91614 -- 10,000-char cap collapsed to 2 KB preview, no warning
- https://github.com/anthropics/claude-code/issues/94358 -- `additionalContext` truncated at 10,000 chars
- https://github.com/anthropics/claude-code/issues/90296 -- UserPromptSubmit `additionalContext` intermittently not delivered
- https://github.com/anthropics/claude-code/issues/93458 -- SessionStart `additionalContext` dropped on `source=fork`
- https://github.com/anthropics/claude-code/issues/90685 -- PermissionRequest `systemMessage` not rendered at ExitPlanMode prompt
- https://github.com/anthropics/claude-code/issues/80882 -- SessionStart `systemMessage` not shown in VS Code side panel
- https://github.com/anthropics/claude-code/issues/94041 -- `/goal` Stop hook re-fires indefinitely

Local: `~/.claude/settings.json`, `~/.claude/plugins/`, `~/.claude/skills/`, `claude --version` (2.1.270), `/Users/rahat-clawd/dev/hooks/`.

---

## Unverified / open questions

- **Main-session compaction and injected context.** The docs never state outright that `additionalContext` from mid-session hooks is dropped or summarised by compaction in the main session; only the subagent section says so explicitly. The `compact` re-injection recipe implies it. Treat as inferred.
- **Exact token overhead of the system-reminder wrapper** per injection is not documented.
- **Whether the 10,000-char cap applies per hook or per event when several hooks return context.** Issue #91614 says per hook command; the docs say "capped at 10,000 characters" without specifying. Unverified.
- **Prompt-cache issues (#83913, #84011, #89651, #91707)** are user reports; some claim fixes in 2.1.259. Not reproduced here and not covered by the docs.
- **Whether `systemMessage` on `Notification` hooks is rendered anywhere** is not stated in the Notification section.
- **The `settings` page anchor for hot reload** (`#reload-settings`) was inferred from page text; the heading id was not confirmed.
- **Plugin hook activation on this machine** was inferred from directory layout (no installed-plugins dir), not from running `/hooks` in a session.
- No GitHub issue was found using the words "bloat" or "noise" about hooks; the closest matches are the `additionalContext` accumulation (#86061) and cache-invalidation (#83913) threads.
