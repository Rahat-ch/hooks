# What hooks are people actually writing for coding agents? A catalog of patterns

Researched 2026-10-07. This is the "what exists and what does it do" companion to [`hooks-tool-opportunity.md`](hooks-tool-opportunity.md) (demand and pain), [`agent-framework-hooks.md`](agent-framework-hooks.md) (event schemas for Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Hermes, Aider) and [`hooks-session-bloat.md`](hooks-session-bloat.md) (how hook output enters Claude Code's context). I don't repeat their content here.

**Sources.** All primary:
- vendor docs and changelogs;
- the hook repos and config files themselves;
- GitHub issue threads;
- Hacker News threads, via the Algolia API.

**Evidence bases.** Five, each with its own blind spot:

| Code | Basis | Size | Blind spot |
|---|---|---|---|
| CS | GitHub code search over committed hook configs | 153 queries, plus 304 hook entries hand-classified from 226 repos and 8 agents | Approximate counts; misses user-level configs |
| COL | Inventories of the big hook collections, lists and marketplaces | about 75 repos | Curated, not usage |
| SP | Single-purpose hook repos found by repo search | about 150 implementations; 1,931 repos screened, 707 with ≥10★ | Misses hooks inlined in dotfiles |
| VG | Vendor example galleries | 17 agents | What vendors think is canonical, not usage |
| ISS | Issue-tracker demand | `anthropics/claude-code` and 4 other repos | Skews to bugs |

Stars and licenses come from `gh api repos/<owner>/<repo>` on 2026-10-07. Reddit and X were unreachable (see Unverified).

## Verdict (one paragraph)

**Two patterns dominate: format the file after an edit, and block a dangerous action before it runs.**
- In committed configs, format/lint (53 of 304 entries) and safety guards (52) lead every other category. Behind them come Stop-hook quality gates (30), context injection (28) and typecheck/test (17) (CS).
- The same five appear in every vendor gallery (VG) and recur in 10–13 of the big collections each (COL).

**Notifications are the most-published single-purpose hook**, but they live in uncommitted user settings:
- 21+ standalone repos have ≥10★ (SP), and the top hook story on HN scored 1,006 points.
- They are only 14 per 100 PreToolUse in project files (CS).

**The highest-starred projects are products delivered through hooks**, not hook libraries:
- memory: claude-mem, 97.7k★;
- output-token rewriting: rtk, 82.6k★;
- skill bootstrapping: superpowers, 296k★, which is one SessionStart hook.

**The ecosystem is wide and shallow.** Dozens of near-identical notifiers, `rm -rf` blockers and formatters exist, mostly regex-based, mostly Claude-only, and often broken:
- About 1.2k committed `.claude/settings.json` files read env vars such as `$CLAUDE_TOOL_INPUT_FILE_PATH` that the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks.md) does not define.
- Others use `exit 1` when they mean "block".

**The most complete collections cannot be borrowed from.** The licenses rule them out:
- disler: no license;
- dcg: MIT plus a rider barring Anthropic/OpenAI and ML use;
- swiz: PolyForm Noncommercial;
- oh-my-openagent: Sustainable Use License.

**Portability is newly real.** Copilot CLI, Cursor, Devin CLI and Continue `cn` now read `.claude/settings.json` hooks at runtime, and VS Code does so opt-in. Capability gaps (no input rewriting, no context injection, exit-code-only blocking) still force per-agent adapters.

**The library opportunity** is a small, permissively licensed, tested, correct-protocol set of the ~20 hooks below. They should rest on a real shell parser and ship per-agent adapters. This fits the debugger/test-harness wedge recommended in [`hooks-tool-opportunity.md`](hooks-tool-opportunity.md) §6.

---

## 1. Event surface per agent (delta only)

[`agent-framework-hooks.md`](agent-framework-hooks.md) §3 covers Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Hermes and Aider as of 2026-09-14; this section covers only agents that doc did not, plus changes since. Abbreviations:
- **B** block
- **A** allow (skip the prompt)
- **Q** ask
- **M** modify tool input
- **C** add context
- **F** force another turn from Stop

### 1a. Agents not previously covered

| Agent | Events (canonical) | Transport | Config | Decisions | Fail mode | Source |
|---|---|---|---|---|---|---|
| **GitHub Copilot CLI** | sessionStart, sessionEnd, userPromptSubmitted, userPromptTransformed, preToolUse, postToolUse, postToolUseFailure, permissionRequest, agentStop, subagentStart, subagentStop, preCompact, errorOccurred, notification (14). PascalCase aliases give a Claude-compatible payload. | shell+JSON (`bash`/`powershell`/`exec`), `http`, `prompt` (sessionStart only) | `.github/hooks/*.json`, `~/.copilot/hooks/`, `.github/copilot/settings.json`, **`.claude/settings(.local).json`**, plugins, root-owned policy dir `/etc/github-copilot/policy.d/` | B A Q M C F, plus rewrite result/prompt | preToolUse command hooks **fail closed** on crash or non-zero exit; **timeouts fail open everywhere**; HTTP preToolUse fails open | https://docs.github.com/en/copilot/reference/hooks-reference ; CLI GA 2026-02-25 https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available/ |
| **Copilot cloud agent** | Subset of the CLI events. notification doesn't fire; permissionRequest has no effect; `ask` is treated as deny. | shell+JSON, `http` | `.github/hooks/*.json` on the **default branch** only | B M C F | Same as CLI | https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/use-hooks |
| **VS Code Copilot Chat ("Local" harness), Preview** | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, SubagentStart, SubagentStop, Stop | shell+JSON | `.github/hooks/`, `~/.copilot/hooks/`, `.agent.md` frontmatter. `.claude/settings*.json` only with `chat.useClaudeHooks` (off by default), and **Claude matchers are ignored**. | B A Q M C F | Non-0/2 exit warns and continues | https://code.visualstudio.com/docs/agent-customization/hooks ; v1.110 2026-03-06 https://github.blog/changelog/2026-03-06-github-copilot-in-visual-studio-code-v1-110-february-release/ |
| **Windsurf Cascade (now "Devin Desktop")** | pre/post_read_code, pre/post_write_code, pre/post_run_command, pre/post_mcp_tool_use, pre_user_prompt, post_cascade_response, post_cascade_response_with_transcript, post_setup_worktree (12) | shell+JSON | `.devin/hooks.json` (legacy `.windsurf/hooks.json`), `~/.codeium/windsurf/hooks.json`, system dir, team dashboard | **B only, via exit 2.** No JSON decisions, no input modification, no context injection. | Other exits proceed | https://docs.devin.ai/desktop/cascade/hooks |
| **Devin CLI** | PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop, PostCompaction, SessionStart, SessionEnd | shell+JSON, `prompt` | `.devin/hooks.v1.json`, **plus `.claude/settings*.json` and `~/.claude.json` by default** | B A M C | Other exits logged | https://docs.devin.ai/cli/extensibility/hooks/overview.md |
| **Cline** (VS Code extension) | TaskStart, TaskResume, TaskCancel, TaskComplete, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Notification | One executable per event, shell+JSON | `.clinerules/hooks/<Event>`, `~/Documents/Cline/Hooks/` | B C (`cancel`, `contextModification`). **Cannot modify input.** | 30 s timeout; errors "handled silently" | https://github.com/cline/cline/blob/main/.clinerules/hooks/README.md ; v3.36.0 https://github.com/cline/cline/blob/main/CHANGELOG.md |
| **Cline CLI/SDK** | File hooks TaskStart…SessionShutdown; plugin `beforeTool`/`afterTool`/`beforeModel`… | shell+JSON plus in-process TS | `.cline/hooks/<Event>.{sh,py,ts}`; `.cline/plugins` | B Q M C (`overrideInput`, `review`) | Per-hook `failureMode: fail_open\|fail_closed` | https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md ; https://docs.cline.bot/sdk/plugins.md |
| **Kiro** (IDE 1.x / CLI 3) | SessionStart, Stop, UserPromptSubmit, PreToolUse, PostToolUse, PostFileCreate/Save/Delete, PreTaskExec, PostTaskExec, Manual; SessionEnd (CLI 2.25.0, 2026-09-28) | shell+JSON (`command`) or `agent` (prompt injection) | `.kiro/hooks/*.json` `{version:"v1"}`, `~/.kiro/hooks/` (legacy `.kiro.hook`) | B (exit 2), C, F (Stop `decision:block`) | Other exits warn | https://kiro.dev/docs/hooks/types.md ; https://kiro.dev/changelog/cli/ |
| **Amp** | session.start, agent.start, tool.call, tool.result, agent.end, changes.prompt | **In-process TS plugin only**; no shell hooks | `.amp/plugins/`, `~/.config/amp/plugins/` | allow / reject-and-continue / modify / synthesize / error; `agent.end` → continue | not documented | https://ampcode.com/docs/plugin-api |
| **Augment (Auggie CLI)** | PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd | shell+JSON | `.augment/settings.json`, `~/.augment/settings.json`, `/etc/augment/` | **B (deny only)**, C, F. Allow/ask/`updatedInput` are "not yet implemented". | Non-blocking; runs sequentially | https://docs.augmentcode.com/cli/hooks |
| **Factory Droid** | PreToolUse, PostToolUse, UserPromptSubmit, Notification, Stop, SubagentStop, PreCompact, SessionStart, SessionEnd | shell+JSON | `.factory/hooks.json`, `~/.factory/hooks.json`, plugins (translates Claude plugin layouts) | B A Q M C F (Claude-style) | Non-blocking | https://docs.factory.com/harness/hooks |
| **Qwen Code** | 22 events (Claude's set plus SessionDelete, TodoCreated, TodoCompleted) | command, http, function, prompt | `.qwen/settings.json` | B A Q M C F | Non-blocking; project hooks need a trusted folder | https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md |
| **Kimi Code CLI** | 20 events incl. PreToolUse, Stop, PermissionRequest, Pre/PostCompact | shell+JSON | `[[hooks]]` in `~/.kimi-code/config.toml` | B C F (only PreToolUse, Stop, UserPromptSubmit) | **Explicitly fail-open**; "should not be used as the sole security barrier" | https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md |
| **Google Antigravity** | PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop | shell+JSON (camelCase) | `.agents/hooks.json`, `~/.gemini/config/hooks.json` | allow / deny / ask / force_ask / deny_unless_prior_grant; `injectSteps`; Stop `continue` | not documented | https://antigravity.google/docs/hooks |
| **Continue `cn` CLI** | 17 Claude event names; "any hook written for `claude` works with `cn` out of the box" (source comment) | command, http | `.continue/settings.json` **and `.claude/settings*.json`** | Claude contract | not checked | https://github.com/continuedev/continue/tree/main/extensions/cli/src/hooks |
| **JetBrains Junie CLI** (EAP) | SessionStart, UserPromptSubmit, PreToolUse, Stop, StopFailure, PermissionRequest, SessionEnd | shell+JSON | `~/.junie/config.json`; **project config ignored by default** | B A M C F | Never aborts | https://junie.jetbrains.com/docs/junie-cli-hooks.html |
| **OpenHands** | PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, SessionEnd | shell+JSON; SDK adds prompt/agent | `.openhands/hooks.json` (accepts Claude PascalCase keys) | B C F | Only exit 2 blocks | https://github.com/OpenHands/docs/blob/main/openhands/usage/customization/hooks.mdx |
| **Goose** (Block) | 12 events incl. Cursor-style BeforeShellExecution, AfterFileEdit | shell+JSON via Open Plugins `hooks/hooks.json` | `.agents/plugins/<p>/hooks/` | B F (PreToolUse, Stop) | Fail-open; per-hook `on_failure: block` on PreToolUse | https://github.com/block/goose/blob/main/documentation/docs/guides/context-engineering/hooks.md |
| **Crush** (Charm) | PreToolUse only | shell+JSON | `crush.json` | B A M C; **exit 49 halts the turn** | Timeout means "no opinion" | https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md |
| **Roo Code / Zed / Warp** | none | none | none | none | none | Roo repo archived, hook requests open (https://github.com/RooCodeInc/Roo-Code/issues/12206). Zed: nothing in docs (https://github.com/zed-industries/zed/tree/main/docs/src/ai). Warp: request open (https://github.com/warpdotdev/warp/issues/7834). |

### 1b. Changes since 2026-09-14 for agents already covered

- **Claude Code: "Claude Mods" (2.1.287, 2026-10-01).** A plugin can register **in-process JavaScript function hooks** as middleware `on(event, matcher?, ($, e, next) => …)`. About 50 events (`tool.call`, `tool.check`, `prompt.submit`, `turn.step`, `session.compact`, `ui.render`…), and settings hooks are re-exposed as `classic.<Event>` (https://code.claude.com/docs/en/plugins/mods/reference.md). A community catalogue already lists 2,690 mods (https://github.com/karanb192/awesome-claude-code-mods).
- **Claude Code: no new settings-hook events**, but behaviour fixes (https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md):
  - 2.1.288: PreToolUse and PermissionRequest now **block** when matching fails, which is a fail-closed change.
  - 2.1.290: permission rules are re-applied after an `updatedInput` rewrite.
  - 2.1.292: `<system-reminder>` tags in hook output are escaped.
- **Cursor** now documents `workspaceOpen` and a cloud-agent hook table (https://cursor.com/docs/hooks). It loads Claude Code hooks from `.claude/settings*.json` **by default**, mapping 8 events; Notification and PermissionRequest are unsupported (https://cursor.com/docs/reference/third-party-hooks).
- **Codex and Gemini CLI**: no new events (https://developers.openai.com/codex/hooks.md ; https://geminicli.com/docs/hooks/reference/). Gemini offers a one-shot `hooks migrate --from-claude` (https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/commands/hooks/migrate.ts).

### 1c. Who runs a Claude Code hook config unchanged

| Agent | Reads `.claude/settings*.json` hooks | Default |
|---|---|---|
| Copilot CLI | yes (repo files) | on |
| Cursor | yes (repo and user) | on |
| Devin CLI | yes (plus `~/.claude.json`) | on |
| Continue `cn` | yes (source) | on |
| VS Code Local harness | yes, but ignores matchers | **off** |
| Factory | plugin layouts only | not applicable |
| Gemini CLI | one-shot migration | not applicable |
| Qwen, OpenHands, Crush | format-compatible, own file location | not applicable |

Sources are the per-agent docs in §1a/§1b. Implication: a hook written to Claude Code's protocol, with Claude tool names in its matchers, reaches the most agents with no adapter. Matcher handling and decision support still diverge, so it needs per-agent tests.

### 1d. Footprint in public repos (code-search file counts, 2026-10-07, approximate)

| Config | Files | Query |
|---|---:|---|
| `.claude/settings.json` mentioning "hooks" | ≈33.7k | `"hooks" path:.claude filename:settings.json` |
| Plugin `hooks/hooks.json` | ≈8.3k | `path:hooks filename:hooks.json "hooks"` |
| Kiro `.kiro/hooks` | ≈5.3k | `path:.kiro/hooks` |
| Codex `.codex/hooks.json` | ≈4.3k | `path:.codex filename:hooks.json` |
| Copilot `.github/hooks/*.json` | ≈2.8k | `path:.github/hooks extension:json` |
| Cursor `.cursor/hooks.json` | ≈2.4k | `path:.cursor filename:hooks.json` |
| Codex `config.toml` mentioning "hooks" | ≈1.4k | `"hooks" path:.codex filename:config.toml` |
| OpenCode `tool.execute.before` | ≈1.3k | `"tool.execute.before" path:.opencode` |
| Gemini `.gemini/settings.json` mentioning "hooks" | ≈0.6k | `"hooks" path:.gemini filename:settings.json` |
| Cline `.clinerules/hooks` | ≈0.2k | `path:.clinerules/hooks` |
| Windsurf `.windsurf/hooks.json` | ≈0.1k | `path:.windsurf filename:hooks.json` |

Counts are files, not repos. They include forks and over-match on tokens.

Event frequency in `.claude/settings.json`, normalised to PreToolUse = 100 (16,480 files):

| Event | Relative count |
|---|---:|
| PostToolUse | 102 |
| Stop | 84 |
| SessionStart | 45 |
| UserPromptSubmit | 33 |
| PreCompact | 15 |
| Notification | 14 |
| SessionEnd | 12 |
| SubagentStop | 11 |
| SubagentStart | 7 |
| PostToolUseFailure | 4 |
| PermissionRequest | 4 |

---

## 2. Catalog of hook use cases found in the wild

### 2.0 How common each category is

| Category | CS: classified entries (of 304) | CS: share of 107 Claude repos with ≥1 | COL: collections containing it (of ~30 inventoried) | SP: standalone repos ≥10★ | In vendor galleries (VG) |
|---|---:|---:|---:|---:|---|
| Format / lint on edit | 53 | 28% | 10–12 | ~10 (format-only ones are mostly <10★) | Anthropic, VS Code, Windsurf, Kiro, Factory, Augment |
| Safety guardrails (shell, git, secrets, paths) | 52 | 24% | 10–11 each sub-pattern | 15+ (shell), 5 (secrets) | Anthropic, Cursor, Copilot, Windsurf, Cline, Kimi, Goose, OpenHands, Crush, Augment, Factory, Gemini |
| Workflow / Stop gating / loops | 30 | 15% | 11 | 13+ | Anthropic (prompt/agent Stop), Amp (/goal), OpenHands, Augment |
| Context injection | 28 | 19% | 13+ | ~9 | Anthropic (post-compact), Gemini, VS Code, Factory, Cline |
| Typecheck / tests | 17 | 9% | 7–12 | (inside quality repos) | Anthropic (agent Stop), Kiro, Augment |
| Memory / compaction | 13 | 7% | 11 | ~10 | Gemini, Codex (use-case list) |
| Logging / audit / telemetry | 13 | 8% | 13+ | ~11 | Cursor, Copilot, VS Code, Windsurf, Kiro, Anthropic (http, ConfigChange), Codex, Goose, OpenHands, Crush |
| Notifications | 12 | 8% | 13 | **21+** | Anthropic (first example), Cline, Kimi |
| Multi-agent / worktrees | 13 | 6% | 4 | ~5 | Windsurf (worktree setup) |
| Security scanning / policy | 11 | 4% | 9 | ~8 plus Cursor partner vendors | Copilot (secrets, licenses), Kiro, Codex (MCP scanner) |
| Doc sync | 10 | 6% | 3 | ~2 | Kiro (i18n, API docs) |
| Tool redirection / token rewriting | 9 | 4% | 9 | ~15 (rewriters); redirect-only all <10★ | Anthropic (`grep`→`rg` example), Crush (rtk), Cline (npm flag) |
| Commit hygiene | 9 | 6% | 6 | ~8 | Copilot (auto-commit), Kiro (commit msg) |
| Anti-shortcut / reward-hacking guards | 7 | 3% | 8 | ~5 | none |
| Permission auto-approval | 0 in project configs | 0% | 7 | ~9 | Anthropic (PermissionRequest), Crush, VS Code (`ask`) |

The CS columns come from the hand-classified sample (178 Claude Code entries, 37 Cursor, 24 Codex, 15 Gemini, 13 plugin entries, and 37 for Copilot, Windsurf, Kiro, Cline and OpenCode combined). Rows marked "name" there were classified from the script name. COL and SP counts are lower bounds.

**Reading the evidence by source:**
- **Committed project configs (CS)** are dominated by format, guards, gates and context.
- **Published repos (SP)** are dominated by notifications, memory and token savers. These are things people install per-user, not per-repo.
- **Auto-approval** appears in published tools and vendor docs but in **none** of the 108 sampled project configs.

The sections below give each pattern's event, what it does, example implementations, commonness and portability. Portability shorthand:

| Grade | Meaning |
|---|---|
| **P1** | Pure block / allow on a pre-tool or prompt event. Works on every shell-hook agent, including Windsurf's exit-2-only model. |
| **P2** | Needs context injection or `updatedInput`. Fails or degrades on Windsurf, Cline (no input modification), Augment (deny only) and, per tool READMEs, Codex (see §4.6). |
| **P3** | Needs a Claude-specific event: Notification, PreCompact or SessionStart(compact), PermissionRequest, WorktreeCreate, ConfigChange, FileChanged. |

### 2.1 Safety and guardrails

| Pattern | Event(s) | What it does | Example implementations | Commonness | Port. |
|---|---|---|---|---|---|
| **Block destructive shell commands** | PreToolUse(Bash); Cursor `beforeShellExecution`; Windsurf `pre_run_command`; Gemini `BeforeTool(run_shell_command)` | Denies `rm -rf` on `/`, `~`, `..` or wildcards, `mkfs`, `dd` to a device, fork bombs, `curl \| sh`, `sudo`. Better ones parse `bash -c`, `python -c`, heredocs and `$()`. | • [disler pre_tool_use.py](https://github.com/disler/claude-code-hooks-mastery/blob/main/.claude/hooks/pre_tool_use.py) (regex)<br>• [karanb192 block-dangerous-commands](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/block-dangerous-commands) (3 levels)<br>• [kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net) (1,582★, semantic parse, about 17 CLIs)<br>• [Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) (6,106★, Rust, 115 rule packs)<br>• [manuelschipper/nah](https://github.com/manuelschipper/nah) (487★, action-type classifier; [HN 127 pts](https://news.ycombinator.com/item?id=47343927))<br>• [banyudu/claude-warden](https://github.com/banyudu/claude-warden) (bash-parser AST)<br>• [difflabai/claude-guardrails](https://github.com/difflabai/claude-guardrails) (tree-sitter, fail-closed)<br>• [hookify `block-dangerous-rm`](https://github.com/anthropics/claude-code/tree/main/plugins/hookify/examples)<br>• [claude-code-templates shell-wrapper-guard](https://github.com/davila7/claude-code-templates/blob/main/cli-tool/components/hooks/security/shell-wrapper-guard.json) | **Very common.** 11 collections; ≈4.7k `.claude/hooks` files contain `rm -rf`; in 10 vendor galleries ([Windsurf](https://docs.devin.ai/desktop/cascade/hooks), [Copilot tool-guardian](https://github.com/github/awesome-copilot/tree/main/hooks), [Kimi](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md), [Goose](https://github.com/block/goose/blob/main/documentation/docs/guides/context-engineering/hooks.md), [OpenHands](https://github.com/OpenHands/software-agent-sdk/tree/main/examples/01_standalone_sdk/33_hooks), [Crush](https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md#examples), [Augment](https://docs.augmentcode.com/cli/hooks), [Cline](https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md)). | P1 |
| **Destructive-git / protected-branch guard** | PreToolUse(Bash) | Denies `push --force` (often allowing `--force-with-lease`), `reset --hard`, `checkout --`/`restore`, `clean -f`, `branch -D`, `stash drop/clear`, commit or push on `main`, `--no-verify`, `gh pr merge` | • [karanb192 git-safety](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/git-safety)<br>• [fcakyon block_force_push.py](https://github.com/fcakyon/claude-codex-settings/blob/main/plugins/ultralytics-dev/hooks/scripts/block_force_push.py)<br>• [dcg core.git pack](https://github.com/Dicklesworthstone/destructive_command_guard/blob/main/docs/packs/core.md)<br>• [mattpocock git-guardrails skill](https://github.com/mattpocock/skills/tree/main/skills/misc/git-guardrails-claude-code) (a skill that installs a hook)<br>• [Cursor docs `block-git.sh`](https://cursor.com/docs/hooks#examples)<br>• Real configs: [DataDog/documentation block-master-git.py](https://github.com/DataDog/documentation/blob/HEAD/.claude/hooks/block-master-git.py), [teambit/bit block-master-push.sh](https://github.com/teambit/bit/blob/HEAD/.claude/hooks/block-master-push.sh), [aim2bpg/rubree inline jq](https://github.com/aim2bpg/rubree/blob/HEAD/.claude/settings.json) | **Very common.** 11 collections; ≈5.0k hook files contain `git push` and ≈4.2k contain `--force`. Demand: agent bypassing pre-commit with `--no-verify` ([claude-code#40117](https://github.com/anthropics/claude-code/issues/40117)). | P1 |
| **Protect secrets / `.env` / keys from reads and writes** | PreToolUse(Read\|Edit\|Write\|Bash\|Grep); Cursor `beforeReadFile`; Windsurf `pre_read_code` | Denies access to `.env*` (allows `.env.example`), `~/.ssh`, `~/.aws`, keystores and credential files, including via `cat` or `grep` in Bash | • [Anthropic hooks guide "Block edits to protected files"](https://code.claude.com/docs/en/hooks-guide.md)<br>• [karanb192 protect-secrets](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/protect-secrets)<br>• [claudekit file-guard](https://github.com/carlrannaberg/claudekit/tree/main/cli/hooks/file-guard) (merges `.aiignore`, `.cursorignore`, `.geminiignore`…)<br>• [JeongJaeSoon/agent-guard](https://github.com/JeongJaeSoon/agent-guard) (configurable fail mode)<br>• [albert-labs inline jq deny](https://github.com/albert-labs/albert-python/blob/HEAD/.claude/settings.json)<br>• [Cline ClineignoreGuard example](https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md) | **Very common.** 10 collections; ≈18k hook files mention `.env`. Known bypass: the "file changed on disk" notification leaks a guarded file ([claude-code#94082](https://github.com/anthropics/claude-code/issues/94082)). | P1 |
| **Secret scanning of writes, commits and output; redaction** | PreToolUse(Write\|Edit; Bash `git commit`); PostToolUse; Stop; Cursor `beforeSubmitPrompt` | Regex or gitleaks over new content or the staged diff; redacts secrets and PII before the model sees tool output | • [webdevtodayjason secret-scanner.py](https://github.com/webdevtodayjason/claude-hooks/blob/main/hooks/secret-scanner.py)<br>• [mintmcp/agent-security](https://github.com/mintmcp/agent-security) (Cursor partner)<br>• [l-mb/claude-code-redaction-hooks](https://github.com/l-mb/claude-code-redaction-hooks) (in-place redaction)<br>• [coo-quack/sensitive-canary](https://github.com/coo-quack/sensitive-canary)<br>• [Copilot gallery secrets-scanner](https://github.com/github/awesome-copilot/tree/main/hooks)<br>• [Gemini "block secrets" example](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md)<br>• [karanb192/claude-code-redact](https://github.com/karanb192/claude-code-redact) (mod)<br>• [sonar-golc sonar-secrets](https://github.com/sonar-solutions/sonar-golc) | **Common.** 9 collections; gitleaks in ≈280 hook files, trufflehog in ≈57. Codex demand: "scan prompts to block pasted API keys" is on its [hooks page](https://developers.openai.com/codex/hooks.md). | P1 (block) / P2 (redact) |
| **Guard the guards** | PreToolUse(Edit\|Write\|Bash); ConfigChange | Blocks the agent from editing `.claude/settings*.json`, hook scripts, `.mcp.json`, linter configs or CI workflow permissions | • [karanb192 config-guard + config-watch](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/config-guard)<br>• [alexfazio/plankton protect_linter_configs.sh](https://github.com/alexfazio/plankton/blob/HEAD/.claude/hooks/protect_linter_configs.sh)<br>• swiz `eslint-config-strength` / `workflow-permissions-gate` ([README](https://github.com/mherod/swiz/blob/main/README.md))<br>• [ECC config-protection](https://github.com/affaan-m/ECC/blob/main/hooks/README.md)<br>• [Anthropic hooks guide ConfigChange audit](https://code.claude.com/docs/en/hooks-guide.md) | **Moderate.** 6 collections. The rationale is the agent weakening its own checks. | P1 |
| **Protected / generated paths** | PreToolUse(Edit\|Write) | Blocks edits to generated code, lockfiles, `vendor/` or `node_modules`, compiled assets, or architecture-frozen dirs | • Anthropic guide example blocks `package-lock.json` and `.git/` ([guide](https://code.claude.com/docs/en/hooks-guide.md))<br>• [wafflebase guard-generated-files.sh](https://github.com/wafflebase/wafflebase/blob/HEAD/.claude/settings.json)<br>• [joelmoss/proscenium](https://github.com/joelmoss/proscenium/blob/HEAD/.claude/settings.json) (`ext/`; buggy, see §4.5)<br>• swiz `no-lockfile-edit`, `no-node-modules-edit`<br>• [Steve Kinney's recommended list](https://stevekinney.com/courses/ai-development/claude-code-hooks) | **Common** in project configs (CS). | P1 |
| **Prompt-injection scanning of tool output** | PostToolUse(Read\|WebFetch\|Bash\|Grep\|Task); InstructionsLoaded | Pattern-matches injected instructions in fetched content and warns the model; audits CLAUDE.md for invisible Unicode and exfiltration directives | • [lasso-security/claude-hooks](https://github.com/lasso-security/claude-hooks) (267★, warn-only)<br>• [vaporif/parry-guard](https://github.com/vaporif/parry-guard) (classifier model)<br>• [karanb192 instructions-audit](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/instructions-audit)<br>• [hswtnb-blip/prompt-authgate](https://github.com/hswtnb-blip/prompt-authgate) (per-prompt auth token)<br>• Sondera `forbid-prompt-injection` ([policies](https://github.com/sondera-ai/sondera-coding-agent-hooks/tree/main/.sondera/policies/cedar)) | **Niche, growing.** 4 collections; 3–4 SP. | P2 |
| **Egress / exfiltration control** | PreToolUse(Bash\|WebFetch) | Allowlists POST domains; blocks credential-path plus network-tool combinations, paste sites and webhook catchers | • [slavaspitsyn/claude-code-security-hooks](https://github.com/slavaspitsyn/claude-code-security-hooks)<br>• [Adirdabush1/cerberus](https://github.com/Adirdabush1/cerberus)<br>• Sondera `forbid-webfetch-exfiltration`<br>• [openwpm pre-web-check.py](https://github.com/openwpm/OpenWPM/blob/HEAD/.claude/settings.json) | **Rare.** HN pushback: hooks are the "wrong layer" compared with a sandbox ([HN 46388882](https://news.ycombinator.com/item?id=46388882)). | P1 |
| **Supply-chain / dependency guard** | PreToolUse(Bash install); PostToolUse | Blocks hallucinated package names, packages that are too new or too old, or known-malicious installs | • [Copilot gallery attester-import-check](https://github.com/github/awesome-copilot/tree/main/hooks)<br>• [decider check-package-age.py](https://github.com/decider/claude-hooks/blob/main/hooks/check-package-age.py)<br>• Endor Labs `check-dep-install` ([official marketplace](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json))<br>• [UAantovakul/no-npm-claude](https://github.com/UAantovakul/no-npm-claude) (npm→pnpm as supply-chain defence) | **Emerging**, vendor-led ([Cursor partners: Endor Labs](https://cursor.com/blog/hooks-partners)) | P1 |

### 2.2 Code quality

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Format on edit** | PostToolUse(Edit\|Write\|MultiEdit); Cursor `afterFileEdit`; Windsurf `post_write_code`; Copilot `postToolUse`; Kiro `PostFileSave` | Runs a formatter on the edited file, chosen by extension (prettier, biome, ruff, black, gofmt, `cargo fmt`, rubocop, swiftlint, php-cs-fixer, ktlint) | • [Anthropic hooks guide "Auto-format code after edits"](https://code.claude.com/docs/en/hooks-guide.md)<br>• [karanb192 format-code](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/format-code)<br>• [fcakyon post_write.py](https://github.com/fcakyon/claude-codex-settings/blob/main/plugins/ultralytics-dev/hooks/scripts/post_write.py)<br>• [ryanlewis/claude-format-hook](https://github.com/ryanlewis/claude-format-hook)<br>• Real configs: [flox/flox format.sh](https://github.com/flox/flox/blob/HEAD/.claude/hooks/format.sh), [AstraZeneca/runnable](https://github.com/AstraZeneca/runnable/blob/HEAD/.claude/settings.json) (ruff), [flipperdevices/Flipper-iOS-App](https://github.com/flipperdevices/Flipper-iOS-App/blob/HEAD/.claude/settings.json) (swiftlint), [mantidproject/mantid](https://github.com/mantidproject/mantid/blob/HEAD/.github/hooks/copilot-hooks.json) (Copilot runs pre-commit), [duckduckgo](https://github.com/duckduckgo/content-scope-scripts/blob/HEAD/.claude/settings.json) (Claude reuses `.cursor/hooks/format.sh`) | **The single most common committed hook.** 53/304 entries; ≈2.1k settings files mention prettier and ≈3.3k ruff. Dominant on Cursor, Copilot and Windsurf too (CS). | P1 (no decision needed) |
| **Lint / typecheck feedback** | PostToolUse with `decision:"block"` or `additionalContext`; or exit 2 | Runs eslint, ruff, tsc, pyright, ty or clippy on the changed file and feeds errors back so the agent fixes them | • [disler ruff_validator / ty_validator](https://github.com/disler/claude-code-hooks-mastery/blob/main/.claude/hooks/validators/ruff_validator.py)<br>• [claudekit typecheck-changed / lint-changed](https://github.com/carlrannaberg/claudekit/blob/main/cli/hooks/typecheck-changed.ts)<br>• [bartolli quality-check.js](https://github.com/bartolli/claude-code-typescript-hooks/blob/main/.claude/hooks/node-typescript/quality-check.js) (SHA256 config cache)<br>• [Continuous-Claude typescript-preflight](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/src/typescript-preflight.ts)<br>• [civitai check-svelte-ts.mjs](https://github.com/civitai/civitai/blob/HEAD/.claude/hooks/check-svelte-ts.mjs) | **Very common.** 12 collections; tsc appears in ≈3.2k hook files. | P2 (feedback) |
| **Run tests on change** | PostToolUse(Edit) | Runs related or quick tests after edits | • [claude-code-templates run-tests-after-changes](https://github.com/davila7/claude-code-templates/blob/main/cli-tool/components/hooks/post-tool/run-tests-after-changes.json)<br>• claudekit `test-changed`<br>• [Kiro "Test coverage maintainer"](https://kiro.dev/docs/hooks/examples.md) | **Moderate.** Practitioners push heavy checks to Stop instead ([web-developpeur](https://www.web-developpeur.com/en/blog/claude-code-hooks-exemples)). A per-edit test hook "starved a builder for two hours" ([claude-code#97820](https://github.com/anthropics/claude-code/issues/97820)). | P2 |
| **Anti-shortcut / reward-hacking guards** | PreToolUse(edits); Stop | Blocks deleting, skipping or `xfail`-ing tests; adding `@ts-ignore`, `eslint-disable` or `as any`; replacing code with comments; "pre-existing issue" excuses | • [karanb192 protect-tests](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/protect-tests)<br>• [claudekit check-any-changed / check-comment-replacement](https://github.com/carlrannaberg/claudekit/tree/main/cli/hooks)<br>• [RNCopilot suppression-comment block](https://github.com/FouadMagdy01/RNCopilot/blob/HEAD/.claude/settings.json)<br>• [hahahahahahahahah6/agent-guard](https://github.com/hahahahahahahahah6/agent-guard) (test-tampering)<br>• fakegreen and isitdone (Gemini; [awesome-gemini-cli](https://github.com/Piebald-AI/awesome-gemini-cli))<br>• [oh-my-openagent commentChecker](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/hooks/AGENTS.md) | **Moderate, rising.** 8 collections. | P1 |
| **TDD enforcement** | PreToolUse(Write\|Edit\|TodoWrite) | Blocks implementation without a failing test, using test-reporter output plus an LLM judge | • [nizos/tdd-guard](https://github.com/nizos/tdd-guard) (2,358★)<br>• successor [nizos/probity](https://github.com/nizos/probity) (Claude Code, Codex, Copilot)<br>• [claude-code-templates tdd-gate](https://github.com/davila7/claude-code-templates/blob/main/cli-tool/components/hooks/quality-gates/tdd-gate.json) | **Niche, but tdd-guard is a top single-purpose repo.** | P1 |
| **LSP-first / structural navigation** | PreToolUse(Grep\|Read) | Blocks grep on symbols or large Reads and points to LSP or AST tools | • [nesaminua/claude-code-lsp-enforcement-kit](https://github.com/nesaminua/claude-code-lsp-enforcement-kit) (328★)<br>• [Continuous-Claude tldr-read-enforcer](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/src/tldr-read-enforcer.ts) | **Niche** | P1 |
| **Architecture / convention rules** | PreToolUse(Write\|Edit) | Enforces naming, layering or DDD rules, file-length limits, no duplicate routes | • [BULDEE/ai-craftsman-superpowers](https://github.com/BULDEE/ai-craftsman-superpowers) ("same rules engine in hooks and CI")<br>• [decider portable-quality-validator](https://github.com/decider/claude-hooks/blob/main/hooks/portable-quality-validator.py)<br>• [boxabirds file-name-consistency](https://github.com/boxabirds/awesome-hooks/blob/main/README.md) | **Niche**, project-specific | P1 |

### 2.3 Context injection

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Session briefing** | SessionStart(startup\|resume\|clear\|compact) | Injects git branch, status and recent commits, open issues, roadmap or PROGRESS.md, TODOs, stack and commands | • [disler session_start --load-context](https://github.com/disler/claude-code-hooks-mastery/blob/main/.claude/hooks/session_start.py)<br>• [chiefautism/warm-start](https://github.com/chiefautism/warm-start)<br>• [piper-plus](https://github.com/ayutaz/piper-plus/blob/HEAD/.claude/settings.json) (`$CLAUDE_ENV_FILE` plus branch, HEAD, dirty)<br>• [VS Code "Add project context"](https://code.visualstudio.com/docs/agent-customization/hooks#_local-hook-examples)<br>• [Gemini "git history" example](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md)<br>• hookstack "Load Git context at startup" ([site](https://www.hookstack.app/)) | **Very common.** 13+ collections; ≈6.8k settings files mention `git status`. Context cost is covered in [`hooks-session-bloat.md`](hooks-session-bloat.md). | P2 (Windsurf: none) |
| **Re-inject rules after compaction** | SessionStart(matcher `compact`); PostCompact | Puts conventions or AGENTS.md back after auto-compaction | • [Anthropic hooks guide "Re-inject context after compaction"](https://code.claude.com/docs/en/hooks-guide.md)<br>• [Dicklesworthstone/post_compact_reminder](https://github.com/Dicklesworthstone/post_compact_reminder)<br>• [obra/superpowers](https://github.com/obra/superpowers/blob/main/hooks/hooks.json) (`startup\|clear\|compact`) | **Common.** Demand: PostCompact request at +48 ([claude-code#14258](https://github.com/anthropics/claude-code/issues/14258)); Codex compact SessionStart bug at +19 ([codex#28736](https://github.com/openai/codex/issues/28736)). | P3 |
| **AGENTS.md / rules loader** | SessionStart; per-directory on PreToolUse(Read) | Loads AGENTS.md (or per-directory READMEs and rules) for agents that read CLAUDE.md only | • [claude-code-templates agents-md-loader](https://github.com/davila7/claude-code-templates/blob/main/cli-tool/components/hooks/automation/agents-md-loader.json)<br>• [oh-my-openagent directoryAgentsInjector](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/hooks/AGENTS.md)<br>• [Anthropic `agents-md` mod](https://github.com/anthropics/claude-code/blob/main/mods/README.md) | **Common** in collections | P2 |
| **Skill / tool activation and prompt routing** | UserPromptSubmit | Matches the prompt against rules and injects "use skill X" | • [diet103/claude-code-infrastructure-showcase](https://github.com/diet103/claude-code-infrastructure-showcase/blob/main/.claude/hooks/skill-activation-prompt.ts) (10,030★)<br>• [blencorp/claude-code-kit](https://github.com/blencorp/claude-code-kit)<br>• [Continuous-Claude skill-activation-prompt](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/src/skill-activation-prompt.ts)<br>• vendor routers (CrowdStrike, Databricks, Snowflake in the [official marketplace](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json)) | **Common.** 8 collections. | P2 |
| **Prompt improvement / rewriting** | UserPromptSubmit | Adds clarifying constraints, rewrites vague prompts, translates to English, describes pasted images for text-only models | • [severity1/claude-code-prompt-improver](https://github.com/severity1/claude-code-prompt-improver) (1,939★)<br>• [0-to-1-Labs prompt-optimizer](https://github.com/0-to-1-Labs/claude-code-prompt-optimizer)<br>• [AndrewK404/translate-hooks](https://github.com/AndrewK404/translate-hooks)<br>• [odebo/CC-Vision](https://github.com/odebo/CC-Vision)<br>• Demand: `updatedPrompt` for UserPromptSubmit +23 ([claude-code#27365](https://github.com/anthropics/claude-code/issues/27365)) | **Moderate** | P2 (true rewrite only on Copilot `userPromptTransformed`, Claude Mods `prompt.submit`) |
| **Ticket / issue context** | UserPromptSubmit; SessionStart | Fetches the Linear, Jira or GitHub issue and injects it | • [prime-radiant-inc/agent-plugin-linear-use](https://github.com/prime-radiant-inc/agent-plugin-linear-use)<br>• [Factory "Add context before each prompt"](https://docs.factory.com/harness/hooks#examples)<br>• hookstack "GitHub context loader" | **Rare** as a published hook (all <10★) | P2 |
| **Date/time and environment facts** | UserPromptSubmit; PreToolUse(WebSearch) | Injects the current date; appends the year to web searches; injects installed dependency versions | • [claude-code-templates update-search-year](https://github.com/davila7/claude-code-templates/blob/main/cli-tool/components/hooks/pre-tool/update-search-year.json) (uses `updatedInput`)<br>• hookstack "Current date and time injection", "Inject installed dependency versions" | **Rare** as repos; ≈1.2k settings files match `"date" "UserPromptSubmit"` | P2 |
| **Code-graph / blast-radius context** | UserPromptSubmit; PostToolUse(Edit) | Injects the graph slice relevant to the prompt; after an edit, lists the file's dependents | • [trailhq/Graft](https://github.com/trailhq/Graft/blob/main/src/claude/hooks.ts) (9.7k★)<br>• [cyrusNuevoDia/capn-hook](https://github.com/cyrusNuevoDia/capn-hook)<br>• [Continuous-Claude tldr-context-inject](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/src/tldr-context-inject.ts) | **Product category** | P2 |

### 2.4 Workflow enforcement

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Stop quality gate** | Stop (exit 2 or `decision:"block"`); Cursor `stop` + `followup_message`; Gemini `AfterAgent`; Kiro Stop | Runs lint, typecheck or tests when the agent tries to finish and blocks with the failures. Must honour `stop_hook_active`. | • [streamlit stop_check.sh](https://github.com/streamlit/streamlit/blob/HEAD/.claude/hooks/stop_check.sh)<br>• [pytorch validate-on-stop.sh](https://github.com/pytorch/pytorch/blob/HEAD/.claude/hooks/pr_review/validate-on-stop.sh)<br>• [launchdarkly/flutter-client-sdk](https://github.com/launchdarkly/flutter-client-sdk/blob/HEAD/.claude/settings.json) (900 s)<br>• [claudekit typecheck/lint/test-project](https://github.com/carlrannaberg/claudekit/blob/main/cli/hooks/typecheck-project.ts)<br>• [Anthropic agent-based Stop hook](https://code.claude.com/docs/en/hooks-guide.md) (verify tests pass)<br>• [OpenHands docs quick start](https://github.com/OpenHands/docs/blob/main/openhands/usage/customization/hooks.mdx) (Stop lint gate) | **Very common.** Stop is the third most-used event (84 per 100 PreToolUse) and is mostly a gate, not a notifier; ≈3.1k hook files check `stop_hook_active` (CS). [HN "Claude 4.7 is ignoring stop hooks", 109 pts](https://news.ycombinator.com/item?id=47895029) shows exit-code mistakes. | P2 (needs "continue" semantics; Windsurf has none) |
| **Todo / task completion gate** | Stop; OpenCode `session.idle` | Blocks stopping while TodoWrite items are incomplete; continues on idle | • [claudekit check-todos](https://github.com/carlrannaberg/claudekit/blob/main/cli/hooks/check-todos.ts)<br>• [oh-my-openagent todoContinuationEnforcer](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/hooks/AGENTS.md)<br>• swiz `stop-incomplete-tasks` | **Common** in collections | P2 |
| **Keep-going loops** (Ralph, `/goal`) | Stop | Re-feeds the original prompt until a completion token or iteration cap | • [anthropics ralph-wiggum stop-hook.sh](https://github.com/anthropics/claude-code/blob/main/plugins/ralph-wiggum/hooks/stop-hook.sh)<br>• [blader/taskmaster](https://github.com/blader/taskmaster) (525★; Codex via an expect wrapper)<br>• [andylizf/nonstop](https://github.com/andylizf/nonstop)<br>• [Amp /goal plugin](https://ampcode.com/docs/customize/plugins)<br>• [tzachbon/smart-ralph](https://github.com/tzachbon/smart-ralph) | **Common.** Claude Code now ships `/goal` natively (its Stop-hook bugs: [#58192](https://github.com/anthropics/claude-code/issues/58192), [#58558](https://github.com/anthropics/claude-code/issues/58558)). Most Ralph repos are outer bash loops, not hooks. | P2 |
| **Block-at-submit (commit / PR gate)** | PreToolUse(Bash `git commit`, `gh pr create`) | Requires a "tests passed" marker or runs checks before commit or PR, instead of blocking mid-edit | • [Shrivu Shankar's setup](https://blog.sshh.io/p/how-i-use-every-claude-code-feature) (`/tmp/agent-pre-commit-pass`; "blocking an agent mid-plan confuses or even 'frustrates' it")<br>• [webdevtodayjason pre-commit-validator](https://github.com/webdevtodayjason/claude-hooks/blob/main/hooks/pre-commit-validator.py)<br>• [fcakyon simplify guard.py](https://github.com/fcakyon/claude-codex-settings/blob/main/plugins/simplify/hooks/scripts/guard.py)<br>• [mohamedzhioua/agent-done-or-not](https://github.com/mohamedzhioua/agent-done-or-not) | **Moderate.** Notable as the practitioner-preferred alternative to block-at-write. | P1 |
| **Done-claim verification** | Stop | Checks the transcript for evidence that tests actually ran; LLM or classifier judge | • [valentynkit/jev-belay](https://github.com/valentynkit/jev-belay)<br>• [Anthropic prompt-based Stop hook](https://code.claude.com/docs/en/hooks-guide.md)<br>• [SuperClaude prompt Stop hook](https://github.com/SuperClaude-Org/SuperClaude_Framework/blob/master/plugins/superclaude/hooks/hooks.json)<br>• [security-guidance Stop diff review](https://github.com/anthropics/claude-code/blob/main/plugins/security-guidance/hooks/hooks.json) | **Moderate** | P2 |
| **Plan / spec / scope gates** | PreToolUse(Edit\|Write); Stop | Warns when editing without an approved spec; flags files changed outside the declared scope; blocks edits until a discussion phase | • [claude-code-templates plan-gate / scope-guard](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/hooks/quality-gates)<br>• [GWUDCAP/cc-sessions](https://github.com/GWUDCAP/cc-sessions) (DAIC mode)<br>• [armoriq/armorClaude](https://github.com/armoriq/armorClaude) (signed intent token per plan)<br>• [backnotprop/plannotator](https://github.com/backnotprop/plannotator) (ExitPlanMode review UI, 9.2k★) | **Niche.** A dedicated plan-mode-enforcement hook was not found (SP). Demand: Pre/PostPlanMode events +59 ([claude-code#14259](https://github.com/anthropics/claude-code/issues/14259), cited in the opportunity doc). | P1 / P3 |
| **Final-message style guards** | Stop (`last_assistant_message`) | Blocks replies in the wrong language, sycophancy, fake ETAs, cliffhangers, AI buzzwords | • [minorun365/claude-code-japanese-guard](https://github.com/minorun365/claude-code-japanese-guard)<br>• [waitdeadai/llm-dark-patterns](https://github.com/waitdeadai/llm-dark-patterns)<br>• [fcakyon humanize.py](https://github.com/fcakyon/claude-codex-settings/blob/main/plugins/humanize/hooks/scripts/humanize.py) (PreToolUse on writes, commits and Slack posts)<br>• [Talieisin/britfix](https://github.com/Talieisin/britfix) | **Niche** | P2 |

### 2.5 Notifications

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Desktop / sound when input is needed or work is done** | Notification(`permission_prompt\|idle_prompt\|elicitation_dialog`), Stop, SubagentStop | osascript, terminal-notifier, notify-send or PowerShell toasts; `afplay`/`paplay`; OSC 9/777 terminal escapes; `say` | • [Anthropic hooks guide, first example](https://code.claude.com/docs/en/hooks-guide.md)<br>• [dazuiba/CCNotify](https://github.com/dazuiba/CCNotify)<br>• [mylee04/code-notify](https://github.com/mylee04/code-notify) (Claude Code, Codex, Gemini)<br>• [soulee-dev/claude-code-notify-powershell](https://github.com/soulee-dev/claude-code-notify-powershell)<br>• [warpdotdev/claude-code-warp](https://github.com/warpdotdev/claude-code-warp) (official, OSC 777)<br>• [windmill notify-user.sh](https://github.com/windmill-labs/windmill/blob/HEAD/.claude/hooks/notify-user.sh)<br>• [ctoth/claudio](https://github.com/ctoth/claudio) (per-command sounds) | **Most-published category.** 21+ SP repos ≥10★; 13 collections. In hook scripts: osascript ≈600 files, afplay ≈260, notify-send ≈260, ntfy ≈90. Demand: idle-prompt timeout +42 ([#13922](https://github.com/anthropics/claude-code/issues/13922)); Notification not firing in VS Code +67 ([#8985](https://github.com/anthropics/claude-code/issues/8985)); 10 s delay +33 ([#5186](https://github.com/anthropics/claude-code/issues/5186)). | P3 (Notification is Claude, Factory, Copilot CLI, Kimi; elsewhere use Stop) |
| **Voice / TTS and novelty sound packs** | Stop, Notification, SubagentStop, all events | LLM-summarised spoken completion; game voice lines; elevator music while waiting | • [PeonPing/peon-ping](https://github.com/PeonPing/peon-ping) (5,066★; [HN 1,006 pts](https://news.ycombinator.com/item?id=46985151); 10 agents)<br>• [disler stop.py --notify](https://github.com/disler/claude-code-hooks-mastery/blob/main/.claude/hooks/stop.py)<br>• [paulpreibisch/AgentVibes](https://github.com/paulpreibisch/AgentVibes)<br>• [shanraisshan/claude-code-hooks](https://github.com/shanraisshan/claude-code-hooks)<br>• [Sevii elevator-music](https://github.com/Sevii/agent-marketplace/tree/main/plugins/elevator-music) ([HN 56 pts](https://news.ycombinator.com/item?id=46337118)) | **Popular** but niche in committed configs (TTS ≈930 hook files) | P3 |
| **Remote push / chat** | Notification, Stop | Slack, Discord, Telegram, ntfy, Pushover, Feishu or WeCom webhooks, often with an AI summary and escalation tiers | • [karanb192 notify-permission](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/notify-permission) (Slack)<br>• [claude-code-templates Slack/Discord/Telegram set](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/hooks/automation) (12 hooks)<br>• [777genius/agent-notifications](https://github.com/777genius/agent-notifications) (815★)<br>• [ZekerTop/ai-cli-complete-notify](https://github.com/ZekerTop/ai-cli-complete-notify)<br>• [MarioZZJ/cc-notify-hooks](https://github.com/MarioZZJ/cc-notify-hooks) (tiered escalation) | **Common** | P3 |
| **Two-way remote approval** | PermissionRequest, PreToolUse (HTTP hooks) | Approve or deny from a phone, watch, Mac notch or Telegram | • [JessyTsui/Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) (1,287★)<br>• [ghy196830-del/agent-watch-approve](https://github.com/ghy196830-del/agent-watch-approve)<br>• [nickknissen/claude-ntfy-hook](https://github.com/nickknissen/claude-ntfy-hook) (ntfy Allow/Deny buttons)<br>• [rawsun007/claude-notch](https://github.com/rawsun007/claude-notch) | **Moderate** | P3 |

### 2.6 Observability, logging and cost

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Local audit log** | all, or PreToolUse(*) / PostToolUse(*) | Appends prompts, commands and edits to JSONL, CSV or Markdown; redacts secrets | • [claude-code-templates command-logger / edit-audit-log](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/hooks/development-tools)<br>• [karanb192 session-logger](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/session-logger)<br>• [Cursor docs audit.sh](https://cursor.com/docs/hooks#examples)<br>• [Copilot gallery session-logger / governance-audit](https://github.com/github/awesome-copilot/tree/main/hooks)<br>• [Windsurf logging example](https://docs.devin.ai/desktop/cascade/hooks)<br>• [Kiro prompt logging to Loki](https://kiro.dev/docs/hooks/examples.md)<br>• [Codex Interrupt audit example](https://developers.openai.com/codex/hooks.md) | **Very common** in vendor galleries (8+) and collections (13+); `jsonl` appears in ≈6.8k hook files | P1 (observe only) |
| **Dashboards** | all events → HTTP | POSTs every event to a local server → SQLite → web UI; some add human-in-the-loop | • [disler multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) (1,544★)<br>• [simple10/agents-observe](https://github.com/simple10/agents-observe) (694★)<br>• [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor)<br>• [felipeelias/hook-lab](https://github.com/felipeelias/hook-lab) | **Common** (product category) | P1 |
| **OTel / LLM-tracing export** | Stop, SessionEnd, all | Replays transcripts into Langfuse, LangSmith or Braintrust; OTLP spans | • [o11y-dev/opentelemetry-hooks](https://github.com/o11y-dev/opentelemetry-hooks) (7 agents)<br>• [claude-code-templates langsmith-tracing](https://github.com/davila7/claude-code-templates/blob/main/cli-tool/components/hooks/monitoring/langsmith-tracing.json)<br>• langfuse / datadog / posthog plugins ([official marketplace](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json))<br>• [naoufalelh/cursor-langfuse](https://github.com/naoufalelh/cursor-langfuse) | **Common**, vendor-driven. Note that Claude Code also has native OTel ([ColeMurray/claude-code-otel](https://github.com/ColeMurray/claude-code-otel) uses it, not hooks). | P1 |
| **Cost / token tracking** | Stop, PostToolUse(Read\|Grep), SessionEnd | Per-session cost; per-file token "hogs"; cache-expiry warnings | • [karanb192 context-hogs / cache-tax / nerf-receipts](https://github.com/karanb192/claude-code-hooks)<br>• [ECC cost-tracker](https://github.com/affaan-m/ECC/blob/main/hooks/README.md)<br>• [abhiyankhanal/claude-usage-report](https://github.com/abhiyankhanal/claude-usage-report) | **Moderate.** Blocked by missing data: token/cost in hook input +33 ([#11008](https://github.com/anthropics/claude-code/issues/11008)). Most trackers read transcripts instead. | P1 |
| **Session provenance in git** | SessionStart … Stop | Links transcripts, prompts and tokens to commits; stamps PRs | • [entireio/cli](https://github.com/entireio/cli) (5,159★, 7 agents)<br>• [karanb192 pr-provenance-stamp](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/pr-provenance-stamp)<br>• [backthread/add-reasoning-to-prs](https://github.com/backthread/add-reasoning-to-prs) | **Emerging** | P1 |

### 2.7 Memory, session persistence and compaction

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Cross-session memory capture and recall** | PostToolUse(*), Stop, SessionEnd → SessionStart, UserPromptSubmit | Captures observations, compresses them with an LLM, stores them in SQLite/FTS/vectors, re-injects relevant ones | • [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem/blob/main/plugin/hooks/hooks.json) (97.7k★; Claude Code, Codex, Cursor, Windsurf, Kimi…)<br>• [coleam00/claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler)<br>• [Digital-Process-Tools/claude-remember](https://github.com/Digital-Process-Tools/claude-remember)<br>• [ECC continuous learning](https://github.com/affaan-m/ECC/blob/main/hooks/README.md)<br>• [Gemini "Smart Development Workflow"](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md) (inject-memories / consolidate)<br>• Codex use-case list: "summarize chats into persistent memories" ([docs](https://developers.openai.com/codex/hooks.md)) | **Very high-star; usually a product** | P2 |
| **PreCompact snapshot / transcript backup** | PreCompact | Copies the transcript or writes a continuity ledger before compaction | • [disler pre_compact.py --backup](https://github.com/disler/claude-code-hooks-mastery/blob/main/.claude/hooks/pre_compact.py)<br>• [Continuous-Claude pre-compact-continuity](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/src/pre-compact-continuity.ts)<br>• [m98/fluent precompact-backup.sh](https://github.com/m98/fluent/blob/HEAD/.claude/hooks/precompact-backup.sh)<br>• hookstack "Transcript backup before compaction" | **Common.** 11 collections; PreCompact is 15 per 100 PreToolUse. | P3 |
| **Steer the compaction** | PreCompact (stdout appended to the compact prompt) | Tells the summariser what to keep | • [fcakyon precompact_priorities.sh](https://github.com/fcakyon/claude-codex-settings/blob/main/plugins/intelligent-compact/hooks/scripts/precompact_priorities.sh)<br>• [ruflo PreCompact guidance](https://github.com/ruvnet/ruflo/blob/main/.claude-plugin/hooks/hooks.json) | **Niche** | P3 |
| **Task / goal pointer across compaction** | PreCompact → SessionStart(compact) | Snapshots the todo list or goal and restores it after compaction | • swiz `precompact-task-snapshot` / `postcompact-task-restore`<br>• [big0lives/codex-task-pointer](https://github.com/big0lives/codex-task-pointer) (Codex, fail-closed)<br>• [oh-my-openagent compactionTodoPreserver](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/omo-opencode/src/hooks/AGENTS.md) | **Moderate** | P3 |
| **Handoff docs** | Stop, SessionEnd, idle | Writes a handoff for the next session | • [Continuous-Claude auto-handoff-stop.py](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/auto-handoff-stop.py)<br>• [obie/auto-handoff](https://github.com/obie/auto-handoff) (mod, `turn.complete`)<br>• Demand: session handoff +26 ([#11455](https://github.com/anthropics/claude-code/issues/11455)) | **Moderate** | P1 |

### 2.8 Permission auto-approval

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Approve safe read-only / compound commands** | PreToolUse(`permissionDecision:"allow"`); PermissionRequest | Splits pipelines and `&&` chains and allows when every segment is allowlisted; denies on any denylisted segment | • [Anthropic hooks guide "Auto-approve specific permission prompts"](https://code.claude.com/docs/en/hooks-guide.md) (ExitPlanMode)<br>• [ldayton/Dippy](https://github.com/ldayton/Dippy) (AST; Claude Code, Gemini, Cursor)<br>• [oryband/claude-code-auto-approve](https://github.com/oryband/claude-code-auto-approve) (shfmt AST; archived because Claude Code now parses compound commands natively)<br>• [liberzon smart_approve.py](https://github.com/liberzon/claude-hooks/blob/main/smart_approve.py)<br>• [kornysietsma/tool-gate-hook](https://github.com/kornysietsma/tool-gate-hook) (TOML rules, Claude Code + Copilot)<br>• [Crush "auto-approve read-only tools"](https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md#examples)<br>• [railway auto-approve-api.sh](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json) | **Moderate as published tools (~9 SP, 7 COL); absent from committed project configs (0/108, CS).** Pitfalls: `ask` silently auto-approved under bypass/auto modes ([#51255](https://github.com/anthropics/claude-code/issues/51255), [#77212](https://github.com/anthropics/claude-code/issues/77212)). | P2 (Augment and Windsurf can't allow) |
| **LLM / classifier judge** | PermissionRequest; PreToolUse | Haiku, Opus or Ollama evaluates the request against project policy | • [ahmed-anas/claude-gatekeeper](https://github.com/ahmed-anas/claude-gatekeeper)<br>• [yifanzz/claude-code-boost](https://github.com/yifanzz/claude-code-boost)<br>• [leepokai/jev-guard](https://github.com/leepokai/jev-guard)<br>• [claude-code-templates ai-bash-guard](https://github.com/davila7/claude-code-templates/blob/main/cli-tool/components/hooks/security/ai-bash-guard.json) | **Niche.** A counter-camp brands itself "deterministic, not LLM judges" ([nah](https://github.com/manuelschipper/nah), [aigis](https://github.com/killertcell428/aigis)). | P2 |

### 2.9 Tool redirection and token-saving rewrites

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Command redirect** (grep→rg, find→fd, npm→pnpm/bun, pip→uv, cat→Read) | PreToolUse(Bash): deny with a reason, or `updatedInput` | Steers to the project's toolchain | • **Anthropic's own reference example** [bash_command_validator_example.py](https://github.com/anthropics/claude-code/blob/main/examples/hooks/bash_command_validator_example.py) (grep→rg)<br>• [plankton enforce_package_managers.sh](https://github.com/alexfazio/plankton/blob/HEAD/.claude/hooks/enforce_package_managers.sh)<br>• [walkthru-earth enforce-pnpm.sh](https://github.com/walkthru-earth/geocoding-playground/blob/HEAD/.claude/hooks/enforce-pnpm.sh)<br>• [boxabirds bundler-standard.ts](https://github.com/boxabirds/awesome-hooks/blob/main/README.md) (npm→bun)<br>• [justinstimatze/weir](https://github.com/justinstimatze/weir) ("grep 4,575 times and rg zero times across 25,216 Bash calls")<br>• swiz `banned-commands`, `no-npm`<br>• hookstack "Enforce uv for Python deps"<br>• [Cline ModifyInput example](https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md) (adds `--save-exact`) | **Common inline, rarely published.** Every standalone redirect repo has <10★. pnpm appears in ≈4.9k hook files, but "use pnpm" in only ≈90. | P1 (deny + reason) / P2 (rewrite) |
| **Output-compressing rewriters** | PreToolUse(Bash) `updatedInput` → wrapper binary; PostToolUse output filter | Rewrites `git status` to `rtk git status` etc. to shrink output | • [rtk-ai/rtk](https://github.com/rtk-ai/rtk/blob/develop/hooks/claude/rtk-rewrite.sh) (82.6k★, 13 agent targets)<br>• [zdk/lowfat](https://github.com/zdk/lowfat) ([HN 156 pts](https://news.ycombinator.com/item?id=48409955))<br>• [edouard-claude/snip](https://github.com/edouard-claude/snip)<br>• [claudioemmanuel/squeez](https://github.com/claudioemmanuel/squeez)<br>• [mksglu/context-mode](https://github.com/mksglu/context-mode) (25.6k★)<br>• [Crush rtk example](https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md#examples) | **Very high-star but contested**: [Quesma benchmark](https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/) (≈±5% cost, pass rate −1–2 pts; [HN 170 pts](https://news.ycombinator.com/item?id=49656471)); [mroczek critique](https://mroczek.dev/articles/the-token-compression-illusion-why-im-skeptical-of-rtk/) | P2 |
| **Tool substitution** | PreToolUse(WebFetch\|WebSearch\|Read\|Grep) | Redirects WebFetch to Tavily, Grep to ast-grep or semantic search, duplicate Reads to "already seen" | • [fcakyon tavily-tools](https://github.com/fcakyon/claude-codex-settings/tree/main/plugins/tavily-tools)<br>• [Continuous-Claude smart-search-router](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/src/smart-search-router.ts)<br>• [Cyvid7-Darus10/claude-savings](https://github.com/Cyvid7-Darus10/claude-savings) | **Niche** | P1 |

### 2.10 Commit and branch hygiene

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Conventional-commit / message policy** | PreToolUse(Bash `git commit`) | Validates format and allowed types; keeps chat corrections out of messages; strips or blocks AI attribution trailers | • [claude-code-templates conventional-commits](https://github.com/davila7/claude-code-templates/blob/main/cli-tool/components/hooks/git/conventional-commits.json)<br>• [fcakyon block_ai_attribution.py / block_commit_type.py](https://github.com/fcakyon/claude-codex-settings/tree/main/plugins/github-dev/hooks/scripts)<br>• [webdevtodayjason validate-git-commit.py](https://github.com/webdevtodayjason/claude-hooks/blob/main/hooks/validate-git-commit.py)<br>• [ChufanS008/ship-the-result](https://github.com/ChufanS008/ship-the-result)<br>• [Kiro commit-message hook](https://github.com/Sceptre/sceptre/blob/HEAD/.kiro/hooks/commit-message.kiro.hook) | **Moderate.** 6 collections. | P1 |
| **Auto-stage / auto-commit / checkpoint** | PostToolUse(Edit\|Write), Stop, SessionEnd | `git add` each edited file; checkpoint before edits; commit per turn on a per-session branch | • [karanb192 auto-stage](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/auto-stage)<br>• [claudekit create-checkpoint](https://github.com/carlrannaberg/claudekit/blob/main/cli/hooks/create-checkpoint.ts)<br>• [gitbutlerapp/claude plugin](https://github.com/gitbutlerapp/claude/blob/main/plugins/gitbutler/hooks/hooks.json) (per-session branches; [Cursor variant blog](https://blog.gitbutler.com/cursor-hooks-deep-dive))<br>• [Copilot gallery session-auto-commit](https://github.com/github/awesome-copilot/tree/main/hooks)<br>• [Ixe1 checkpointing-hook](https://github.com/Ixe1/claude-code-checkpointing-hook) | **Moderate.** Partly superseded by native `/rewind` checkpoints. | P1 |

### 2.11 Documentation sync

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Keep docs, CLAUDE.md or translations in sync** | PostToolUse(Write); Stop; Kiro `PostFileSave` (agent action) | Reminds or forces README, API-doc or CLAUDE.md updates; syncs i18n files; mirrors notes to Obsidian | • [Kiro i18n helper / Sync API Docs](https://kiro.dev/docs/hooks/examples.md)<br>• [severity1/claude-code-auto-memory](https://github.com/severity1/claude-code-auto-memory)<br>• [webdevtodayjason readme-update-validator](https://github.com/webdevtodayjason/claude-hooks/blob/main/hooks/readme-update-validator.py)<br>• [sentioxyz/typemove agent Stop hook updating CLAUDE.md](https://github.com/sentioxyz/typemove/blob/HEAD/.claude/settings.json)<br>• Kiro `fileEdited` locale sync ([vinhnx/vtchat](https://github.com/vinhnx/vtchat)) | **Rare** in Claude configs (10/304 entries), but **Kiro's signature automatic pattern** (CS). No changelog-on-commit hook ≥10★ found. | P2 |

### 2.12 Security scanning and policy engines

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **SAST / secret / dependency scan on edit or stop** | PostToolUse(Edit\|Write), Stop, `afterFileEdit` | Runs semgrep, sonar, gitleaks, osv or snyk on changed files | • Semgrep plugin ([official marketplace](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json); [Cursor partner](https://cursor.com/blog/hooks-partners))<br>• [security-guidance regex warnings + Stop review](https://github.com/anthropics/claude-code/blob/main/plugins/security-guidance/hooks/security_reminder_hook.py)<br>• [merciagents/riphook](https://github.com/merciagents/riphook)<br>• [smixs/code-quality](https://github.com/smixs/code-quality)<br>• [Codex MCP-scanner example](https://developers.openai.com/codex/hooks.md)<br>• [Copilot dependency-license-checker](https://github.com/github/awesome-copilot/tree/main/hooks) | **Moderate, vendor-driven.** semgrep appears in only ≈110 hook files. | P1/P2 |
| **Central policy engines** | all pre-tool events, forwarded | Evaluate OPA/Rego, Cedar or YARA policies in a daemon; allow, deny, ask or redact | • [eqtylab/cupcake](https://github.com/eqtylab/cupcake) (Rego→WASM)<br>• [sondera-ai/sondera-coding-agent-hooks](https://github.com/sondera-ai/sondera-coding-agent-hooks) (Cedar, about 120 policies, fail-closed)<br>• [FailproofAI/failproofai](https://github.com/FailproofAI/failproofai) (40 policies)<br>• [killertcell428/aigis](https://github.com/killertcell428/aigis)<br>• [hookify rule engine](https://github.com/anthropics/claude-code/tree/main/plugins/hookify) (Markdown/YAML rules, warn or block) | **Moderate.** These are frameworks, not hooks. | P1 |
| **Scanning hooks themselves** | — (pre-clone scanner) | Detects poisoned `.claude/` hooks: `curl\|bash`, base64 exec, reverse shells | • [Pantheon-Security/medusa](https://github.com/Pantheon-Security/medusa) (1,001★, AGPL)<br>• [ryo-ebata/cc-audit](https://github.com/ryo-ebata/cc-audit) | **Niche**; hooks as an attack surface | not applicable |

### 2.13 Multi-agent coordination and worktrees

| Pattern | Event(s) | What it does | Examples | Commonness | Port. |
|---|---|---|---|---|---|
| **Worktree environment setup** | WorktreeCreate/Remove; Windsurf `post_setup_worktree` | Copies `.env`, installs dependencies, assigns ports, uses APFS clones | • [tfriedel/claude-worktree-hooks](https://github.com/tfriedel/claude-worktree-hooks)<br>• [palmin/claude-cow-worktree](https://github.com/palmin/claude-cow-worktree)<br>• [Windsurf "Setting up worktrees" example](https://docs.devin.ai/desktop/cascade/hooks)<br>• Demand: PostWorktreeCreate +29 ([#27744](https://github.com/anthropics/claude-code/issues/27744)) | **Moderate demand, few implementations** | P3 |
| **File claims / locks, inboxes** | PreToolUse(Edit), SessionStart, Stop | Advisory per-file leases; checks peer messages; detects concurrent-session edits | • [Continuous-Claude file-claims](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/src/file-claims.ts)<br>• [Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) (2,193★)<br>• [aannoo/hcom](https://github.com/aannoo/hcom) (5 agents)<br>• [sezeryavuz/parallel-sessions](https://github.com/sezeryavuz/parallel-sessions) | **Niche** | P2 |
| **Subagent governance** | PreToolUse(Agent\|Task), SubagentStart | Spawn budgets; inject context into subagents; pin subagent models | • [karanb192 subagent-spawn-cap](https://github.com/karanb192/claude-code-hooks/tree/main/plugins/subagent-spawn-cap)<br>• [Continuous-Claude tldr-context-inject](https://github.com/parcadei/Continuous-Claude-v3/blob/main/.claude/hooks/src/tldr-context-inject.ts)<br>• [Temikus/claude-watchdog](https://github.com/Temikus/claude-watchdog) | **Niche** | P3 |
| **Cross-model review** | PostToolUse(plan write), Stop | Has Codex review Claude's plan or diff | • [cathrynlavery/codex-skill](https://github.com/cathrynlavery/codex-skill)<br>• [postgigg/viper-2.0](https://github.com/postgigg/viper-2.0) (`asyncRewake`) | **Niche** | P2 |

### 2.14 Other patterns discovered

| Pattern | Examples | Notes |
|---|---|---|
| **Environment reload (direnv)** on CwdChanged/FileChanged | • [Anthropic hooks guide](https://code.claude.com/docs/en/hooks-guide.md)<br>• hookstack "Reload direnv", "Reload .env on file change" | Claude-only events |
| **Dev server must run in tmux** | • [ECC dev-server blocker](https://github.com/affaan-m/ECC/blob/main/hooks/README.md)<br>• [rohitg00 block-dev-server](https://github.com/rohitg00/awesome-claude-code-toolkit/blob/main/hooks/hooks.json) | Stops the agent blocking on long-running processes |
| **Model routing** | • [coyvalyss1/model-matchmaker](https://github.com/coyvalyss1/model-matchmaker)<br>• [tzachbon/claude-model-router-hook](https://github.com/tzachbon/claude-model-router-hook) | Claude Mods `turn.step` now does this natively |
| **Prompt-cache keepalive** | • [yujiachen-y/claude-code-cache-keepalive](https://github.com/yujiachen-y/claude-code-cache-keepalive) | A Stop-block hack |
| **Windows shell-dialect fixer** | • [waseemnasir2k26/claude-code-pwsh-guard](https://github.com/waseemnasir2k26/claude-code-pwsh-guard) | Uses `updatedInput` |
| **Encoding / mojibake repair** | • [haodehaode378/text-encoding-guard](https://github.com/haodehaode378/text-encoding-guard) | |
| **Rules → hooks generators** | • [zxdxjtu/claudecode-rule2hook](https://github.com/zxdxjtu/claudecode-rule2hook) (402★)<br>• [hookify `/hookify`](https://github.com/anthropics/claude-code/tree/main/plugins/hookify) | An LLM writes the hook |
| **Domain-specific gates** | • DoorDash allergy/spend gates ([claude-code-templates](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/hooks/doordash))<br>• [Rootly "active incident" deploy warning](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json)<br>• [Cursor k8s manifest guard](https://cursor.com/docs/hooks#examples) | Shows hooks used as business guardrails, not just dev tooling |
| **Skill bootstrap** | • [obra/superpowers](https://github.com/obra/superpowers/blob/main/hooks/session-start) (296k★, one SessionStart hook) | The most-starred repo shipping a hook |

---

## 3. Popular repos and collections

Stars, license and last push are from `gh api repos/…` on **2026-10-07**. In the "Borrow?" column:
- **yes**: OSI-permissive (MIT or Apache-2.0); attribute.
- **ideas only**: no license, non-commercial, or restrictive.

| Repo | ★ | Lang | Agents | What's in it | License | Borrow? |
|---|---:|---|---|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | 296,379 | Shell | Claude Code, Cursor, others | 1 SessionStart skill-bootstrap hook | MIT | yes |
| [mattpocock/skills](https://github.com/mattpocock/skills) | 279,533 | Shell | Claude Code (Codex manifest) | Skills; `git-guardrails-claude-code` installs a PreToolUse git guard | MIT | yes |
| [affaan-m/ECC](https://github.com/affaan-m/ECC) (ex everything-claude-code) | 274,917 | JS | Claude Code, Codex, OpenCode | About 25 profile-gated hooks: dev-server-in-tmux, pre-commit checks, config-protection, cost tracker, continuous learning | MIT | yes |
| [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | 110,407 | Go | 9 agents | SessionStart/UserPromptSubmit injection of a terse-output mode (mostly a skill) | Apache-2.0 | yes |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 97,686 | TS | Claude Code, Codex, Cursor, Windsurf, Antigravity, Kimi | Memory capture/recall hooks on 9 events | Apache-2.0 | yes |
| [rtk-ai/rtk](https://github.com/rtk-ai/rtk) | 82,638 | Rust | 13 targets | PreToolUse(Bash) `updatedInput` rewrite to an output-filtering wrapper | Apache-2.0 | yes |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | 37,504 | Python | Claude Code | Official marketplace: 315 plugins, ≥61 ship hooks (Semgrep, Endor Labs, Langfuse, Vercel, Stripe, Rootly…) | Apache-2.0 (repo; external plugins vary) | per plugin |
| [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates) | 32,458 | Python | Claude Code | 62 hook components in 12 categories; `npx claude-code-templates --hook` | MIT | yes |
| [mksglu/context-mode](https://github.com/mksglu/context-mode) | 25,620 | TS | 10 agents | Output sandboxing, PreCompact snapshot, per-host capability notes | NOASSERTION | check |
| [diet103/claude-code-infrastructure-showcase](https://github.com/diet103/claude-code-infrastructure-showcase) | 10,030 | TS | Claude Code, Codex | Skill-activation UserPromptSubmit, tsc and build checks | MIT | yes |
| [trailhq/Graft](https://github.com/trailhq/Graft) | 9,700 | TS | Claude Code, Codex, Cursor (+) | Code-graph context, blast-radius on PostToolUse | MIT | yes |
| [backnotprop/plannotator](https://github.com/backnotprop/plannotator) | 9,199 | TS | multi | ExitPlanMode interception for plan review | Apache-2.0 | yes |
| [Dicklesworthstone/destructive_command_guard](https://github.com/Dicklesworthstone/destructive_command_guard) | 6,106 | Rust | about 18 | Destructive-command guard, 115 packs | **MIT + rider**: "no rights are granted to" OpenAI, Anthropic or affiliates, and bars use in ML pipelines ([LICENSE](https://github.com/Dicklesworthstone/destructive_command_guard/blob/main/LICENSE)) | **ideas only** |
| [FailproofAI/failproofai](https://github.com/FailproofAI/failproofai) | 5,254 | TS | 9 agents | Observability plus 40 enforcement policies | NOASSERTION | check |
| [entireio/cli](https://github.com/entireio/cli) | 5,159 | Go | 7 agents | Session-to-commit provenance via hooks | MIT | yes |
| [PeonPing/peon-ping](https://github.com/PeonPing/peon-ping) | 5,066 | Shell | 10 agents | Voice and sound notifications | MIT | yes |
| [parcadei/Continuous-Claude-v3](https://github.com/parcadei/Continuous-Claude-v3) | 3,940 | Python/TS | Claude Code | About 35 context/continuity hooks | MIT | yes |
| [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery) | 3,930 | Python | Claude Code | One `uv` script per event; rm-rf/.env guard, TTS, ruff/ty validators | **none** | **ideas only** |
| [nizos/tdd-guard](https://github.com/nizos/tdd-guard) | 2,358 | TS | Claude Code (→ probity: + Codex, Copilot) | TDD enforcement plus test reporters | MIT | yes |
| [Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | 2,193 | Python | 8 agents | Inbox and file-lease hooks | NOASSERTION | check |
| [severity1/claude-code-prompt-improver](https://github.com/severity1/claude-code-prompt-improver) | 1,939 | Python | Claude Code | UserPromptSubmit nudges | MIT | yes |
| [kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net) | 1,582 | TS | about 17 CLIs | Semantic destructive-command and secret guard with per-host adapters | MIT | yes |
| [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | 1,544 | Python | Claude Code | All-event dashboard | none | ideas only |
| [JessyTsui/Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) | 1,287 | JS | Claude Code | Two-way remote notifications | MIT | yes |
| [fcakyon/claude-codex-settings](https://github.com/fcakyon/claude-codex-settings) | 1,165 | Python | Claude Code, Codex, Cursor, Gemini | About 19 hook scripts: attribution blocker, force-push, formatting, Tavily redirect, compaction priorities | Apache-2.0 | yes |
| [Pantheon-Security/medusa](https://github.com/Pantheon-Security/medusa) | 1,001 | Python | scanner | Detects malicious hooks | AGPL-3.0 | ideas only |
| [777genius/agent-notifications](https://github.com/777genius/agent-notifications) | 815 | Go | 4 agents | Notifications and webhooks | NOASSERTION | check |
| [carlrannaberg/claudekit](https://github.com/carlrannaberg/claudekit) | 765 | TS | Claude Code | 17 hooks: typecheck, lint, file-guard, check-todos, self-review, checkpoint, thinking-level | MIT | yes |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | 55,208 | (list) | Claude Code | Curated list; **dropped its Hooks category** in July 2026 (last version with it: [THE_RESOURCES_TABLE.csv @ 2d32d46](https://github.com/hesreallyhim/awesome-claude-code/blob/2d32d46e5e946799bff436210d641eca1153ff63/THE_RESOURCES_TABLE.csv), 13 entries) | Other | not applicable |
| [karanb192/claude-code-hooks](https://github.com/karanb192/claude-code-hooks) | 533 | JS | Claude Code | 22-plugin marketplace: guard-pack (7 guards), format, notify, logging, cost and provenance | MIT | yes |
| [manuelschipper/nah](https://github.com/manuelschipper/nah) | 487 | Rust | 10 agents | Deterministic action-type permission guard | MIT | yes |
| [johnlindquist/claude-hooks](https://github.com/johnlindquist/claude-hooks) | 396 | TS | Claude Code | Typed TS scaffolder (`npx claude-hooks`) | MIT | yes |
| [alexfazio/plankton](https://github.com/alexfazio/plankton) | 371 | Shell | Claude Code | Write-time multi-linter, linter-config protection, package-manager enforcement | MIT | yes |
| [eqtylab/cupcake](https://github.com/eqtylab/cupcake) | 296 | Rust | 5 agents | OPA/Rego policy engine | Apache-2.0 | yes |
| [lasso-security/claude-hooks](https://github.com/lasso-security/claude-hooks) | 267 | TS/Py | Claude Code | Prompt-injection defender with `patterns.yaml` | MIT | yes |
| [ldayton/Dippy](https://github.com/ldayton/Dippy) | 243 | Python | Claude Code, Gemini, Cursor | AST-based safe-bash auto-approve | MIT | yes |
| [sondera-ai/sondera-coding-agent-hooks](https://github.com/sondera-ai/sondera-coding-agent-hooks) | 228 | Rust | about 10 | Cedar reference monitor, about 120 policies | MIT | yes |
| [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | 69,875 | TS | OpenCode, Codex | About 54 OpenCode plus 21 Codex hooks, incl. running Claude Code hooks inside OpenCode | **Sustainable Use License** | ideas only |
| [mherod/swiz](https://github.com/mherod/swiz) | 0 (API) | TS | Claude Code, Cursor, Gemini, Codex, Antigravity | **169 hooks**, the largest catalogue; 29 Stop gates | **PolyForm Noncommercial** | ideas only |
| [hookstack.app](https://www.hookstack.app/) / [steve-magne/hookstack](https://github.com/steve-magne/hookstack) | 7 | JS | Claude Code, Copilot, Codex | 106-hook registry and installer | MIT | yes |
| [github/awesome-copilot `hooks/`](https://github.com/github/awesome-copilot/tree/main/hooks) | (repo) | Shell | Copilot | 8 official examples | MIT ([repo](https://github.com/github/awesome-copilot)) | yes |
| [anthropics/claude-code `plugins/` + `examples/hooks`](https://github.com/anthropics/claude-code/tree/main/plugins) | 149,768 | — | Claude Code | hookify, security-guidance, ralph-wiggum, output styles, bash validator example | none listed by API | ideas only (check per file) |

**Non-Claude collections are thin.** Kiro, Windsurf, Cline and Copilot have no sizeable community hook collection; the largest have 0–4★, e.g. [mikeartee/kiro-hooks-docs](https://github.com/mikeartee/kiro-hooks-docs). They are reached through multi-agent tools: cc-safety-net, rtk, claude-mem, sondera, peon-ping and [1Password/agent-hooks](https://github.com/1Password/agent-hooks).

**Typed SDKs** are listed in [`hooks-tool-opportunity.md`](hooks-tool-opportunity.md) Table B.

---

## 4. Implementation conventions observed

### 4.1 Languages and runners

**Script files.** Code-search counts of files under `.claude/hooks/`:

| Extension | Files |
|---|---:|
| `.sh` | 44.7k |
| `.py` | 18.8k |
| `.mjs` | 5.1k |
| `.js` | 4.9k |
| `.cjs` | 2.5k |
| `.ts` | 2.0k |
| `.ps1` | 1.9k |
| `.go` | 53 |

**Runners named in `settings.json`:**

| Runner | Files |
|---|---:|
| `node` | 7.4k |
| `python3` | 5.4k |
| `npx` | 4.9k |
| `jq` | 4.5k |
| `bun` | 2.1k |
| `uv run` | 1.5k |

**Notes:**
- PEP 723 single-file `uv run --script` (the disler style) appears in only ≈0.9k hook files.
- PowerShell appears in ≈2.3k settings files, from Windows users.
- 2026-era multi-agent tools increasingly ship **one native binary with a `hook <agent>` subcommand**: rtk moved to `rtk hook claude` in v0.37.2 for Windows support (https://github.com/rtk-ai/rtk), as did dcg, nah, snip and squeez. The aim is to avoid interpreter dependencies and startup latency.

### 4.2 Reading input and returning decisions

- **Input parsing.** `jq -r '.tool_input.file_path // empty'` / `.tool_input.command` is the de facto bash idiom; `jq` appears in ≈20.9k `.sh` hook files.
- **Project paths.** `$CLAUDE_PROJECT_DIR` is in 45% of sampled commands. The alternatives are `$(git rev-parse --show-toplevel)`, common in Codex and Copilot configs, and relative paths. Hard-coded `/Users/...` paths appear in about 3% of commands.
- **Blocking.** Both styles are common:
  - Exit 2 + stderr: `exit 2` is very common in bash; `sys.exit(2)` ≈2.1k files; `process.exit(2)` ≈2.0k.
  - JSON: `permissionDecision` ≈7.2k files; `"decision": "block"` ≈1.4k.
  - `additionalContext` ≈8.4k files; `systemMessage` ≈3.1k.
  - **`updatedInput` is rare** (≈0.4k), and rtk is the main user.
- **Matchers** (137 handler groups sampled): `Edit|Write` variants 59, `Bash` 32, none/`*` 15. Codex configs use anchored regexes (`^(Edit|Write|apply_patch)$`). Gemini uses its own tool names (`run_shell_command`, `write_file`), and its timeouts are in ms where Claude's are in seconds.
- **Timeouts and async.** 42% of sampled handlers set `timeout`: 5–30 s for guards and formatters, 60–900 s for Stop gates. Only 8% are `async`, mostly logging and notifications.
- **Handler types.** Almost all are `command`. `prompt` appears in ≈300 settings files, `agent` in ≈200, `http` in ≈200 (CS).

### 4.3 Packaging and distribution

| Mode | Examples | Notes |
|---|---|---|
| Copy-paste inline JSON / scripts | Most committed configs; blog recipes ([AI Architects "9 production hooks"](https://theaiarchitects.com/blog/claude-code-hooks), [web-developpeur](https://www.web-developpeur.com/en/blog/claude-code-hooks-exemples), [Steve Kinney](https://stevekinney.com/courses/ai-development/claude-code-hooks)) | The dominant mode |
| Claude Code plugin with `hooks/hooks.json` and `${CLAUDE_PLUGIN_ROOT}` | ≈8.3k plugin hooks.json; `CLAUDE_PLUGIN_ROOT` in ≈18.7k hooks.json files; karanb192, official marketplace | Codex sets `CLAUDE_PLUGIN_ROOT` "for compatibility" (https://developers.openai.com/codex/hooks.md); Factory translates Claude plugin layouts |
| npx / brew installers | `npx claude-code-templates --hook`, `npx hookstack-cli`, `npx claude-hooks`, cc-safety-net, code-notify via Homebrew | Installers write settings files per agent |
| Single binary plus `init` per agent | rtk `rtk init` (13 targets), dcg, nah, snip, entire | The cross-agent default in 2026 |
| Skill that installs a hook | [mattpocock git-guardrails skill](https://github.com/mattpocock/skills/tree/main/skills/misc/git-guardrails-claude-code); the `git-guardrails-claude-code` skill in this user's environment | Uses the agent to write the config |
| Rule-file engines (no code per hook) | [hookify](https://github.com/anthropics/claude-code/tree/main/plugins/hookify) Markdown rules; [Kiro JSON](https://kiro.dev/docs/hooks/); cupcake Rego; sondera Cedar; tool-gate-hook TOML; decider hierarchical `.claude-hooks.json` | Lets users add patterns without writing scripts |
| Claude Mods (function hooks) | [awesome-claude-code-mods](https://github.com/karanb192/awesome-claude-code-mods) (2,690); [obie/auto-handoff](https://github.com/obie/auto-handoff) | New surface since 2026-10-01; Claude-only |

### 4.4 Configuration and fail-mode patterns

- **Presets or levels.** karanb192 block-dangerous-commands has three levels; cc-safety-net has Standard/Strict/Paranoid; ECC profiles are minimal/standard/strict.
- **Env opt-outs.** `OPENBOOT_SKIP_STOP_HOOK`, `HOOK_SKIP_PM`, and a `.claude/stop-loop.disabled` file (CS); claudekit adds `/hook disable` per session.
- **Fail mode is now declared in READMEs** (SP):
  - Fail-open: notification, observability and lint hooks (kaiser-data Langfuse: "Truly fail-open").
  - Fail-closed: security engines (sondera, armorClaude, difflabai, codex-task-pointer).
  - Configurable: JeongJaeSoon/agent-guard `AGENT_GUARD_INFRA_FAILURE_MODE`, secretgate.
- **Fail mode varies by agent:**
  - Copilot's command preToolUse fails closed on any non-zero exit, so [tool-gate-hook](https://github.com/kornysietsma/tool-gate-hook) "always exits 0".
  - Kimi is fail-open by design.
  - Claude Code 2.1.288 made match failures block.
- **Dispatcher pattern.** One entry point per event with `--agent claude|codex|gemini` (kupzed adapter.mjs, X-School `core/bin/hook`, cam-douglas `policy.mjs`). This is how teams share one script set across agents, e.g. [actualbudget](https://github.com/actualbudget/actual/blob/HEAD/.codex/config.toml) shares `git-guard.sh` across Claude Code, Cursor and Codex.

### 4.5 Testing, and the bugs that untested hooks ship

**Testing in the wild is thin:**
- tillmeier/claude-code-guardrails has 35 bats tests ([repo](https://github.com/tillmeier/claude-code-guardrails)).
- ship-the-result runs 59 fixtures ([repo](https://github.com/ChufanS008/ship-the-result)).
- Anthropic's plugin-dev `test-hook.sh` ([examples](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/hook-development/examples)) has open bugs: it "never evaluates the matcher" ([#83801](https://github.com/anthropics/claude-code/issues/83801)) and fails without jq ([#83802](https://github.com/anthropics/claude-code/issues/83802)).
- Replay and dashboards: hook-lab, swiz `--replay` (see opportunity doc).

**Common defects in committed configs (CS):**
- **Undocumented env vars.** About 709 settings files reference `CLAUDE_TOOL_INPUT*`, 324 `$TOOL_INPUT` and 203 `CLAUDE_FILE_PATHS`. Examples: [hoangsonww](https://github.com/hoangsonww/WealthWise-Finance-Tracker/blob/HEAD/.claude/settings.json) `npx prettier --write "$CLAUDE_TOOL_INPUT_FILE_PATH"`; [Urigo](https://github.com/Urigo/accounter-fullstack/blob/HEAD/.claude/settings.json) `$FILE_PATH`. The current hooks reference defines only `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_ENV_FILE` and a few session vars, and says input "arrives on stdin" (https://code.claude.com/docs/en/hooks.md, checked 2026-10-07). These hooks almost certainly no-op silently, though I did not run them.
- **`exit 1` used as a block.** It is non-blocking ([joelmoss/proscenium](https://github.com/joelmoss/proscenium/blob/HEAD/.claude/settings.json)). The same confusion runs through the [HN stop-hooks thread](https://news.ycombinator.com/item?id=47895029).
- **Permission-rule syntax as a matcher**, e.g. `Bash(git commit:*)` ([nwiizo/cargo-coupling](https://github.com/nwiizo/cargo-coupling/blob/HEAD/.claude/settings.json)). Claude matchers match `tool_name`, so this likely never fires; filtering by arguments uses the `if` field ([hooks guide](https://code.claude.com/docs/en/hooks-guide.md)).
- **Claude matchers inside Gemini configs.** For example, `Bash\(gh pr create.*\)` ([BlackbirdWorks/gopherstack](https://github.com/BlackbirdWorks/gopherstack/blob/HEAD/.gemini/settings.json)) won't match Gemini tool names.
- **Stop loops without `stop_hook_active`.** The docs say to check it (https://code.claude.com/docs/en/hooks.md), and most quality gates do. Claude Code caps blocks at 8 ([`hooks-session-bloat.md`](hooks-session-bloat.md)).
- **False positives from naive regex.** "DESTRUCTIVE ACTION BLOCKED" fired on agent prose 4 times in one day ([#100056](https://github.com/anthropics/claude-code/issues/100056)). Several READMEs admit their denylists are bypassable (`rm -r -f` in [safe-yolo](https://github.com/mgoodric/safe-yolo)).

### 4.6 Cross-agent adapters and the gaps they report

New tools now ship per-host adapters by default: cc-safety-net `src/hosts/` (11 hosts), rtk `src/hooks/init/` (13), claude-mem (7), peon-ping (10), nah (10). The capability gaps their READMEs document:

| Agent | Gap | Reported by |
|---|---|---|
| Codex | PreToolUse rejects `additionalContext` / `updatedInput` / `ask` | [context-mode](https://github.com/mksglu/context-mode), [parallel-sessions](https://github.com/sezeryavuz/parallel-sessions), [secguard](https://github.com/random1st/secguard) (READMEs; the Codex docs list `updatedInput`, so this may be version- or surface-dependent; see Unverified) |
| Cursor | accepts `additional_context` but doesn't surface it | context-mode |
| Cursor, Windsurf, Amp | no context-adding prompt hook | [polyhook](https://github.com/polyhook/polyhook) |
| Gemini | `BeforeTool` rewrite "pending upstream" | [squeez](https://github.com/claudioemmanuel/squeez) |
| Codex | Stop blocking was once missing, so a wrapper uses `expect` | [taskmaster](https://github.com/blader/taskmaster) |
| Windsurf | exit-2 only, by design | [docs](https://docs.devin.ai/desktop/cascade/hooks) |
| Augment | deny only, by design | [docs](https://docs.augmentcode.com/cli/hooks) |

---

## 5. Gaps and recommendations

### 5.1 Gaps

1. **Correctness, not coverage, is the gap for the top patterns.**
   - Every common hook (rm-rf guard, formatter, notifier, `.env` guard) exists dozens of times, but mostly as untested regex in bash.
   - Visible defects run to thousands of committed configs (§4.5).
   - The well-engineered versions (cc-safety-net, nah, dcg, Dippy) are each one pattern, one author, and sometimes non-borrowable (dcg).
2. **The best collections are not reusable.** disler has no license; swiz is non-commercial; oh-my-openagent uses the Sustainable Use License; dcg carries an anti-Anthropic/OpenAI rider. Of the large collections, only karanb192, claude-code-templates, claudekit, ECC, fcakyon, Continuous-Claude and hookstack are MIT or Apache-licensed.
3. **No shared shell-command parser.** Each guard re-implements detection. Parsers in use: bash-parser, shfmt, tree-sitter-bash, custom semantics, regex. Bypass via `bash -c`, flag reordering and `$()` is the recurring weakness. That makes it the obvious shared core for destructive-shell, git-guard, secrets, redirect and auto-approve.
4. **Portability is half-solved.**
   - Five agents now run Claude configs (§1c).
   - Nobody ships a conformance-tested matrix of which hooks work where.
   - Notification, PreCompact, PermissionRequest and Worktree hooks don't port (P3).
   - Single-purpose hooks for Kiro, Windsurf, Cline and Copilot are nearly nonexistent outside multi-agent tools.
5. **Commonly done, rarely published.** These hooks exist inline but have no ≥10★ standalone implementation:
   - package-manager / `grep`→`rg` redirect;
   - date injection;
   - ticket context;
   - changelog sync;
   - read-before-edit;
   - plan-mode enforcement;
   - worktree env setup (only 29★ and 15★ repos, despite +29 demand in [#27744](https://github.com/anthropics/claude-code/issues/27744)).
6. **Windows is underserved.** PowerShell appears in ≈2.3k settings files, but most collections are bash + jq. Dedicated Windows notifiers exist ([soulee-dev](https://github.com/soulee-dev/claude-code-notify-powershell)), and a plugin bug report shows CRLF and path breakage ([#25711](https://github.com/anthropics/claude-code/issues/25711)).
7. **Design lessons practitioners keep relearning:**
   - Block at commit or Stop, not mid-edit ([sshh](https://blog.sshh.io/p/how-i-use-every-claude-code-feature)).
   - Keep UserPromptSubmit output short ([web-developpeur](https://www.web-developpeur.com/en/blog/claude-code-hooks-exemples); [`hooks-session-bloat.md`](hooks-session-bloat.md)).
   - Don't run per-edit test suites on subagents ([#97820](https://github.com/anthropics/claude-code/issues/97820)).
   - Guard against self-tampering (§2.1).

### 5.2 Recommended v1 starter set (ranked by evidence of demand)

The evidence key is CS = config share, COL = collections, SP = standalone repos, VG = vendor galleries, ISS = issues.

**Tier A: ship first.** Each pattern is top-5 in at least two evidence bases.

| # | Hook | Event(s) | Evidence | Port. | Notes |
|---|---|---|---|---|---|
| 1 | `format-on-edit` | PostToolUse(Edit\|Write\|MultiEdit) + Cursor/Windsurf/Copilot/Kiro equivalents | #1 in CS (53/304, 28% of repos); 10 COL; Anthropic, VS Code, Windsurf, Factory VG | P1 | Auto-detect the formatter from project config (prettier, biome, ruff, gofmt, cargo fmt…); silent on success; never block |
| 2 | `block-destructive-shell` | PreToolUse(Bash) | #2 in CS; 11 COL; 15+ SP (dcg 6.1k★, cc-safety-net 1.6k★); 10 VG | P1 | Real parser, wrapper-aware, preset levels; avoid prose false positives (#100056) |
| 3 | `git-guard` | PreToolUse(Bash) | 11 COL; ≈5k hook files; DataDog, teambit and pytorch-class repos; `--no-verify` demand (#40117) | P1 | Force push (allow `--force-with-lease`), reset/clean/checkout discard, branch -D, push/commit to protected branches, `--no-verify` |
| 4 | `protect-secrets` | PreToolUse(Read\|Edit\|Write\|Bash\|Grep); Cursor `beforeReadFile` | 10 COL; ≈18k hook files mention `.env`; Anthropic guide; 5 SP | P1 | Honour `.aiignore`/`.cursorignore`-style lists (as claudekit does); allow `.env.example` |
| 5 | `lint-typecheck-feedback` | PostToolUse | 12 COL; tsc in ≈3.2k hook files; 17 CS test/typecheck entries | P2 | Changed file only; feed back via `decision:block` / `additionalContext`, with a size cap (see bloat doc) |
| 6 | `stop-quality-gate` | Stop / SubagentStop (+ Cursor `followup_message`, Gemini `AfterAgent`, Kiro Stop) | Stop is 84/100 in CS and mostly gates; 11 COL; Anthropic agent-Stop VG; HN 109 pts | P2 | Configurable command; check `stop_hook_active`; retry cap; timeout guidance |
| 7 | `notify` | Notification(permission/idle/elicitation) + Stop | 21+ SP, 13 COL, Anthropic's first guide example; ISS +42/+67/+33 | P3 (Stop fallback elsewhere) | macOS, Linux, Windows toast; OSC 9/777; optional ntfy/Slack webhook; async |
| 8 | `session-context` | SessionStart(startup\|resume\|clear\|compact) | 13+ COL; ≈6.8k settings files mention `git status`; VS Code, Gemini, Factory VG | P2 | git branch, dirty state and recent commits, plus a configurable file list; byte budget |
| 9 | `audit-log` | all events | 13+ COL; 8+ VG (Cursor, Copilot, VS Code, Windsurf, Kiro, Codex, Goose, Crush) | P1 | JSONL with redaction; async; doubles as the replay corpus for the debugger wedge |

**Tier B: strong evidence, ship in v1.**

| # | Hook | Event(s) | Evidence | Port. | Notes |
|---|---|---|---|---|---|
| 10 | `compaction-guard` | PreCompact snapshot + SessionStart(compact) re-inject | 11 COL; Anthropic guide; ISS #14258 +48; Codex #28736 +19 | P3 | Re-inject AGENTS.md/CLAUDE.md rules and the todo list |
| 11 | `commit-gate` | PreToolUse(Bash `git commit`/`gh pr create`) | sshh practitioner pattern; 6 COL | P1 | Require fresh passing checks (marker or run); a better default than block-at-write |
| 12 | `commit-message-policy` | PreToolUse(Bash `git commit`) | 6 COL; Kiro VG | P1 | Conventional commits; configurable attribution-trailer policy (block, require or strip) |
| 13 | `protected-paths` | PreToolUse(Edit\|Write) | Anthropic guide example; frequent in CS (generated files, lockfiles) | P1 | Glob config: generated dirs, lockfiles, vendor, migrations |
| 14 | `guard-config` | PreToolUse(Edit\|Write\|Bash) + ConfigChange | 6 COL; plankton; karanb192 | P1 | Stop the agent editing hooks, settings or linter configs; pairs with #2–4 |
| 15 | `protect-tests` | PreToolUse(edits); Stop | 8 COL; karanb192, claudekit, fakegreen | P1 | No deleting or skipping tests; no new `@ts-ignore`, `eslint-disable`, `noqa` |
| 16 | `command-redirect` | PreToolUse(Bash) deny-with-reason (optional `updatedInput`) | Anthropic's reference example; 9 COL; inline everywhere but no ≥10★ standalone | P1 | Configurable map: npm→pnpm/bun, pip→uv, grep→rg, find→fd |
| 17 | `todo-gate` | Stop | claudekit, oh-my-openagent, swiz | P2 | Block while TodoWrite items are pending; could be a check inside #6 |

**Tier C: evidence present but narrower. Optional in v1 or v1.1.**

| # | Hook | Event(s) | Evidence | Port. | Notes |
|---|---|---|---|---|---|
| 18 | `safe-auto-approve` | PreToolUse allow / PermissionRequest | 7 COL, about 9 SP, Anthropic guide and Crush VG, but **0 in committed configs** | P2 | Shares the parser with #2; allowlist-only, never auto-approve on parse failure |
| 19 | `secret-scan-on-write` | PreToolUse(Write\|Edit), commit | 9 COL; Copilot and Gemini VG; Codex use-case list | P1 | gitleaks if present, else regex; complements #4 |
| 20 | `prompt-injection-flag` | PostToolUse(WebFetch\|Read\|Bash) | 4 COL; lasso 267★; vendor partner demand | P2 | Warn-only by default |
| 21 | `worktree-setup` | WorktreeCreate / Windsurf `post_setup_worktree` | ISS #27744 +29; Windsurf VG; only 2 small SP | P3 | Copy `.env`, install deps, assign ports |
| 22 | `dependency-guard` | PreToolUse(Bash install) | Copilot VG; decider; Endor Labs partner | P1 | Block non-existent, very new or denylisted packages |

**Leave to products, not the library.** Memory (claude-mem), token-rewriting (rtk, whose benefit is contested), dashboards, TTS sound packs and LLM-judge permission gates are well served or contested, and are heavier than a hook library should own. Keep-going loops are now native in Claude Code (`/goal`).

### 5.3 How the library should be built (from observed conventions)

- **Protocol.** Author once against Claude Code's protocol; that runs unchanged on Copilot CLI, Cursor, Devin CLI and `cn` (§1c). Ship thin adapters for:
  - Codex (anchored matchers, `apply_patch` payloads);
  - Gemini (tool names; timeouts in ms);
  - Windsurf (exit-2 only);
  - Cline (per-event executables);
  - Kiro v1 JSON;
  - OpenCode/Amp (TS plugin shims).
- **Fail mode.** Declare it per hook: guards fail closed, everything else fails open. State it in docs, as practitioners now expect (§4.4).
- **Tests.** Every hook gets fixtures (captured payloads per agent) and a test runner that asserts decision and output. This addresses the defects in §4.5 and is the test-harness wedge from [`hooks-tool-opportunity.md`](hooks-tool-opportunity.md).
- **Code reuse.** Borrow only from MIT or Apache sources (§3). Treat dcg, disler, swiz and oh-my-openagent as design references only.

---

## Sources (fetched 2026-10-07 unless noted)

- **Official docs:**
  - Claude Code: https://code.claude.com/docs/en/hooks.md ; https://code.claude.com/docs/en/hooks-guide.md ; https://code.claude.com/docs/en/plugins/mods/reference.md ; https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
  - GitHub Copilot: https://docs.github.com/en/copilot/reference/hooks-reference ; https://github.com/github/awesome-copilot/tree/main/hooks
  - VS Code: https://code.visualstudio.com/docs/agent-customization/hooks
  - Windsurf/Devin: https://docs.devin.ai/desktop/cascade/hooks ; https://docs.devin.ai/cli/extensibility/hooks/overview.md
  - Cline: https://github.com/cline/cline/blob/main/.clinerules/hooks/README.md ; https://docs.cline.bot/sdk/plugins.md
  - Kiro: https://kiro.dev/docs/hooks/
  - Amp: https://ampcode.com/docs/plugin-api
  - Augment: https://docs.augmentcode.com/cli/hooks
  - Factory: https://docs.factory.com/harness/hooks
  - Qwen Code: https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md
  - Kimi Code: https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md
  - Antigravity: https://antigravity.google/docs/hooks
  - Junie: https://junie.jetbrains.com/docs/junie-cli-hooks.html
  - OpenHands: https://github.com/OpenHands/docs/blob/main/openhands/usage/customization/hooks.mdx
  - Goose: https://github.com/block/goose/blob/main/documentation/docs/guides/context-engineering/hooks.md
  - Crush: https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md
  - Cursor: https://cursor.com/docs/hooks ; https://cursor.com/docs/reference/third-party-hooks
  - Codex: https://developers.openai.com/codex/hooks.md
  - Gemini CLI: https://geminicli.com/docs/hooks/reference/ ; https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/writing-hooks.md
- **Code search.** GitHub REST `search/code`: 153 queries with the exact strings recorded in the research notes (examples in §1d and §4). It sampled 108 `.claude/settings.json` files, plus Cursor, Codex, Gemini, Copilot, Windsurf, Kiro, Cline and OpenCode configs, all fetched via `repos/<r>/contents/<path>` and read as text. Nothing downloaded was executed.
- **Repo metadata.** `gh api repos/<r>` for every repo in §3 and the inline star counts. License texts were read for dcg, swiz and oh-my-openagent.
- **Repo search.** About 160 `search/repositories` queries, sorted by stars, merged into 1,931 repos.
- **Issues.** `search/issues` on `repo:anthropics/claude-code is:issue "<term>" in:title hook`, sorted by reactions, for 24 terms, plus the top hook issues for openai/codex, google-gemini/gemini-cli, anomalyco/opencode and cline/cline.
- **Hacker News.** Algolia API: items 44429225, 46985151, 47343927, 47895029, 46388882, 46337118, 48409955, 49656471, 48588755, 49299985, 48884903, 48318978, 47079718.
- **Practitioner posts:**
  - https://blog.sshh.io/p/how-i-use-every-claude-code-feature
  - https://www.web-developpeur.com/en/blog/claude-code-hooks-exemples
  - https://theaiarchitects.com/blog/claude-code-hooks
  - https://stevekinney.com/courses/ai-development/claude-code-hooks
  - https://blog.gitbutler.com/cursor-hooks-deep-dive
  - https://cursor.com/blog/hooks-partners
  - https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/
  - https://mroczek.dev/articles/the-token-compression-illusion-why-im-skeptical-of-rtk/
  - https://codex.danielvaughan.com/2026/04/15/codex-cli-hooks-complete-guide-events-policy-patterns/

## Unverified / not reached

- **Reddit:** unreachable by every route. WebFetch refuses reddit.com; curl to `old.reddit.com` returned 302 and to `www.reddit.com/.../search.json` returned 403; WebSearch reports the domain "not accessible". The prior study hit the same block. **X/Twitter:** WebFetch returned HTTP 402. Discord was not attempted. Practitioner evidence here is therefore HN, blogs and GitHub only.
- **Code-search numbers are approximate.** They count files rather than repos, include forks, templates and backups, and tokenise quoted strings. Use them only for order of magnitude. Rows in the hand sample marked "(name)" (94 of 178 Claude entries) were classified from script names, not content. User-level `~/.claude/settings.json` is rarely committed, so notification and TTS hooks are under-counted in CS.
- **Undocumented env-var hooks no-op.** This is inferred from the docs, not tested by running them.
- **Codex rejecting `updatedInput`/`additionalContext` in PreToolUse** is reported by three tool READMEs. The current Codex hooks doc lists `updatedInput`; I did not test which Codex version or surface the READMEs refer to.
- **Ship dates not found:** Cursor `workspaceOpen` and cloud-agent hook support; Copilot cloud-agent hooks; Windsurf events `post_setup_worktree` and `post_cascade_response_with_transcript`; Kiro IDE 1.0.
- **Claude Code hooks doc diff.** I could not diff it against its 2026-09-14 version. Fields such as `defer`, `asyncRewake`, `args` and `once` may predate the prior doc.
- **Undocumented fail modes:** Cline extension behaviour on hook crash ("handled silently"); Amp plugin fail mode and timeout; Antigravity exit-code semantics.
- **Continue `cn` events** come from source; I did not verify that each listed event actually fires.
- **mherod/swiz** shows 0 stars via the API (the prior doc recorded 3), which is inconsistent with its size. Its 169 hook names come from its README.
- **hookstack.app hook names** came from a model summary of the live site and may be lightly paraphrased.
- **Official marketplace hook count** ("≥61 of 315") is a lower bound: 21 plugins had no manifest at the probed path, and 11 declare hooks only in `plugin.json`, which I did not read.
- **GitButler's `but claude` hook commands** are documented (https://docs.gitbutler.com/features/ai-integration/claude-code-hooks), but I did not find the implementing code in the current tree. The separate [gitbutlerapp/claude](https://github.com/gitbutlerapp/claude) plugin does ship hooks.json.
- **nah author's claim** that hooks run asynchronously under `--dangerously-skip-permissions` (citing claude-code#20946): not verified.
- **Self-reported numbers** in READMEs (latency, % tokens saved, precision/recall) were not reproduced.
- **John Lindquist's podcast hook demo** and the egghead "block npm → bun" Cursor lesson are known only from search snippets; I did not fetch the pages.
- **Secret exposure:** one sampled Gemini config (calliopeai/zentinelle) contains an inline API-key-like value in a hook command. I have not reproduced it.
