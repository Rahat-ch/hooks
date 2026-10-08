# How do Claude Code mods relate to, overlap with, and affect a library of reusable hooks?

Researched 2026-10-07 against Claude Code **2.1.293** (local `claude --version`; the bundled `plugin-authoring` skill and its generated type file are from the same build). Primary sources are the official mods pages fetched as raw Markdown from `code.claude.com/docs/en/plugins/mods/<page>.md`, the CHANGELOG, GitHub release metadata, Anthropic's own repos, and the design issue on `anthropics/claude-code`. Community material is labelled as such. Everything I inferred myself is marked **(inference)**.

## Verdict

A **mod** is a Claude Code plugin whose `hooks/hooks.json` names a JavaScript/TypeScript **hooks module** instead of (or as well as) shell commands. The module exports `register(on, options)` and adds in-process **function hooks** `($, e, next)` that run as Koa-style middleware over about 45 engine events, plus every settings-hook event re-exposed as `classic.<Event>`. Mods shipped on by default in **2.1.287 (2026-10-01)**, six days before this research, and the type file still labels the API "EARLY ACCESS: this surface may change between releases without notice". Mods can do almost everything a command hook does, and a lot that command hooks cannot: draw panes, bands, toasts and status lines, redraw built-in UI, rewrite prompts and tool calls, answer events in place of the engine, register slash commands and model-callable tools, keep state between events, and run 10x to 100x faster because nothing is spawned per event. They are also **Claude-Code-only**, **JS/TS-only**, unsandboxed, and they fail **open** by default. They are blocked separately from command hooks by enterprise policy (`allowManagedModsOnly` stops users' mods but leaves their settings hooks running), and in the VS Code chat panel, `claude -p` and the SDK they run but draw nothing. Anthropic states that settings hooks are not deprecated: "Nothing about them is deprecated" ([admin](https://code.claude.com/docs/en/plugins/mods/admin.md)). The same team also says it intends to migrate existing built-in features into mod form ([#91870](https://github.com/anthropics/claude-code/issues/91870)). **Recommendation:** keep **command hooks as the library's canonical, portable artifact**. Add an **optional mod layer** for Claude Code only, where in-process speed or UI earns it: observability panes, cost and usage status lines, toasts, interactive approval guards, and per-event hot paths. Use a **handshake** so that both layers never act on the same event, and a guard must fail closed (`.catch`) whenever the mod path owns it. Do not make any guard depend on the mod path alone.

---

## 1. What mods are

### 1.1 Definition and naming

- Official: "A mod is a plugin that changes how Claude Code looks and behaves. It's made of JavaScript or TypeScript event handlers: Claude Code calls one when an event happens ... and the handler can watch the event, change it, or take it over" ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md)).
- On terminology, the docs say: "Claude Code calls both kinds hooks: on these pages, 'hook' means a mod's handler, and the settings-file kind is a 'settings hook'" ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md)). The hooks reference now opens with: "A plugin can also register hooks as JavaScript functions that Claude Code calls in its own process ... A plugin that does is a mod ... The hooks on this page keep working alongside mods" ([hooks.md](https://code.claude.com/docs/en/hooks.md), line 15).
- On the product name versus the primitive, the maintainer wrote: "from a product perspective, we are going to be calling this functionality 'Claude Mods'. The engineering term of art 'function hook' will still exist as the documented implementation primitive ... A mod is just a plugin that uses function hooks" ([#91870](https://github.com/anthropics/claude-code/issues/91870), update of 2026-09-09).
- The built-in skill describes it as "Make a mod: a live pane, band, status line, toast or hook inside Claude Code (terminal or desktop Code tab), written as a plugin of function hooks that hot-reloads in this session" (local skill listing; `SKILL.md` in `/private/tmp/claude-501/bundled-skills/2.1.293/<hash>/plugin-authoring/`).

### 1.2 Timeline

| Date | Event | Source |
|---|---|---|
| 2026-09-03 | Design RFC "Mods - make Claude 10x more extensible" (originally "Function Hooks"), with an architecture PDF and demo videos. Open, 129 thumbs-up, 245 comments, labels `area:hooks`, `area:plugins` | [#91870](https://github.com/anthropics/claude-code/issues/91870) |
| 2026-09-09 | Early access announced: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude` on "v267/v268"; built-in mod source published | [#91870](https://github.com/anthropics/claude-code/issues/91870) |
| 2026-09-30 | 2.1.286 released; the Desktop app runs mods from this version | [release](https://github.com/anthropics/claude-code/releases/tag/v2.1.286), [overview](https://code.claude.com/docs/en/plugins/mods/overview.md) |
| 2026-10-01 | 2.1.287: "Added Claude Mods: plugins may now modify deeper behavior"; on by default in the terminal; the env var is now ignored | [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), [release](https://github.com/anthropics/claude-code/releases/tag/v2.1.287); launch posts [claude.com/blog/claude-code-mods](https://claude.com/blog/claude-code-mods) and [claude.dev blog](https://claude.dev/blog/getting-started-with-claude-code-mods/) (both dated Oct 1, 2026) |
| 2026-10-01 to 10-07 | 2.1.288 to 2.1.293 are dense with mod fixes and new API: `prompt.autocomplete`, prompt caching for `$.model.complete`, `isDeferred` on `$.tool.register`, guard bypass fixes, "Fixed a mod's hooks on `classic.*` events being skipped while the plugin hooks worker restarts" | [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) 2.1.288 to 2.1.293 |

Community report: the ruflo project observed mods loading on 2.1.282 only with the env var set, and a server-side rollout switch (`tengu_plugin_hooks_modules`) that "flipped between on and off several times in one afternoon" ([ruflo ADR-404](https://github.com/ruvnet/ruflo/blob/main/v3/docs/adr/ADR-404-claude-code-mods-function-hooks.md)). The official troubleshooting page confirms that a remote kill switch exists ("`hooks modules are turned off in this process`: Anthropic has turned installed mods off remotely", [troubleshoot](https://code.claude.com/docs/en/plugins/mods/troubleshoot.md)).

### 1.3 Files, loading, on-disk locations

- **Layout.** A mod is `.claude-plugin/plugin.json`, `hooks/hooks.json` with `"modules": ["./register.js"]` ("an array with one path"), and the module itself. The module can be `.js .mjs .cjs .jsx .ts .mts .cts .tsx` and is always an ES module. There is an optional `types/index.d.ts` for `$.state` and added namespaces, and optional `*.test.ts` files. `hooks.json` "Can also hold settings hooks under `hooks`" ([reference#files](https://code.claude.com/docs/en/plugins/mods/reference.md)). No Node.js, bundler or build step is needed: "Claude Code loads `.js` and `.ts` files directly" ([create](https://code.claude.com/docs/en/plugins/mods/create.md)).
- **Runtime.** "The module runs in an environment of its own, with no DOM and no Node". There is no `require`, and "A module holding `import()` does not load". Standard web APIs (`URL`, `TextEncoder`, `AbortController`, `crypto.subtle`) are available (type file header, see Sources, [api](https://code.claude.com/docs/en/plugins/mods/api.md)). The maintainer said the boundary is "a Bun Worker surrounding the entire plugin realm, with each plugin then having a `node:vm` wrapper", but "that's not part of the contract" ([#91870](https://github.com/anthropics/claude-code/issues/91870)). "Installed mods share one worker thread". A mod that blocks it gets unloaded, and three untraceable crashes unload every non-built-in mod for the session ([troubleshoot](https://code.claude.com/docs/en/plugins/mods/troubleshoot.md)).
- **Loading paths:**
  - installed plugins, read from the install cache or, for a directory marketplace, from the folder itself;
  - `claude --plugin-dir <dir>`, or `CLAUDE_CODE_PLUGIN_DIRS`, which is watched and hot-reloads on save;
  - plugins auto-loaded from `~/.claude/skills/<name>` or `.claude/skills/<name>`;
  - mods that Claude writes in-session under `~/.claude/dev-mods/<session-id>/<mod>/`, which hot-reload once the user answers "Enable hot reloading for this session?".

  Sources: skill `reference.md` and `SKILL.md` (local), [create](https://code.claude.com/docs/en/plugins/mods/create.md). Local evidence: `~/.claude/dev-mods/ad946e37-.../` exists, empty, created 2026-10-03.
- **Reload.** A reload "is a fresh load of the module: `register` runs again and `session.start` fires again. Values in `$.state` (the session's) and `$.store` (across sessions) are the host's and stay; the module's own variables start over" (skill `SKILL.md`). `/reload-plugins` re-reads installed plugins ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md)). This partly answers the old "auto-reload hooks" complaint ([#24057](https://github.com/anthropics/claude-code/issues/24057), cited in `hooks-tool-opportunity.md`), but only for mods.
- **Types.** The engine writes this build's full API as `.claude-plugin/types/claude-code/index.d.ts` beside each mod it loads. That file is about 14k lines of API plus built-in tool and MCP tool typings, 21,293 lines in all for 2.1.293. "There is no command to run", and "The API is early access and moves between releases: the declaration file is the authority" (skill `reference.md`).
- **Tooling.**
  - `claude plugin validate <dir>` statically lists the events a mod hooks and the `$` calls it makes, and flags "gating" hooks with or without `.catch`. "Claude Code refuses to load a mod that uses the mods API in a way this command can't read" ([admin](https://code.claude.com/docs/en/plugins/mods/admin.md)).
  - `claude plugin test` runs `*.test.ts` against the real engine with `claude-code/testing` mocks, "with no session, sign-in, or network" ([test](https://code.claude.com/docs/en/plugins/mods/test.md)).

### 1.4 Programming model

- `on(event, matcher?, hook)` registers a hook. A matcher is an object whose fields are values, arrays or regexes, for example `{ tool: /^mcp__github__/ }`. Events can be globbed: `'classic.*'`, or `'*'` (which excludes telemetry). Registering an event twice without a matcher fails the load ([events](https://code.claude.com/docs/en/plugins/mods/events.md)).
- Each hook is `($, e, next)`, where `e` is deeply frozen ([events](https://code.claude.com/docs/en/plugins/mods/events.md)). A hook can do one of three things:
  - **observe**: `return next(e)`;
  - **rewrite**: `next({...e, x})`;
  - **answer**: return a result without calling `next`. On `tool.call`, `{ deny }` or `{ result }`.

  `next` can also be awaited to act on the result, or called twice to retry ([#91870](https://github.com/anthropics/claude-code/issues/91870)).
- **All side effects go through `$`**: `$.fs`, `$.process` (argv only, no shell, 30 s default and 10 min maximum timeout), `$.http`, `$.store` (4 MiB), `$.state`, `$.env`, `$.settings`, `$.session`, `$.mcp`, `$.model.complete`, `$.model.fork`, `$.model.classify`, `$.prompt.submit`, `$.command.register`, `$.tool.register`, `$.agent.register` and `$.agent.spawn`, `$.clock.every` and `$.clock.after`, `$.audio`, and `$.ui.*`. Every `$` call "is itself an event", so an earlier mod in the chain can observe, rewrite or refuse it ([api](https://code.claude.com/docs/en/plugins/mods/api.md), [reference#limits](https://code.claude.com/docs/en/plugins/mods/reference.md)).
- **Budgets.** A hook gets 10 s of its *own* execution time per dispatch. Time inside `next` and `$` calls is not counted, apart from `$.clock.sleep`. The limit is 50 ms for `prompt.edit`. A `.catch` handler gets 1 s. All `session.end` hooks share the SessionEnd budget, 1.5 s by default ([reference#limits](https://code.claude.com/docs/en/plugins/mods/reference.md); `HookBudget` in the type file).
- **Failure.** A hook that throws, times out or returns a wrong shape is **skipped**. If it failed before `next`, the rest of the chain runs. A guard therefore **fails open** unless it is registered with `.catch(($, e, next) => next.called ? next(e) : { deny: '...' })` ([events#handle-a-hook-that-fails](https://code.claude.com/docs/en/plugins/mods/events.md)).

### 1.5 Event surface

The list below is from the [reference#events](https://code.claude.com/docs/en/plugins/mods/reference.md), cross-checked against `EngineEventOf` and `OpEventOf` in the 2.1.293 type file.

| Group | Events |
|---|---|
| Tools | `tool.call` (wraps the permission check and the tool; deny, rewrite, answer, retry, act after), `tool.check` (after rules and `PreToolUse`; return `allow`/`ask`/`deny`), `tool.describe` |
| Prompt and context | `prompt.submit` (rewrite, add `context`, `drop`), `prompt.compose`/`prompt.section` (system prompt sections), `prompt.context` (first-message context), `prompt.attachment` (engine reminders), `prompt.mention`, `prompt.fill`/`suggest`/`edit`/`autocomplete`, `skill.prompt`, `attribution.text` |
| Turns | `turn.start`, `turn.step` (streaming async generator per model request: read usage, switch model or effort, answer without the model), `turn.complete` |
| Session | `session.start`, `session.end`, `session.compact` (can `skip`), `session.append` (rewrite every stored transcript row), `session.receive`/`send` (cross-session messages), `session.attach`/`detach`, `session.measure` |
| Subagents | `agent.offer`, `agent.spawn` (choose model or deny; includes teammates and workflow agents) |
| Commands and config | `command.run`, `command.describe`, `config.set`, `config.describe` |
| UI | `ui.render` (13 render sites), `ui.press`/`input`/`select`/`focus`/`scroll`/`close`/`message`/`fault`, `ui.resolve` |
| Other mods | `plugin.register` (refuse a module by its scanned `uses`), `engine.create` (add a `$` namespace) |
| Telemetry | `telemetry.log`/`mark` (an installed mod must filter `{ to: 'collector' }`) |
| Settings hooks | `classic.<Event>` for every settings hook event. "Each fires wherever the engine runs the classic hook, whether or not any settings hook is configured" (type file, `ClassicEventName`). `e` is the stdin JSON, and the result is the same decision set (`block`, `additionalContext`, `preventContinuation`, ...; `classic.PreToolUse` keeps allow/ask/deny) |
| `$` calls | `fs.read`, `process.run`, `http.fetch`, `model.complete`, ... (each `$` method) |

### 1.6 UI surfaces

All UI calls below are documented in [api](https://code.claude.com/docs/en/plugins/mods/api.md), [interface](https://code.claude.com/docs/en/plugins/mods/interface.md) and [reference#render-sites](https://code.claude.com/docs/en/plugins/mods/reference.md).

- **Pane**: `$.ui.open({id,title})` plus `ui.render` on `{component:'Pane'}`. It docks beside the transcript in fullscreen and opens inline otherwise. Opened unasked, it waits for 144 or more columns.
- **Band above the prompt**: `ui.render` on `{component:'AbovePrompt'}`.
- **Status line entry**: `$.ui.status(text)` draws "One line under the prompt that stays until you change it. It starts with `⚠` and the mod's name". This is distinct from the settings `statusLine` command.
- **Toast**: `$.ui.toast(text)`, an in-app toast at the top right, 4 s by default. **(inference)** It is not an OS notification. The type doc says it "leaves the transcript and the model untouched". A desktop or OS notification still needs `$.process.run` (osascript, notify-send) or a settings `Notification` hook with `terminalSequence`.
- **Transcript line**: `$.ui.log(text)`, dim, and not read by Claude. **Question dialog**: `$.ui.ask(question, options)`, which holds a tool call until the user answers.
- **Redraw built-ins**: render sites include `UserMessage`, `AssistantMessage`, `ToolUse`/`ToolResult`/`ToolGroup`, `CommandOutput`, `AskUserQuestion`, `Spinner`, `ToolProgress`, `TurnDuration`, `InfoNotice`, `SessionMode` and `PromptHint`. The **permission prompt is not hookable**: "A mod can restyle much of Claude Code's interface, but not the permission prompt" ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md)).
- **Elements**: `Box`, `Text`, `Button`, `Input`, `Select`, `Markdown`, `Code` (including diffs), `Link`, `Svg` (desktop), `Raster`/`Image` (terminal only), and `Client` (a custom surface module), resolved per surface via `$.ui.resolve(e)`.

### 1.7 Where mods run

The table is from [overview#where-mods-run](https://code.claude.com/docs/en/plugins/mods/overview.md).

| Where | Hooks run | Drawing appears |
|---|---|---|
| `claude` in a terminal (incl. editor terminals, JetBrains) | Yes | Yes |
| Desktop app Code tab (not WSL) | Yes | Yes, except terminal-only elements |
| Desktop WSL session | No ("plugins aren't available in WSL sessions") | No |
| VS Code extension chat panel | Yes | **No** |
| `claude -p`, Agent SDK | Yes | **No** |
| Remote Control from claude.ai or mobile | Yes, on your machine | In the local terminal |
| Cloud session | Yes, "for a plugin that reaches the cloud session" | **No** |

Settings hooks, by contrast, fire "wherever it runs: sessions in the terminal, IDE extensions, the Desktop app, and cloud sessions" ([hooks.md](https://code.claude.com/docs/en/hooks.md), line 13).

### 1.8 Distribution and enablement

- "A mod installs as a plugin, from a marketplace": `/plugin install <name>@<marketplace>` or `claude plugin install ...`. The docs add that "Install plugins ... apply to a plugin that contains a mod without changes" ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md)). The one-line share form is `/plugin install <mod> --marketplace <owner>/<repo>`, with `.claude-plugin/marketplace.json` beside `plugin.json` (skill `reference.md`).
- **Off switches for one user:**
  - disable or uninstall the plugin in `/plugin`;
  - `--safe-mode` for one session;
  - `"disableAllHooks": true`, which also stops their settings hooks and custom status line.

  `/plugin` shows `N mod active · names` ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md)).
- `userConfig` fields in the manifest become `options` for `register`, and each one is a row in `/config`. Values are read from `pluginConfigs` in settings (skill `reference.md`; [reference](https://code.claude.com/docs/en/plugins/mods/reference.md)).

### 1.9 Built-in and official mods

- **Built in:** `cc-plugin-agents-md` (AGENTS.md support), `cc-plugin-diff` (`/diff`), `cc-plugin-sec-default` (the org guard), `cc-plugin-telemetry`, `cc-plugin-you-should-know` (side agent, disabled by default), and `cc-plugin-plugin-authoring` (skill only). Source for four of them is in [anthropics/claude-code/mods](https://github.com/anthropics/claude-code/tree/main/mods). That README still says "Early access ... the API these mods are written against may change between releases without notice" ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md), [mods/README](https://github.com/anthropics/claude-code/blob/main/mods/README.md)).
- **Samples:** `token-weather`, `blast-radius` (a held-Bash-command guard with a Proceed/Cancel pane, 528-line `.mjs`) and `replay-theater`, in [anthropics/claude-code-playground/claude-code/mods](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods).
- **Official marketplace precedent for "both in one plugin":** `claude-plugins-official/plugins/code-modernization/hooks/hooks.json` declares five **command hooks** (`UserPromptSubmit`, `Stop`, `SessionStart`, `PostToolUseFailure`, `StopFailure`, all `asyncRewake` shell telemetry) **and** `"modules": ["./register.ts"]` for its panes ([file](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-modernization/hooks/hooks.json)).

---

## 2. Function hooks (mods) vs command (settings) hooks

| Dimension | Command / settings hook | Mod function hook | Source |
|---|---|---|---|
| Config | `settings.json` (any scope) or a plugin's `hooks/hooks.json` `hooks` | Only in a plugin: `hooks/hooks.json` `modules` | [reference#files](https://code.claude.com/docs/en/plugins/mods/reference.md) |
| Language | Any executable, plus `http`, `prompt`, `agent` and `mcp_tool` types | JS/TS only, no Node and no `import()` | [hooks.md](https://code.claude.com/docs/en/hooks.md); types header |
| Process model | A process spawned per firing; JSON on stdin; exit code and stdout JSON back | Loaded once into a shared worker; function call per event | [blog](https://claude.dev/blog/getting-started-with-claude-code-mods/): "A settings hook runs a shell command for each event ... A mod is loaded once and stays in the session" |
| Latency | Community: 16 to 19 ms median per spawn for a Node helper, plus CLI work (a further 337 ms median in one plugin) | Community: `tool.check` settled in 1.6 to 4.0 ms (median about 1.9 ms) live on 2.1.287, worker hop included; handler alone 0.005 to 0.045 ms | [ruflo ADR-404 Benchmarks](https://github.com/ruvnet/ruflo/blob/main/v3/docs/adr/ADR-404-claude-code-mods-function-hooks.md), [bench script](https://github.com/ruvnet/ruflo/blob/main/scripts/bench-mods-latency.ts) (community, not independently reproduced) |
| Events | The settings-hook event set (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, Notification, PreCompact, ...) | All of those as `classic.*`, **plus** about 45 engine events (`EngineEventOf` in the type file) (system-prompt sections, every transcript row, per-request `turn.step`, subagent spawn, commands, config, UI, other mods, `$` calls) | §1.5 |
| Decisions | block (exit 2 or `decision`), allow/ask/deny, `updatedInput`, `additionalContext`, `updatedToolOutput`, `continue:false` | Same via `classic.*`; also `{ deny }` / `{ result }` on `tool.call` (no permission prompt, tool not run), `tool.check` verdict override, rewrite of any prompt section, transcript row or model choice, `prompt.submit` `drop` | [events](https://code.claude.com/docs/en/plugins/mods/events.md) |
| Ordering | All matching hooks run in parallel | A deterministic middleware chain: managed `PreToolUse` → `sec-default`/`prependPlugins` → user mods (dependents before dependencies; registration order inside a module) → `appendPlugins` → built-ins → core. Non-managed settings `PreToolUse` and plugin `hooks.json` hooks run **inside core**, after the last mod's `next` | [events#the-order-mods-run-in](https://code.claude.com/docs/en/plugins/mods/events.md) |
| Precedence vs permissions | `PreToolUse` cannot override deny or ask rules | `tool.check` can approve an ask-rule call, approve a call a non-managed `PreToolUse` hook blocked, and skip the auto-mode classifier. It can override **deny rules** only where `sec-default` is absent (no managed settings and not Team/Enterprise), or when an admin sets `allowModsToOverrideDenyRules` | [permissions#extend-permissions-with-hooks](https://code.claude.com/docs/en/permissions.md), [admin](https://code.claude.com/docs/en/plugins/mods/admin.md) |
| Interplay | n/a | A mod that answers `tool.call` without `next` **prevents user and plugin `PreToolUse` command hooks from running**; managed ones still run first, and again on a rewritten call | [events](https://code.claude.com/docs/en/plugins/mods/events.md), [admin](https://code.claude.com/docs/en/plugins/mods/admin.md) |
| Timeouts | 600 s default (30 s on UserPromptSubmit); on PreToolUse a timeout does not block | 10 s of own CPU time; waits on `$`/`next` are free; skipped on overrun | [hooks.md](https://code.claude.com/docs/en/hooks.md) line 426; [reference#limits](https://code.claude.com/docs/en/plugins/mods/reference.md) |
| Failure | Non-zero exit (not 2) is non-blocking with a `hook error` notice; can't-start is the same | Skipped silently (debug log only, unless hot-reloading). **Fail-open unless `.catch`** | [hooks-session-bloat.md](hooks-session-bloat.md) §1; [troubleshoot](https://code.claude.com/docs/en/plugins/mods/troubleshoot.md) |
| Async / background | `async: true`, `asyncRewake` | `$.clock.every`/`after` timers from `session.start`; `$.prompt.submit` wakes an idle session; `next.signal` for abort | [api](https://code.claude.com/docs/en/plugins/mods/api.md) |
| State | Files on disk; nothing in memory between firings | Module variables (lost on reload), `$.state` (session, versioned, drives redraws), `$.store` (cross-session, 4 MiB) | [interface#keep-state](https://code.claude.com/docs/en/plugins/mods/interface.md) |
| Session access | stdin fields plus `transcript_path` | `$.session.messages()`, `usage()`, `model()`, `cwd()`, ...; the maintainer discourages raw transcript reads as "not a stable interface" | [api](https://code.claude.com/docs/en/plugins/mods/api.md), [#91870](https://github.com/anthropics/claude-code/issues/91870) |
| Model calls | `prompt`/`agent` hook types | `$.model.complete` (with prompt caching), `$.model.fork` (cache-sharing question over the transcript), `$.model.classify` | skill `reference.md` |
| UI | None (stdout or `systemMessage` only; `terminalSequence` for OSC) | Panes, bands, toasts, status entries, redraws of built-in rows | §1.6 |
| Trust and sandbox | Runs as the user, outside the sandbox | Runs as the user, **not sandboxed**; "a process that a mod starts runs outside" the Bash sandbox; `$.fs` ignores `Read(...)` deny rules | [overview#what-a-mod-can-reach](https://code.claude.com/docs/en/plugins/mods/overview.md), [admin](https://code.claude.com/docs/en/plugins/mods/admin.md) |
| Static audit | None built in | `claude plugin validate` lists `hooks:` and `calls:` before install; `plugin.register` lets a policy mod refuse others by scanned capability | [admin#review-what-a-mod-can-do](https://code.claude.com/docs/en/plugins/mods/admin.md) |
| Testing | Bring your own | `claude plugin test` with an engine-backed kit and mocks | [test](https://code.claude.com/docs/en/plugins/mods/test.md) |
| Portability | Same stdin/exit-code shape copied by Codex, Cursor, Copilot and others (see `agent-framework-hooks.md`) | Claude Code only (see §4 for one bridge) | — |

**Can a mod do everything a command hook can?** Functionally, almost. `classic.<Event>` fires for every settings-hook event with the same input and decision set, whether or not a settings hook is configured (type file). `$.process.run` can shell out to an existing script. **(inference)** A mod is not a drop-in replacement in these cases:

- **Policy.** `allowManagedModsOnly` and `allowManagedHooksOnly` treat the two layers differently (§3).
- **Surfaces.** WSL Desktop sessions don't run plugins at all.
- **Fail-closed by default.** A command `PreToolUse` that exits 2 blocks. A mod guard that throws lets the call through unless it has a `.catch`.
- **Language.** Mods are JS/TS only.
- **Long blocking work.** The 10 s own-time budget is generous because `$` waits are free, but a command hook can legitimately run for minutes.
- **Spawned processes.** `$.process.run` is argv-only, with no shell.

**What can a mod do that command hooks can't?**

- draw UI;
- hold a tool call on a dialog (`$.ui.ask`);
- answer a tool call with a synthetic result and no permission prompt;
- override verdicts after the rules have run (`tool.check`);
- rewrite system-prompt sections, engine reminders, and every stored transcript row;
- switch model or effort per request;
- add slash commands that run with no turn, and model-callable tools without an MCP server;
- keep in-memory and session state;
- observe and gate other mods;
- run at about 2 ms instead of about 20 ms per event (community figure).

---

## 3. Plugins, marketplaces, and policy controls

- **One plugin can ship both.** `hooks/hooks.json` can hold `hooks` (settings hooks) and `modules` together ([reference#files](https://code.claude.com/docs/en/plugins/mods/reference.md); [plugins/components](https://code.claude.com/docs/en/plugins/components.md) line 775: "list a module file under a `modules` key in the same `hooks/hooks.json`"). Anthropic's `code-modernization` plugin does exactly that (§1.9). A plugin can also hold skills, agents and MCP servers ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md)).
- **Policy keys and their reach:**

  | Setting | User settings hooks | User-installed mods | Org mods | Source |
  |---|---|---|---|---|
  | `allowManagedModsOnly` (option on `cc-plugin-sec-default@builtin`, managed `pluginConfigs`) | **keep running** | blocked (installed, `--plugin-dir`, Claude-written) | run | [admin#stop-user-installed-mods-from-loading](https://code.claude.com/docs/en/plugins/mods/admin.md) |
  | `allowManagedHooksOnly` (managed) | blocked (except force-enabled plugins' hooks) | blocked | run only if they "count as" the org's | [settings-reference](https://code.claude.com/docs/en/settings-reference.md) "What runs under allowManagedHooksOnly" |
  | `disableAllHooks` in user settings | off | off | keep running | [settings-reference#disableallhooks](https://code.claude.com/docs/en/settings-reference.md) |
  | `disableAllHooks` in managed settings | off (managed ones too) | off | off | same |
  | `disableSideloadFlags` | — | rejects `--plugin-dir`/`--plugin-url` and Claude-written mods | — | [admin](https://code.claude.com/docs/en/plugins/mods/admin.md) |
  | `strictKnownMarketplaces` etc. | apply to plugin hooks | apply ("A mod is a plugin") | — | [admin](https://code.claude.com/docs/en/plugins/mods/admin.md) |

  Built-in mods ignore all of these. These settings "stop a mod and leave the rest of its plugin in place". Skills, commands, agents, MCP servers **and, per the table, the plugin's settings hooks under `allowManagedModsOnly`** still load ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md)).
- **Default guard.** On machines with managed settings, or for Team/Enterprise sign-ins, `sec-default@builtin` loads outermost. It keeps user mods from changing managed hooks, the system prompt, managed CLAUDE.md, settings reads and managed MCP tools, and it holds deny rules over a mod's `tool.check` approval. Everything else stays allowed ([admin#know-what-happens-by-default](https://code.claude.com/docs/en/plugins/mods/admin.md), [mods/sec-default](https://github.com/anthropics/claude-code/tree/main/mods/sec-default)).
- **Workspace trust.** "In an interactive session in a directory the user hasn't trusted yet, no mod loads until they answer the trust prompt" ([admin](https://code.claude.com/docs/en/plugins/mods/admin.md)).

**(inference)** The practical consequence for a library: in a locked-down enterprise that sets `allowManagedModsOnly`, a hooks library shipped as **command hooks in a plugin still works**, while the same functionality shipped **only as a mod silently disappears**. That is the strongest single argument for keeping command hooks canonical.

---

## 4. Community landscape (6 days after launch)

All counts are self-reported or GitHub-search approximations as of 2026-10-07.

- **Volume.**
  - `karanb192/awesome-claude-code-mods` (309 stars, created 2026-09-15, during early access) runs a scanner that reports "**2690 mods** · Last scanned 2026-10-06" and validates each with `claude plugin validate` ([README](https://github.com/karanb192/awesome-claude-code-mods)).
  - GitHub code search finds 3,176 `hooks.json` files containing `"modules"`, and 279 repos tagged `claude-code-mod` (search API, 2026-10-07).
  - Other collections: `hamzafer/claude-code-mods` (137 stars), `whyashthakker/awesome-claude-code-mods` (24), `promptadvisers/claude-mods-starter-kit` (15), `baselane-sh/mods-catalog` (7), and a "mods" component category in `davila7/claude-code-templates` (32k stars) with security, observability, productivity and UI sections ([dir](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods)).
- **What they build**, by the awesome list's categories:
  - dashboards and usage (context fill, cost, 5h/7d quota bars; around 22 listed);
  - while-you-wait games and animations;
  - Git/PR/CI status bands;
  - safety and privacy (secret redaction before the model reads output; `launch-codes`; `merge-gate`; `blast-radius`-style holds);
  - memory and context (side-chat via `$.model.fork`, micro-compaction);
  - rendering (Mermaid, LaTeX, Markdown panes, a browser pane);
  - agents and workflows (subagent panes, multi-CLI councils).

  The safety and privacy category is the one that overlaps a hooks library directly. The observability category overlaps hook-based dashboards.
- **Positioning claims (community opinion, not fact).** The same awesome list describes its sibling `karanb192/claude-code-hooks` as "Shell-hook plugins ... **the layer mods are replacing**". Anthropic's own docs say the opposite about deprecation (§5).
- **Dual-shipping in practice.** ruflo, a large agent harness, converted 44 of its 46 plugins to ship mods. Its main mod uses a **handshake**: at `session.start` the mod sets `RUFLO_MODS_OWNS=route,post-edit` via `$.env.set`, and its classic `hook-handler.cjs` returns early for owned events. "The classic hooks stay the default and the fallback; nothing removes them". Guards are never handed over ("a second refusal changes nothing"). Its plugin-creator template ships "a hybrid `hooks.json` whose classic fallback exits while the module runs" ([ADR-404](https://github.com/ruvnet/ruflo/blob/main/v3/docs/adr/ADR-404-claude-code-mods-function-hooks.md), [ADR-446](https://github.com/ruvnet/ruflo/blob/main/v3/docs/adr/ADR-446-plugins-as-mods.md)). Two lessons from its own review:
  - **Copy drift.** 38 copies of a secret screen ended up in 18 byte-variants, because "plugins install as separate directories, so there is nowhere shared to import from".
  - **A fail-open guard.** Its memory-write secret guard missed tokens past truncation limits and in structured keys ([mod-capability-review-2026-10](https://github.com/ruvnet/ruflo/blob/main/v3/docs/validation/mod-capability-review-2026-10.md)).
- **Portability signal.** `deepseek-ai/deepseek-harness` ships an experimental `@deepseek-ai/dsh-experimental-claude-code-mods` bridge that runs a Claude Code mod's `register(on, options)` inside another harness, "an alpha interface-compatibility demonstration" in which unserved events and `$` members are reported ([README](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/experimental/claude-code-mods)). **(inference)** The mod API may become a second de facto cross-agent target, as the command-hook schema did. One alpha bridge is not yet a trend.

---

## 5. Implications for the hooks library

### 5.1 Will mods supersede command hooks?

- **Documented.** "Settings hooks keep working. Command, HTTP, prompt, and agent hooks in settings files and in plugins' `hooks/hooks.json` run as before, alongside mods. Nothing about them is deprecated" ([admin#know-which-controls-still-apply](https://code.claude.com/docs/en/plugins/mods/admin.md)). The hooks reference says the same ([hooks.md](https://code.claude.com/docs/en/hooks.md)).
- **Directional.** "Our intent is to take further extant features as they exist in CC today and migrate them to mod form" ([#91870](https://github.com/anthropics/claude-code/issues/91870)). The launch post says hooks "can't rewrite events, draw new UI, or replace features. Mods can" ([claude.com blog](https://claude.com/blog/claude-code-mods)). The engine already re-hosts settings hooks as the innermost `classic.*` tier (§2).
- **(inference)** Command hooks look like the stable compatibility floor: every other agent copied them, enterprises can keep them while banning mods, and Anthropic has explicitly kept them. Mods look like where new Claude Code capability will land. The risk is not deprecation. The risk is **feature gravity**: new events, such as `turn.step` usage and `session.append`, may appear only in the mod API.

### 5.2 Pattern-by-pattern placement

| Hook pattern | Best form | Why |
|---|---|---|
| Dangerous-command / protected-path guards (PreToolUse deny) | **Command hook (canonical)**, optional mod | Portable, survives `allowManagedModsOnly`, and fails closed on exit 2. A mod version gains structured args and lower latency, but must use `.catch` to fail closed. **(inference)** Never make the mod the only guard. |
| Interactive "are you sure?" holds | **Mod** | `$.ui.ask` / pane with Proceed/Cancel (`blast-radius`). A command hook can only return `ask`, which falls through to the standard permission prompt. |
| Auto-format / lint / test after edit (PostToolUse) | **Command hook** | Spawns a tool anyway, so a mod saves little. Portable. |
| Context injection (SessionStart / UserPromptSubmit `additionalContext`) | **Command hook**, mod optional | Portable. A mod can add `prompt.submit` `context` with no spawn, or a cache-stable `prompt.section`. Same bloat caveats as `hooks-session-bloat.md`. |
| Notifications (Stop / Notification → desktop alert) | **Command hook** for OS alerts; **mod** for in-app toasts | `$.ui.toast` is in-app only. An OS notification needs a process either way. |
| Cost / token / context observability | **Mod** (status entry, band, pane), command hook as a portable logger | `turn.step` exposes per-request usage, including cache read and write, that has no settings-hook equivalent. `$.session.usage()` gives plan limits. |
| Live dashboards (tool calls, subagents) | **Mod** | In-process state plus a pane. Command hooks need an external server (prior doc: observability dashboards). |
| Secret redaction of tool output before the model reads it | **Mod** preferred (`tool.call` result rewrite or `session.append`), command hook (`updatedToolOutput`) as the portable fallback | Both are possible. The mod covers every transcript row. |
| Audit / telemetry logging | **Command hook** (async), or mod `telemetry.log` `{to:'collector'}` | Portability and enterprise acceptance favour command hooks. |
| Slash-command utilities (no model turn) | **Mod** | `command.run` answers immediately, even mid-turn. There is no settings-hook equivalent. |
| Model routing / effort per request | **Mod only** | `turn.step` `next({...e, model})`. |

### 5.3 Recommended architecture

**(inference)**, drawing on the docs above and on ruflo's handshake as a worked precedent.

1. **Keep the core logic agent-neutral**, with pure decision functions over a normalized event: tool name, args, prompt text, and so on.
2. **Ship command-hook adapters as the canonical artifact** for Claude Code, Codex, Gemini, Cursor and the others. On Claude Code they go in a plugin's `hooks/hooks.json` `hooks`, or in settings.
3. **Add an optional Claude Code mod adapter** in the **same plugin** (`"modules"` beside `"hooks"`), only for hooks where it adds value: UI, latency, mod-only events. Write it in TS. It cannot `import` from outside the plugin, so **vendor or generate** the shared core into each plugin, with a drift check. ruflo's 18-variant drift is the cautionary tale.
4. **Avoid double-firing** with an env-var handshake (`$.env.set('<LIB>_MODS_OWNS', ...)` at `session.start`, which the command adapter checks before doing work). Apply it to *side-effect* hooks only. Leave guards running on both paths: a second deny is harmless, and the command path keeps protecting when mods are off.
5. **Mod guards must** register `.catch(... { deny })`, use `tool.call`/`tool.check` with structured args, and include a `claude plugin test` suite. Run `claude plugin validate --strict --json` in CI. `gatingHooks` reports whether each gate has a `.catch`.
6. **Degrade on surfaces with no drawing.** Check `e.surface` or `$.session.surface()` and fall back to `$.ui.log` or command text in VS Code, `-p` and cloud sessions ([overview](https://code.claude.com/docs/en/plugins/mods/overview.md)).
7. **Pin and test against versions.** Generated types are per-build, and the API is early access. Record the minimum Claude Code version (2.1.287 terminal, 2.1.286 Desktop) in the manifest description or README.

### 5.4 Effect on earlier research conclusions

**(inference)**

- Wedge (c), a test harness, and part of (b), a debugger, from `hooks-tool-opportunity.md` are now partly served natively *for mods*: `claude plugin test` and `claude plugin validate`, plus transcript refusal lines in hot-reload sessions. Command hooks still have no native test runner, and cross-agent coverage remains unserved.
- The context-bloat analysis in `hooks-session-bloat.md` still applies to mods. `prompt.submit` `context` and `prompt.section` text land in context, and the docs warn that text changing between requests "invalidates the prompt cache" ([events](https://code.claude.com/docs/en/plugins/mods/events.md)). Mods also add a cleaner channel: `$.ui.log`, `$.ui.status` and toasts show information to the user without touching the model.

---

## 6. Risks, gaps, open questions

- **API stability.** The type header says "EARLY ACCESS: this surface may change between releases without notice". The skill says "The API is early access and moves between releases". The maintainer said in September that much of the semantics is "now set in place". The changelog shows renames even before launch (`fs.readFile` → `fs.read`, [#91870](https://github.com/anthropics/claude-code/issues/91870)) and many behaviour fixes after it. There is no semver or deprecation policy for the mods API.
- **Remote kill switch and rollout flag.** Installed mods can be turned off server-side ([troubleshoot](https://code.claude.com/docs/en/plugins/mods/troubleshoot.md)). A library that depends on mods inherits that availability risk. Command hooks have no such switch.
- **Fail-open default** for every mod hook, and three worker crashes unload *all* user mods for the session ([troubleshoot](https://code.claude.com/docs/en/plugins/mods/troubleshoot.md)). One buggy third-party mod can take a library's mods down with it.
- **Security surface.** Mods are unsandboxed. `$.fs` ignores Read deny rules. Outside managed or Team environments, a mod can approve a call that a deny rule refuses ([permissions](https://code.claude.com/docs/en/permissions.md)). A library mod that hooks `tool.call` keeps users' own `PreToolUse` hooks from running whenever it answers without `next`. Document this clearly.
- **Silent invisibility.** Outside hot-reload sessions, refusals and skips go to the debug log only. This is the same "does nothing silently" pain catalogued for command hooks.
- **No shared code across plugins**, apart from `dependencies` and `engine.create` nouns, which let one plugin expose a typed `$` namespace to another ([mods/README](https://github.com/anthropics/claude-code/blob/main/mods/README.md)). **(inference)** A library could publish a "core" plugin that adds `$.<lib>` and have hook plugins depend on it. That is cleaner than vendoring, but it ties the logic to the mod runtime.
- **Undocumented:** whether an older Claude Code (before 2.1.287 or before the `modules` key) rejects or ignores a `hooks.json` containing `modules`. ruflo reports the plugin "loads nothing" and its classic hooks keep running, which suggests the key is ignored. This was not verified here.

---

## Sources

Official docs (raw Markdown, fetched 2026-10-07):

- https://code.claude.com/docs/llms.txt (index; "Mods" section)
- https://code.claude.com/docs/en/plugins/mods/overview.md
- https://code.claude.com/docs/en/plugins/mods/create.md
- https://code.claude.com/docs/en/plugins/mods/reference.md
- https://code.claude.com/docs/en/plugins/mods/events.md
- https://code.claude.com/docs/en/plugins/mods/api.md
- https://code.claude.com/docs/en/plugins/mods/interface.md
- https://code.claude.com/docs/en/plugins/mods/test.md
- https://code.claude.com/docs/en/plugins/mods/troubleshoot.md
- https://code.claude.com/docs/en/plugins/mods/admin.md
- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/permissions.md (#extend-permissions-with-hooks)
- https://code.claude.com/docs/en/settings-reference.md (#allowmanagedhooksonly, #disableallhooks)
- https://code.claude.com/docs/en/plugins/components.md
- https://code.claude.com/docs/en/plugins/security.md
- https://code.claude.com/docs/en/plugins/overview.md

Changelog, releases and repos:

- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (2.1.287 to 2.1.293)
- GitHub releases API for v2.1.286, v2.1.287 and v2.1.293 (publishedAt)
- https://github.com/anthropics/claude-code/tree/main/mods (README, sec-default, agents-md, diff, telemetry)
- https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods
- https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-modernization/hooks/hooks.json
- https://github.com/anthropics/claude-code/issues/91870 (body and 245 comments; maintainer `poteat`)

Announcements:

- https://claude.com/blog/claude-code-mods
- https://claude.dev/blog/getting-started-with-claude-code-mods/ (Addy Osmani, 2026-10-01)

Local:

- `claude --version` → 2.1.293
- The bundled skill at `/private/tmp/claude-501/bundled-skills/2.1.293/4909ce0c69d3d08625f91ababc58b4b9/plugin-authoring/` (`SKILL.md`, `reference.md`, `examples/{tool-call.ts,band.tsx,pane.tsx}`, `types/claude-code.d.ts`, 21,293 lines, header "Written by Claude Code 2.1.293"). This is a temp path, rewritten each time the skill loads.
- `~/.claude/dev-mods/`

Community:

- https://github.com/karanb192/awesome-claude-code-mods
- https://github.com/ruvnet/ruflo (ADR-404, ADR-446, `v3/docs/validation/mod-capability-review-2026-10.md`, `scripts/bench-mods-latency.ts`, `plugins/*/hooks/hooks.json`)
- https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/experimental/claude-code-mods
- https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods
- GitHub search API: code `"modules" filename:hooks.json`, and repos `topic:claude-code-mod`, `"claude code mods"`

Background: `docs/research/hooks-tool-opportunity.md`, `agent-framework-hooks.md`, `hooks-session-bloat.md`.

## Unverified / not reached

- **Latency figures** come from ruflo only (one machine, one plugin). They were not reproduced here, and no mod was loaded in this session: no files were written under `~/.claude/dev-mods`.
- The **server-side rollout flag name** `tengu_plugin_hooks_modules` and its flapping behaviour are from ruflo ADR-404. The docs confirm only that a remote off switch exists.
- **Settings hooks in Desktop WSL sessions.** The docs say plugins (and so mods) don't run there. Whether settings-file hooks do was not checked.
- **Older clients and a `hooks.json` with `modules`.** It was not tested whether an older client ignores the key or errors on it, nor how the Codex and Gemini installers of cross-agent hook tools handle it.
- **npm dependencies in a hooks module.** The docs say a module imports "every file it imports from the plugin" with `import` declarations. Whether bare npm specifiers or `node_modules` resolve is not stated. My reading is that dependencies must be vendored.
- **Community counts.** The 2,690 mods (awesome-list scanner) and 3,176 `hooks.json` hits (GitHub code search, which is fuzzy and includes forks and templates) are approximate. I verified the hybrid `hooks` + `modules` layout only in `code-modernization` and the ruflo template. Other code-search hits were not opened.
- **The architecture PDF and demo videos** attached to #91870 were not read.
- **Other agents.** Whether OpenCode, Codex or Gemini have announced anything comparable to UI-capable in-process mods was not searched beyond the DeepSeek Harness bridge. OpenCode's in-process JS plugins are covered in `agent-framework-hooks.md`.
