# Is an open source hooks tool for coding agents worth building?

Researched 2026-09-14 and 2026-09-15. Demand-and-pain study: the primary sources are the GitHub issues, forum threads, and Hacker News posts themselves. Documented behaviour is cited to official docs or changelogs and kept separate from user reports. Reddit could not be reached (both WebSearch and WebFetch are blocked for reddit.com by the site), so that channel is unobserved; see "Unverified".

## Verdict

Yes, but narrowly. Demand for **hooks themselves** is very strong and vendor-confirmed: the Codex "Event Hooks" request is the single most-reacted item found (689 reactions, shipped), Gemini CLI's request drew 103 reactions and shipped, and OpenCode's open request for native Claude Code hook compatibility has 40 reactions with a top comment "after all this time we still dont have this?" (16 reactions). Demand for **tooling about hooks** is real but smaller and concentrated in one pain: hooks that silently do nothing. "Not firing" and "not triggered" are the most common hook bug shape across every agent, the Claude Code changelog is full of silent-failure fixes, and both Codex and Hermes have open issues asking for hook diagnostics. Nobody has built a well-adopted debugger, replay, or test harness for hooks (the closest, `felipeelias/hook-lab`, has 9 stars; `mherod/swiz` has replay but 3 stars). The cross-agent "write once, install everywhere" wedge has explicit demand but is already being attempted by four projects including one from a funded company (`speakeasy-api/agenthooks`), all with ≤6 stars, and vendors are converging on Claude Code's schema on their own. Registries and marketplaces are taken. The repos that actually reached thousands of stars are products *delivered through* hooks (Graft 7,805; Continuous-Claude 3,940; observability dashboards 1,536 and 674) and one tutorial repo (hooks-mastery 3,919), not hook infrastructure.

---

## 1. Pain points with hooks, per agent

Search method: GitHub REST search `hook in:title` per repo sorted by reactions (fetched 2026-09-14), plus body fetches of the top items. Counts are total matching issues and PRs; the top lists are issues only.

### Claude Code (`anthropics/claude-code`)

- 2,889 issues/PRs match `hook` in title; 320 open issues carry the `area:hooks` label. Keyword totals (title+body): "hook not triggered" 1,108; "hook not firing" 639; "hook timeout" 1,323; "hook additionalContext context" 560; "hook marketplace OR hook registry" 596; "hooks portable" 150.
- **Missing events / more surface** is the biggest cluster by reactions: waiting-for-input hook (#13024, +81, closed), user-interrupt hook (#9516, +66, open), Pre/PostPlanMode (#14259, +59, open), UserInputRequired (#10168, +55, closed), PostCompact (#14258, +48, closed), token usage in hook inputs (#11008, +31, open), UserInputChange (#82001, +16, open, 0 comments). https://github.com/anthropics/claude-code/issues/13024 https://github.com/anthropics/claude-code/issues/9516
- **Hooks that run but do nothing** is the biggest cluster by comment count: "Plugin hook output not captured or passed to agent" (#12151, +32, 24 comments, open): "hooks execute successfully (confirmed by file writes and success callbacks) but their output is not captured or passed to the agent's context." https://github.com/anthropics/claude-code/issues/12151 ; "Post/PreToolUse Hooks Not Executing" (#6305, +16, 40 comments, open, `area:hooks`) https://github.com/anthropics/claude-code/issues/6305 ; "SessionStart hooks not working for new conversations" (#10373, +19, 23 comments, open): "execute but their output is never processed or injected" https://github.com/anthropics/claude-code/issues/10373 ; "Plugin hooks not loaded from external hooks.json" (#16288, +19, 24 comments, open) https://github.com/anthropics/claude-code/issues/16288 ; "Cowork sessions ignore user hooks" (#40495, +21, open) https://github.com/anthropics/claude-code/issues/40495 ; "Skill-scoped hooks in SKILL.md frontmatter are not triggered within plugins" (#17688, +34, closed).
- **Misleading UI / no diagnostics**: "PreToolUse hook shows 'error' label even for successful (exit 0) hook runs" (#17088, +28, open). https://github.com/anthropics/claude-code/issues/17088
- **Surface-specific non-firing**: Notification hook in VS Code native UI (#8985, +67, closed; #11156, +30, closed), PermissionRequest in VS Code (#13203, +18, closed), Worktree hooks in Desktop (#29716, +24, open), Notification 10 s delay (#5186, +32, open), high latency for Notification hooks (#19627, +25, open).
- **Security gap**: "PreToolUse hooks not enforced on subagent tool calls" (#21460, +15, closed as fixed). https://github.com/anthropics/claude-code/issues/21460
- **Iteration friction**: "MCP servers, hooks, and plugins should auto-reload when config changes" (#24057, +20, 34 comments, open): "feels like rebooting Windows 95 every time you tweak a config." https://github.com/anthropics/claude-code/issues/24057
- **Transcript noise**: "Add quiet/silent option for async hooks" (#31595, +19, closed as shipped). https://github.com/anthropics/claude-code/issues/31595
- Maintainer response: the changelog shows steady fixes (see section 5). Many of the highest-reaction feature requests are closed as shipped.

### Codex CLI (`openai/codex`)

- 288 matches. "Event Hooks" (#2109, **+689**, 76 comments, closed as shipped). Top comment (+69): "Would encourage the Codex team to follow Claude Code's schema!" Another (+51): "hooks in the lifecycle will allow for advanced steering/context-engineering, and enterprise guardrailing." Maintainer (+31): "we will integrate it into the core agent loop so all Codex surfaces will benefit from it." https://github.com/openai/codex/issues/2109
- "Full Claude Code Hook Parity (29+)" (#21753, +47, 33 comments, open): "every hook payload is stable, typed, and documented ... hooks work consistently across CLI, TUI, Desktop, IDE, plugins, subagents, worktrees, resumes, compaction." https://github.com/openai/codex/issues/21753
- **Transcript/context noise** is the dominant Codex complaint: "suppressOutput is a no-op" (#15497, +29, closed) quoting the source `let _ = parsed.universal.suppress_output;` https://github.com/openai/codex/issues/15497 ; "Codex CLI renders hook additionalContext as visible developer message" (#16933, 16 comments, open) https://github.com/openai/codex/issues/16933 ; "collapse hook-injected context in the CLI transcript" (#20766, open) https://github.com/openai/codex/issues/20766 ; "Allow hook additionalContext to be model-visible but hidden from TUI" (#21696, open): "hard to use hooks for high-value background context without also filling the visible transcript with hook cards." https://github.com/openai/codex/issues/21696
- **Diagnostics**: "Hook failure messages should identify the failing hook and expose diagnostics" (#27052, open): "Which configured hook failed? Where was it configured? What command/script was executed? ... Did stdout contain invalid JSON, mixed logs, or no output?" https://github.com/openai/codex/issues/27052
- **Coverage gaps**: hooks only fire for Bash (#16732, closed; #20204 "most tools never emit hook events", open; #23411 Code Mode exec doesn't fire PreToolUse, open).
- **Trust/distribution**: wrapper-installed hooks blocked until manually approved in `/hooks` (#21615, open) https://github.com/openai/codex/issues/21615 ; "Hooks should support stable bundle/plugin context for reusable hook scripts" (#16466, open); "Hooks no longer run after Codex Desktop update" (#21639, 28 comments, open).

### Gemini CLI (`google-gemini/gemini-cli`)

- 361 matches. "Implement a Hooks System" (#2779, **+103**, closed as shipped): "I have to rely on complex prompts to enforce our team's standards ... which is unreliable and varies with the model's interpretation." https://github.com/google-gemini/gemini-cli/issues/2779
- Since shipping, activity is mostly maintainer PRs: docs for undocumented decision values (#28978, #28064), migration bugs (timeout seconds vs milliseconds #29125, wrong SubagentStop key #29124), subagent hook support (#18278, open), "Fix/hook debug noise" (#24128, open). Pain here reads as schema churn rather than user complaints.

### OpenCode (`anomalyco/opencode`)

- 387 matches. "Native Claude Code hooks compatibility (PreToolUse, PostToolUse, Stop)" (#12472, +40, 19 comments, open): "Users who run both Claude Code and OpenCode maintain hooks in `~/.claude/settings.json` that enforce guardrails." Top comment (+16, 2026-04-07): "after all this time we still dont have this? Seems like a pretty big deal..." Another: "especially useful in shared repos where some engineers are using Claude Code while others have opted for OpenCode." https://github.com/anomalyco/opencode/issues/12472
- "`permission.ask` plugin hook is defined but not triggered" (#7006, +26, open) https://github.com/anomalyco/opencode/issues/7006 ; "Plugin hooks don't intercept subagent tool calls - security policy bypass" (#5894, +9, closed) https://github.com/anomalyco/opencode/issues/5894 ; "`command.execute.before` hook errors leak to TUI" (#32253, +18, closed).

### Hermes Agent (`NousResearch/hermes-agent`)

- 889 matches, mostly PRs. Reactions are low (max +16). Pain shape: "hooks doctor reports a hook as healthy while the gateway cannot run it" (#90047, open): "doctor and the gateway are not looking at the same filesystem." https://github.com/NousResearch/hermes-agent/issues/90047 ; open fix PRs in Sept 2026: "register config hooks for serve" (#102513), "register configured hooks in TUI gateway and serve backends" (#111315), "keep fail-closed gates from permitting crashed hooks" (#102417). "PreToolUse enforcement hook" (#40662, 10 comments): "LLM doesn't follow system-prompt/memory rules under recency bias." https://github.com/NousResearch/hermes-agent/issues/40662

### Cursor (forum.cursor.com, Discourse search JSON, fetched 2026-09-14)

- "Project-specific hooks" (topic 139845, 8 posts, 10 likes, 2025-10-30): request for project-level hooks beyond global. https://forum.cursor.com/t/project-specific-hooks/139845
- "Cursor Hooks: Token Usage Support" (147216, 9 posts, 4 likes). https://forum.cursor.com/t/cursor-hooks-token-usage-support/147216
- Cursor CLI Jan 2026 update: "Hooks now execute in parallel with merged responses ... 10-20x faster." https://forum.cursor.com/t/cursor-cli-jan-8-2026-new-commands-and-performance-improvement/148372
- The most-liked "hooks" thread (167719, 78 likes) is about git hooks being skipped by the Source Control UI, not agent hooks; excluded.

### Table A: pain categories

| Category | Threads found (top-100 samples) | Top linked examples (engagement) | Maintainer status | Agents |
|---|---|---|---|---|
| Hook runs but output/effect is lost, or never fires | ≥12 across agents; 639–1,108 keyword matches in Claude Code alone | claude-code #12151 (+32, 24c), #6305 (+16, 40c), #10373 (+19, 23c), #16288 (+19, 24c); opencode #7006 (+26); hermes #90047 | Mostly open; changelog shows many related fixes | Claude Code, OpenCode, Hermes, Codex (#21639) |
| Missing events / surface gaps | ≥15 | claude-code #13024 (+81), #9516 (+66), #14259 (+59); codex #21753 (+47); codex #20204 | High-reaction ones shipped | All |
| Transcript / context noise from hooks | ≥7 | codex #15497 (+29), #16933, #20766, #21696; claude-code #31595 (+19) | Partly shipped (async quiet in Claude Code; Codex open) | Codex, Claude Code |
| No diagnostics / misleading UI | ≥4 | claude-code #17088 (+28); codex #27052; hermes #90047; gemini #24128 | Open | Claude Code, Codex, Hermes, Gemini |
| Subagent bypass (security) | 3 | claude-code #21460 (+15); opencode #5894 (+9); gemini #18278 | Fixed in Claude Code and OpenCode | Claude Code, OpenCode, Gemini |
| Iteration friction (restart to reload) | 2 | claude-code #24057 (+20, 34c); codex #17636 | Open | Claude Code, Codex |
| Cross-agent portability | 2 explicit | opencode #12472 (+40); codex #21753 (+47) and #2109 top comment (+69) | Open | OpenCode, Codex |
| Trust / distribution of third-party hooks | 3 | codex #21615, #16466, #16430 | Open | Codex |
| Schema churn / docs mismatch | ≥6 (mostly Gemini PRs) | gemini #28978, #28064, #29125, #29124 | Fixed as found | Gemini, Codex ("still experimental") |
| Matcher / semantics surprises | documented in changelog | Claude Code 2.1.191 (comma matchers never fired), 2.1.195 (substring match), 2.1.214 (exit 2 not blocking on bad JSON), 2.1.243 (`if` on `$()`) | Fixed | Claude Code |

## 2. Feature requests and wishlists

- **Parity / portability**: codex #21753 (+47), opencode #12472 (+40), codex #2109 top comment "follow Claude Code's schema" (+69).
- **Diagnostics / debugger**: codex #27052 (which hook failed, what it received, what it printed); claude-code #17088; hermes #90047. No thread found asking for a "hook debugger" by name; the ask is expressed as better error messages.
- **Hide from transcript but keep model-visible**: codex #21696, #20766; claude-code #31595 (shipped).
- **Hot reload**: claude-code #24057 (+20), codex #17636.
- **Reusable/bundled hook context**: codex #16466; plugin-local hooks codex #16430.
- **Trust flow for installer-managed hooks**: codex #21615.
- **Registry / marketplace**: no explicit high-engagement request found; 596 Claude Code items mention "marketplace" or "registry" alongside "hook", mostly about plugins generally.
- **Typed SDK / test harness**: no explicit requests found with engagement; the supply side exists (section 4).

## 3. Reddit and Hacker News

- **Reddit: not observed.** WebSearch returned `The following domains are not accessible to our user agent: ['reddit.com']` and WebFetch returned `unable to fetch from old.reddit.com` for r/ClaudeAI, r/ClaudeCode, and a site-wide query (2026-09-14).
- **Hacker News** (Algolia API, 2026-09-14): 41 stories match "claude code hooks"; a query for "agent hooks" OR "codex hooks" OR "cursor hooks" returned 0 hits. Most hook stories score ≤3 points. Above that: "Show HN: Real-time dashboard for Claude Code agent teams" (77 pts, 28 comments, 2026-04-01, `simple10/agents-observe`); "Show HN: Claude Code Plugin to play music when waiting on user input" (56 pts, 15c); "Graft – Claude Code hooks that cut grep tokens by 42%" (39 pts, 44c, 2026-08-14; the discussion is about benchmark honesty, not hooks); "Python utility package for building Claude Code hooks" (18 pts, 2c). "Ask HN: Is AI code assistance fundamentally unenforceable without hooks?" (4 pts, 2c, 2025-11-10): "The hard lesson: markdown instructions don't work. AI needs enforcement." https://news.ycombinator.com/item?id=45871445
- **Secondary proxy for the debugging pain**: at least six independent troubleshooting articles exist titled around "hook not firing" (dev.to ×3, alexdunlop.com decision tree, hookstack.app guide, claudelab.net). These are not primary evidence of behaviour, but their existence indicates a recurring question. https://dev.to/fewparts/claude-code-hook-not-firing-four-reasons-it-never-reaches-your-script-4mm6 https://www.alexdunlop.com/writing/claude-code-hook-not-firing https://www.hookstack.app/guides/claude-code-hooks-not-working

## 4. What already exists

Stars, forks, open issues, and last push from the GitHub API, 2026-09-14/15.

### Table B: existing tools

| Tool | What it does | Traction | Gaps covered | Gaps left |
|---|---|---|---|---|
| `speakeasy-api/agenthooks` (Go, MIT) | "Author coding-agent hooks once in Go; run them on Claude Code, Cursor, OpenAI Codex, Gemini CLI, OpenCode, Kimi Code, OpenClaw, GitHub Copilot CLI, and Copilot Chat." Normalized events with `Event.Raw`, Deny/Ask/Allow decisions, installer per provider. https://github.com/speakeasy-api/agenthooks | 3 stars, created 2026-07-04, pushed 2026-09-02 | Portability, schema normalization, install | Go only; no debugger; no adoption yet |
| `mherod/swiz` (TS) | Cross-agent hook manager: one manifest, 162 hooks / 17 events across Claude Code, Cursor, Gemini, Codex, Antigravity; `swiz dispatch <event> --replay <file>`; tool-name mapping (Bash→Shell→run_shell_command). https://github.com/mherod/swiz | 3 stars, 21 open issues, pushed 2026-09-14 | Portability, replay debugging | Adoption; Cursor CLI parity "no ETA" |
| `mherod/agent-hook-schemas` | Zod schemas for Claude Code, Codex, Copilot CLI, Gemini, Cursor, Antigravity | 1 star | Typed SDK | Adoption |
| `weykon/agent-hooks` (Rust) | Unified registration, 7 agents, JSONL normalization | 6 stars, pushed 2026-03-22 | Portability | Stalled |
| `sondera-ai/sondera-coding-agent-hooks` (Rust) | Hook binaries forwarding to a gRPC Cedar policy server; 10 adapters; fail-closed | 224 stars, 32 forks, pushed 2026-09-08 | Portability for *policy enforcement* | Requires their server; not a general layer |
| `o11y-dev/opentelemetry-hooks` | OTLP telemetry from hooks across agents | 35 stars | Observability export | No debugging UX |
| `hookstack.app` + `hookstack-cli` (MIT) | Registry of 106 hooks with installer; Claude Code, Copilot, Codex; "Ship fast. Break nothing." https://www.hookstack.app/ | count not visible | Registry, install, guides | Debugging, portability semantics |
| `agentplugins.net` (backed by `fcakyon/claude-codex-settings`) | Marketplace of skills/hooks/agents for Claude Code, Codex, Cursor, Gemini; 37 entries | 1,144 stars (backing repo) | Registry | Small catalog |
| `karanb192/claude-code-hooks` | Hooks plus installable plugin marketplace | 511 stars, pushed 2026-09-14 | Registry (Claude Code) | Single agent |
| Official Claude Code plugins | 5 of 13 official plugins ship hooks (`hookify`, `security-guidance`, `ralph-wiggum`, two output styles) https://github.com/anthropics/claude-code/tree/main/plugins | n/a | Vendor registry | n/a |
| `disler/claude-code-hooks-multi-agent-observability` | Real-time hook event monitoring | 1,536 stars, pushed 2026-02-08 | Observability dashboard | Not a debugger/test tool; single agent |
| `simple10/agents-observe` | Real-time observability of sessions | 674 stars, pushed 2026-09-04 | Observability | Single agent |
| `felipeelias/hook-lab` | "A web dashboard for watching Claude Code hook events in real time" | 9 stars, pushed 2026-09-05 | Debugging (watch) | No replay/test; tiny adoption |
| `GowayLee/cchooks` (Python), `beyondcode/claude-hooks-sdk` (PHP), `RasmusGodske/claude-hook-utils`, `timoconnellaus/define-claude-code-hooks`, `johnlindquist/cursor-hooks` | Typed SDKs | 130 / 68 / 31 / 16 / 7 stars; npm `cursor-hooks` 876 downloads/month, npm `claude-hooks` 345/month | Typed SDK | Fragmented by language and agent |
| `webdevtodayjason/claude-hooks` | Hooks manager CLI | 74 stars, last push 2025-07-10 | Manager | Abandoned |
| `disler/claude-code-hooks-mastery` | Tutorial repo | 3,919 stars, 637 forks, pushed 2026-03-04 | Education | n/a |
| `trailhq/Graft` | Product delivered via hooks for "Claude Code, Cursor, Codex, Gemini & every coding agent" | 7,805 stars in ~10 weeks (created 2026-07-03) | Proof that cross-agent hook-delivered products can get adoption | Not infrastructure |
| `parcadei/Continuous-Claude-v3` | Context management via hooks | 3,940 stars | Same | Same |
| Vendor-native | Claude Code: `/hooks` menu, `/doctor` exec-form hints (2.1.144), `--safe-mode` (2.1.169), VS Code Hooks dialog (2.1.269), spinner shows running hook with elapsed time (2.1.271); Hermes: `hermes hooks doctor`; Codex: `/hooks` trust UI | n/a | Config UI, basic diagnostics | Replay, cross-agent, test harness |

## 5. Demand signals

- **Vendor requests**: Codex #2109 (+689), Gemini #2779 (+103), OpenCode #1473 "Hooks support?" (+26) and #12472 (+40). All three vendors shipped or are shipping; Gemini CLI, Codex, and Cursor now have hook systems (see `agent-framework-hooks.md`).
- **Changelog velocity**: 225 of the Claude Code changelog's lines mention hooks across 395 versions; in the last ~6 months roughly 40 versions carry hook changes, with 2.1.271 alone listing five. https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- **Convergence**: Codex's parity tracker and "follow Claude Code's schema" comment; OpenCode's compatibility request; Cursor and Codex reuse Claude Code field names (prior research). This is both demand for portability and a threat to any layer that only translates names.
- **Star velocity of hook-adjacent repos**: Graft 7,805 in ten weeks; hooks-mastery 3,919; observability 1,536 and 674. Cross-agent *infrastructure* repos: 3, 3, 6, 1 stars; only Sondera (224) has traction, and it sells a policy server.
- **Package downloads**: small (npm `cursor-hooks` 876/month, `claude-hooks` 345/month). PyPI stats were unreachable (DNS) at fetch time.

## 6. Verdict and ranked wedges

| Wedge | Evidence strength | Already taken? | Notes |
|---|---|---|---|
| (b) Debugger / replay / observability for hooks: "show me exactly what each hook received, returned, how long it took, and what the agent did with it" | **Strongest.** The dominant bug shape everywhere is silent non-effect (Table A row 1), explicit asks in codex #27052 and hermes #90047, six third-party troubleshooting guides, and changelog fixes for silently-ignored matchers and JSON | Partially: `hook-lab` (9 stars), `swiz --replay` (3 stars), dashboards (1.5k, 674) that observe but do not diagnose | Cross-agent from day one turns this into the natural home for (a). Vendor risk is real: Claude Code added spinner feedback and a VS Code dialog in Sept 2026 |
| (c) Test harness / local runner: run a hook against captured or synthetic payloads for each agent, assert on decision and injected context | Strong by inference (same pain), weak by explicit request (none found) | No | Pairs with (b); fixtures per agent schema are the moat and the maintenance burden |
| (a) Cross-agent portable hook format + installer | Explicit demand (opencode #12472 +40, codex #21753 +47) | Yes, four attempts, one by Speakeasy; all ≤6 stars | Either too early or users prefer native. Vendors converging on the same schema shrinks the translation value; residual value is normalizing divergences (exit semantics, fail-open/closed, tool-name maps) |
| (d) Registry / manager | Weak explicit demand | Yes: HookStack (106 hooks), agentplugins.net, karanb192 marketplace, official plugin marketplace | Low differentiation |
| (e) Typed SDK | Weak | Yes, fragmented by language | Commodity |
| (f) Context-hygiene tooling: measure what hooks inject per turn and how much it costs | Moderate (codex #15497 +29, #16933, #20766, #21696; prior `hooks-session-bloat.md`) | No standalone tool | Better as a feature of (b) than a product |

**Answer**: worth building if the wedge is (b)+(c), a cross-agent hook debugger and test runner, with (f) as a feature. Not worth building as another portability layer or registry.

## Risks

- **Vendors ship it natively.** Claude Code shipped `/doctor` hints, `--safe-mode`, a VS Code Hooks dialog, and live hook spinners within the last six months; Hermes has `hooks doctor`; Codex has a `/hooks` trust UI. A debugger must stay ahead by being cross-agent and by replay/test, which no vendor has reason to build for competitors' agents.
- **Schema churn.** Codex maintainers: "It's all still experimental, but shaping up fast" (#2109 comment, +28). Gemini shipped migration bugs for its own hooks. Fixtures will rot without per-agent conformance tests.
- **Small audience for infrastructure.** HN hook stories mostly score ≤3; cross-agent infra repos have single-digit stars; package downloads are in the hundreds per month. The audience that pays attention is the one that already writes hooks.
- **Reddit unobserved.** The largest practitioner forum was unreachable; the picture could shift if Reddit shows pain not represented on GitHub.

## Sources (fetched 2026-09-14 unless noted)

GitHub search API `search/issues` for `repo:<r> hook in:title` sorted by reactions: anthropics/claude-code, openai/codex, google-gemini/gemini-cli, anomalyco/opencode, NousResearch/hermes-agent. Issue bodies: claude-code #12151 #6305 #17088 #24057 #21460 #31595 #13024 #9516 #16288 #10373 #40495 #82001; codex #2109 (+comments) #21753 #15497 #27052 #20766 #21696 #16933 #21615 #16466; opencode #12472 (+comments) #7006 #5894; gemini-cli #2779; hermes-agent #40662 #90047. Label counts via `search/issues label:"area:hooks"`. Repo metadata via `repos/<owner>/<name>` for every tool in Table B. `gh search repos` for "claude code hooks", "agent hooks", "codex hooks", "cursor hooks", "hooks claude codex gemini cursor". CHANGELOG.md raw via contents API. Official plugins directory listing via contents API.
- https://hn.algolia.com/api/v1/search?query="claude code hooks"&tags=story ; items/49299985 ; items/45871445 ; cross-agent query (0 hits)
- https://forum.cursor.com/search.json?q=hooks%20order%3Alikes
- https://github.com/speakeasy-api/agenthooks ; https://github.com/mherod/swiz ; https://www.hookstack.app/ ; https://agentplugins.net/
- https://api.npmjs.org/downloads/point/last-month/{cursor-hooks,claude-hooks}
- WebSearch: "claude code hooks reddit frustrating OR bloat OR not firing OR debugging"; "hooks manager OR debugger OR registry for coding agents ..." (2026-09-15)
- Background: `docs/research/agent-framework-hooks.md`, `docs/research/hooks-session-bloat.md`

## Unverified / open questions

- Reddit (r/ClaudeAI, r/ClaudeCode, r/cursor, r/codex) was unreachable; no Reddit evidence is included.
- `claude --debug-file` logging hook execution is reported by a dev.to article, not verified against the official docs here.
- HookStack's GitHub stars and download counts were not visible on the fetched page.
- PyPI download counts for `cchooks` and `claude-hook-utils` (pypistats.org DNS failure).
- Whether Codex's schema reuse is an intentional compatibility commitment (docs make no claim).
- Cursor forum search returned only five topics; Discourse search may cap results.
