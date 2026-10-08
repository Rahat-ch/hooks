# Agent frameworks vs. coding-agent hooks: is LangChain/LangGraph/AutoGen/CrewAI a foundation for a cross-agent hooks layer?

Researched 2026-09-14 against primary sources only (official docs and GitHub repos). Doc versions are noted where a page showed one; most pages do not.

## Verdict (one paragraph)

No. LangChain, LangGraph, AutoGen, CrewAI (and the comparable OpenAI Agents SDK, Google ADK, Pydantic AI, Semantic Kernel, smolagents, Vercel AI SDK) are frameworks for **building** an agent: you instantiate the model, tools and loop inside their runtime, and every hook they offer (`before_model`, `wrap_tool_call`, `interrupt()`, `InterventionHandler`, `@on(PRE_TOOL_CALL)`, `before_tool_callback`, `RunHooks`, filters) is a Python/TS callable that lives inside that runtime's process and is invoked by that runtime's loop. Claude Code, Codex CLI, Gemini CLI, Cursor, OpenCode, Hermes and Aider each **own their own loop** and expose hooks the other way round: as declarative config (JSON/TOML/YAML) that names an event and a shell command (or, for OpenCode/Hermes, a plugin module) which the agent spawns with a JSON payload on stdin and reads a decision from stdout/exit code. Nothing in the agent-building frameworks can subscribe to a third-party agent's loop, so they contribute no runtime to a cross-agent hooks layer. What they *do* offer is vocabulary and semantics worth copying: the before/after/wrap triad, "return None to proceed / return a value to override", `jump_to`-style short-circuits, approve/edit/reject decisions for tool calls, and the fail-open/fail-closed distinction. The evidence also shows a real common denominator among coding agents (pre/post tool, user prompt, session start/end, stop, pre-compact; JSON on stdin; exit 0 = JSON decision, exit 2 = block) that Codex and Cursor have copied nearly verbatim from Claude Code, while Gemini CLI, OpenCode and Hermes diverge in names and transport. A handful of small projects already build adapters over these native surfaces.

---

## 1. What each framework is for

| Framework | Self-description (quoted) | Builds agents or controls existing agents? |
|---|---|---|
| LangChain (Python, `create_agent`) | "Agent = Model + Harness. LangChain provides `create_agent`: a minimal, highly configurable harness. The harness is everything around the model loop: the prompt, the tools, and any middleware that shapes behavior." https://docs.langchain.com/oss/python/langchain/overview | Builds. You own the loop (the harness *is* the loop). |
| LangGraph | "a low-level orchestration framework and runtime for building, managing, and deploying long-running, stateful agents"; "LangGraph does not abstract prompts or architecture"; "you don't need to use LangChain to use LangGraph". https://docs.langchain.com/oss/python/langgraph/overview | Builds. Graph nodes are your code. |
| AutoGen (Microsoft) | "AutoGen is a framework for creating multi-agent AI applications that can act autonomously or work alongside humans." Layers: Core (event-driven runtime), AgentChat, Extensions, Studio. https://microsoft.github.io/autogen/stable/index.html . **Maintenance mode**: "AutoGen is now in maintenance mode. It will not receive new features or enhancements and is community managed going forward. New users should start with Microsoft Agent Framework." https://github.com/microsoft/autogen | Builds. Agents are created and managed by its runtime ("Agents are not directly instantiated and managed by application code. Instead, they are created by the runtime"). https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/agent-and-agent-runtime.html |
| CrewAI | "the leading open-source framework for orchestrating autonomous AI agents and building complex workflows"; Flows are "the 'manager' or the 'process definition'", Crews are "the 'teams' that do the heavy lifting". https://docs.crewai.com/en/introduction | Builds. Agents/tasks/crews are CrewAI objects. |
| OpenAI Agents SDK | "enables you to build agentic AI apps in a lightweight, easy-to-use package with very few abstractions"; primitives are Agents, Handoffs, Guardrails, Sessions, Tracing; "a built-in loop that continues until the task is complete". https://openai.github.io/openai-agents-python/ | Builds. Runner owns the loop. |
| Google ADK | "ADK is the open-source agent development framework that lets you build, debug, and deploy reliable AI agents at enterprise scale." Python, TypeScript, Go, Java, Kotlin. https://adk.dev/ | Builds. Runner owns the loop. |
| Pydantic AI | "the Python AI SDK: a typed, extensible agent loop with every model a string swap away". https://pydantic.dev/docs/ai/ | Builds. |
| Semantic Kernel | Filters "provide control and visibility over how and when functions run" inside the Kernel. https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/filters (page dated 2026-04-29) | Builds. Filters attach to a `Kernel` instance you construct. |
| smolagents (Hugging Face) | "Smolagents is an experimental API"; agents "inherit from MultiStepAgent … each step consisting of one thought, then one tool call and execution." https://huggingface.co/docs/smolagents/main/en/reference/agents | Builds. |
| Vercel AI SDK (7.x) | Agent loop control via `ToolLoopAgent`, `stopWhen`, `prepareStep`; "ToolLoopAgent stops after 20 steps using isStepCount(20)". https://ai-sdk.dev/docs/agents/loop-control | Builds. |

Every one of these assumes you are writing the program that calls the model. None documents a way to attach to an agent process it did not create.

---

## 2. Framework hook / callback / middleware / interrupt primitives

### LangChain (`create_agent` middleware)

Source: https://docs.langchain.com/oss/python/langchain/middleware and https://docs.langchain.com/oss/python/langchain/middleware/custom (fetched 2026-09-14; no version string on page).

- "Middleware provides a way to more tightly control what happens inside the agent." "Middleware exposes hooks before and after each of those steps."
- Node-style hooks: `@before_agent`, `@before_model`, `@after_model`, `@after_agent`. Each receives `AgentState` and `Runtime`, returns `dict | None` (state updates applied via graph reducers) plus optional `jump_to` with values `"end"`, `"tools"`, `"model"`. `before_agent`/`before_model`/`after_model` can short-circuit via `jump_to`; `after_agent` cannot.
- Wrap-style hooks: `@wrap_model_call(request, handler)` returns `ModelResponse`; can modify the `ModelRequest` via `request.override()` (system message, model, tools) and decide whether `handler()` runs "zero, once, or multiple times". `@wrap_tool_call(request, handler)` returns `ToolMessage | Command`; can modify tool-call arguments and "bypass or modify tool execution". `@dynamic_prompt` is a convenience wrapper around `wrap_model_call`.
- Built-ins (https://docs.langchain.com/oss/python/langchain/middleware/built-in): `HumanInTheLoopMiddleware` ("Pause execution for human approval of tool calls", decisions `approve`/`edit`/`reject`, requires `interrupt_on` config and a checkpointer), `SummarizationMiddleware`, `ModelCallLimitMiddleware`, `ToolCallLimitMiddleware`, `PIIMiddleware`, `ModelFallbackMiddleware`, `ToolRetryMiddleware`, `ModelRetryMiddleware`, `ToolErrorMiddleware`, `ContextEditingMiddleware`, `ShellToolMiddleware`, `FilesystemMiddleware`, `TodoListMiddleware`, `LLMToolSelectorMiddleware`, `SubAgentMiddleware`, `RubricMiddleware`, and others.
- Capability: BLOCK yes (`jump_to: "end"`, or `wrap_tool_call` not calling `handler`), MODIFY input and output yes, INJECT context yes (state updates, `request.override()`). Deterministic code. Synchronous, inline in the loop.

### LangChain callbacks (legacy observability surface)

Source: https://reference.langchain.com/python/langchain_core/callbacks/ and https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/callbacks/base.py

- `BaseCallbackHandler` / `AsyncCallbackHandler` methods: `on_llm_start`, `on_chat_model_start`, `on_llm_new_token`, `on_llm_end`, `on_llm_error`, `on_chain_start`, `on_chain_end`, `on_chain_error`, `on_tool_start`, `on_tool_end`, `on_tool_error`, `on_text`, `on_retry`, `on_agent_action`, `on_agent_finish`, `on_retriever_*`, `on_custom_event`. Attributes `raise_error: bool = False` ("Whether to raise an error if an exception occurs"), `run_inline: bool = False` ("Whether to run the callback inline"), and `ignore_llm` / `ignore_chain` / `ignore_agent` / `ignore_retriever` / `ignore_chat_model` / `ignore_custom_event` / `ignore_retry` properties.
- The source docstrings are one-liners ("Base callback handler.") and contain no statement that a return value affects execution. The conceptual page at `python.langchain.com/docs/concepts/callbacks` now redirects to the v1 overview, and `docs.langchain.com/oss/python/langchain/callbacks` returned 404 on 2026-09-14. **Unverified**: a current doc sentence stating callbacks are observational only. From the API shape (methods return `None`/`Any` with no documented control effect), treat them as observational; control lives in middleware.

### LangGraph

Source: https://docs.langchain.com/oss/python/langgraph/interrupts

- `interrupt(value)`: "saves the graph state using its persistence layer and waits indefinitely until you resume execution." Requires "A checkpointer to persist the graph state (use a durable checkpointer in production)."
- Resume with `Command(resume=value)`; the value "becomes the return value of the interrupt() call"; "the node restarts from the beginning of the node where the interrupt was called when resumed, so any code before the interrupt runs again."
- Static breakpoints: `graph.compile(interrupt_before=[...], interrupt_after=[...], checkpointer=...)`, resume with `graph.invoke(None, config=config)`.
- Routing: `Command(goto="proceed")` / `Command(goto="cancel")`. Tool-call approval: "Place `interrupt()` inside a `@tool` function to pause before execution."
- Rules: never wrap `interrupt()` in bare try/except; keep call order deterministic (index-matched on resume); make pre-interrupt side effects idempotent; JSON-serializable payloads only.
- No `before`/`after` node hooks are documented on this page; the equivalents are `interrupt_before`/`interrupt_after` breakpoints and LangChain's middleware layered on top.
- Capability: BLOCK yes (pause + `goto`), MODIFY yes (edit state on resume), INJECT yes. Deterministic code, but resumption requires an external caller to re-invoke with `Command(resume=...)`. Synchronous within the graph run.

### AutoGen (0.4+ Core / AgentChat)

Sources: https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/cookbook/tool-use-with-intervention.html ; https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html ; https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html

- Core: `InterventionHandler` (`DefaultInterventionHandler` base) with `on_send(message, message_context, recipient)`; returns the (possibly modified) message or `DropMessage`. Registered as `SingleThreadedAgentRuntime(intervention_handlers=[ToolInterventionHandler()])`. The cookbook gates tool execution by detecting a `FunctionCall` message, prompting "Do you want to execute the tool? (y/n)", and raising `ToolException(content='User denied tool execution.')` otherwise. (`on_publish` / `on_response` are not shown on that page; **unverified** here.)
- AgentChat: `run()` / `run_stream()`; "Unlike in v0.2 AgentChat, the tools are executed by the same agent directly within the same call to `run()`". No pre-tool intercept hook is documented on the agents tutorial page.
- Termination conditions: `MaxMessageTermination`, `TextMentionTermination`, `TokenUsageTermination`, `TimeoutTermination`, `HandoffTermination`, `ExternalTermination`, `StopMessageTermination`, `FunctionCallTermination`, `SourceMatchTermination`, `TextMessageTermination`, `FunctionalTermination`; composable with `&` and `|`. They stop a team; they do not block a tool.
- Capability: BLOCK yes at Core message level (`DropMessage`, raise), MODIFY message yes, INJECT via message mutation. Deterministic code. Synchronous. Project is in maintenance mode (see §1).

### CrewAI

Sources: https://docs.crewai.com/en/learn/execution-hooks ; https://docs.crewai.com/en/concepts/crews ; https://docs.crewai.com/en/concepts/tasks

- Unified `@on(InterceptionPoint.X)` decorator: "one registration API and one contract cover every interception point in the framework." Hooks are synchronous callables with a typed `ctx`. Four outcomes: return `None` to proceed; mutate `ctx.payload` in place; return non-`None` to replace the payload; `raise HookAborted(reason, source)` to abort. Points include `EXECUTION_START`, `INPUT`, `OUTPUT`, `EXECUTION_END`, `PRE_MODEL_CALL`, `POST_MODEL_CALL`, `PRE_TOOL_CALL`, `POST_TOOL_CALL`, `PRE_STEP`, `POST_STEP`. Filters: `@on(InterceptionPoint.PRE_TOOL_CALL, agents=["researcher"], tools=["web_search"])`. Global hooks run first, then execution-scoped; "Legacy hooks registered for the same point participate in the same chain."
- Legacy decorators `@before_llm_call`, `@after_llm_call`, `@before_tool_call`, `@after_tool_call` "are adapters over the same dispatcher". Before-hooks `return False` to block, `None`/`True` to allow; after-hooks return a modified string. `ToolCallHookContext` exposes `tool_input` (mutable in place), `tool_name`, `agent`, `task`, `crew`; `LLMCallHookContext` exposes `messages`, `iterations`, `agent`, `task`, `crew`.
- Crew-level: `before_kickoff_callbacks` ("Each callback receives and can modify the inputs dict"), `after_kickoff_callbacks` (can modify `CrewOutput`), `step_callback` ("called after each step of every agent"), `task_callback` ("called after the completion of each task"); `@before_kickoff` / `@after_kickoff` decorators exist.
- Task guardrails: function `(task_output) -> (bool, Any)`, or a string that becomes an `LLMGuardrail` "that uses the agent's LLM to validate the output"; sequential `guardrails` list; on failure "the error is sent back to the agent, and the task is retried up to `guardrail_max_retries` times". `human_input=True` for human review.
- Capability: BLOCK yes, MODIFY yes, INJECT yes. Deterministic code (function guardrails/hooks) or model-driven (string guardrails). Synchronous.

### OpenAI Agents SDK

Sources: https://openai.github.io/openai-agents-python/ref/lifecycle/ ; https://openai.github.io/openai-agents-python/guardrails/ ; https://openai.github.io/openai-agents-python/human_in_the_loop/

- `RunHooks` / `AgentHooks`: async methods `on_agent_start`, `on_agent_end`, `on_handoff`, `on_tool_start`, `on_tool_end`, `on_llm_start`, `on_llm_end`, all returning `None`. Observational only.
- Guardrails: input guardrails "run only for the first agent in the chain" and by default "run concurrently with the agent's execution" (a blocking mode exists that "runs and completes before the agent starts"); output guardrails run after the final output. Tool guardrails: input tool guardrails "run before the tool executes and can skip the call, replace the output with a message, or raise a tripwire"; output tool guardrails "can replace the output or raise a tripwire". A tripwire raises `InputGuardrailTripwireTriggered` / `OutputGuardrailTripwireTriggered` and "halts agent execution". Guardrails do not modify inputs.
- Tool approval: "Set `needs_approval` to `True` to always require approval or provide an async function that decides per call." Paused runs surface `RunResult.interruptions`; "Convert the result to a `RunState` with `result.to_state()`, call `state.approve(...)` or `state.reject(...)`, and then resume with `Runner.run(agent, state)`".
- Capability: BLOCK yes (tripwires, `needs_approval`), MODIFY tool output yes (tool guardrails), tool input no. Deterministic code (or model-driven if the guardrail itself calls a model). Hooks observational; guardrails inline (input ones parallel by default).

### Google ADK

Sources: https://adk.dev/callbacks/types-of-callbacks/ ; https://adk.dev/plugins/

- Agent-level callbacks: `before_agent_callback`, `after_agent_callback`, `before_model_callback` (receives `CallbackContext`, `LlmRequest`; return `None` to proceed with possibly-modified request, or `LlmResponse` to skip the LLM), `after_model_callback`, `on_model_error_callback`, `before_tool_callback` (receives `tool`, `args`, `ToolContext`; return falsy to proceed, or a dict to skip the tool and use it as result), `after_tool_callback` (return dict to override result), `on_tool_error_callback`. Lists of callbacks are chained: "ADK invokes them in the order listed and stops at the first one that returns a result."
- Plugins (`BasePlugin`): "a custom code module that can be executed at various stages of an agent workflow lifecycle using callback hooks"; registered "once on the Runner and its callbacks apply globally to every agent, tool, and LLM call"; adds `on_user_message_callback`, `before_run_callback`, `after_run_callback`, `on_event_callback`; "Plugin callbacks run before Agent Callbacks".
- Capability: BLOCK yes (return a value to skip), MODIFY yes (mutate `LlmRequest`/`args`, override results), INJECT yes. Deterministic code. Synchronous.

### Pydantic AI

Source: https://pydantic.dev/docs/ai/core-concepts/agent/ (the `/deferred-tools/` page 404'd on 2026-09-14)

- `@agent.output_validator`, tool `prepare` functions, `history_processors` (transform message history before each model call), `agent.iter()` (exposes graph nodes `UserPromptNode`, `ModelRequestNode`, `CallToolsNode`, `End`), `ModelRetry`, `requires_approval=True` tools emitting `DeferredToolRequests` that pause the run, `event_stream_handler`, `UsageLimits` (`tool_calls_limit`, raises `UsageLimitExceeded`).
- Capability: BLOCK yes (approval-required tools, `iter()` control), MODIFY yes (`history_processors`, `output_validator`), INJECT yes. Deterministic code. Synchronous.

### Semantic Kernel

Source: https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/filters

- `IFunctionInvocationFilter` / `FilterTypes.FUNCTION_INVOCATION`, `IPromptRenderFilter` / `PROMPT_RENDERING`, `IAutoFunctionInvocationFilter` / `AUTO_FUNCTION_INVOCATION`. Each gets a `context` and a `next` delegate: "Without calling `next`, the operation will not be executed." Filters can override the function result before or after execution, modify `rendered_prompt`, and set `context.terminate = True` to stop auto function calling.
- Capability: BLOCK yes, MODIFY yes, INJECT yes. Deterministic code. Synchronous pipeline.

### smolagents

Source: https://huggingface.co/docs/smolagents/main/en/reference/agents

- `step_callbacks` ("Callbacks that will be called at each step"), `final_answer_checks` (functions taking final answer, memory, agent and returning bool), `planning_interval`, `max_steps`, `agent.interrupt()` ("Interrupts the agent execution").
- Capability: BLOCK (final-answer rejection, `interrupt()`); modification of tool calls is not documented on this page.

### Vercel AI SDK (7.x)

Source: https://ai-sdk.dev/docs/agents/loop-control

- `stopWhen` with `isStepCount`, `hasToolCall`, `isLoopFinished`; `prepareStep` runs before each step and can change model, `activeTools`, `toolChoice`, model settings and messages ("if you return a messages override, that override persists as the base for later steps"). "A tool call needs approval" is listed as a loop-stop condition; `needsApproval` details are on a page that 404'd (**unverified**).

### Table A: frameworks

| Framework | Purpose | Owns the loop? | Hook primitives | Block / Modify / Inject | Sync vs observational |
|---|---|---|---|---|---|
| LangChain `create_agent` | Agent harness | Yes (yours) | `before_agent`, `before_model`, `after_model`, `after_agent`, `wrap_model_call`, `wrap_tool_call`, `dynamic_prompt`, built-in `HumanInTheLoopMiddleware` etc.; legacy `on_*` callbacks | B yes (`jump_to`, skip handler) / M yes / I yes | Middleware sync inline; callbacks observational |
| LangGraph | Low-level graph runtime | Yes | `interrupt()`, `Command(resume/goto)`, `interrupt_before/after`, checkpointer | B yes / M yes / I yes | Sync; resume from outside |
| AutoGen (maintenance mode) | Multi-agent apps | Yes (runtime) | `InterventionHandler.on_send` → `DropMessage`; termination conditions | B yes (message level) / M yes / I yes | Sync |
| CrewAI | Crews + Flows orchestration | Yes | `@on(InterceptionPoint.*)`, legacy `@before/after_llm_call`, `@before/after_tool_call`, kickoff callbacks, `step_callback`, `task_callback`, guardrails | B yes / M yes / I yes | Sync; guardrails may be LLM-driven |
| OpenAI Agents SDK | Lightweight agent apps | Yes (Runner) | `RunHooks`/`AgentHooks` (`on_*`), input/output/tool guardrails, `needs_approval` | Hooks: none; guardrails B yes, M tool output only; approval B yes | Hooks observational; guardrails inline (input ones parallel by default) |
| Google ADK | Enterprise agent framework | Yes (Runner) | `before/after_agent/model/tool_callback`, `on_*_error_callback`, Plugins (`before_run`, `on_user_message`, `on_event`) | B yes / M yes / I yes | Sync |
| Pydantic AI | Typed agent loop | Yes | `output_validator`, `history_processors`, `iter()`, `requires_approval`, `event_stream_handler`, `UsageLimits` | B yes / M yes / I yes | Sync |
| Semantic Kernel | Kernel + filters | Yes | function-invocation / prompt-render / auto-function-invocation filters with `next` | B yes / M yes / I yes | Sync pipeline |
| smolagents | ReAct code agents | Yes | `step_callbacks`, `final_answer_checks`, `interrupt()` | B partial / M not documented | Sync |
| Vercel AI SDK | TS agent loop | Yes | `stopWhen`, `prepareStep`, tool approval | B yes / M yes (per step) | Sync |

---

## 3. Coding agents' native hook surfaces

### Claude Code

Source: https://code.claude.com/docs/en/hooks (fetched 2026-09-14)

- Events: `SessionStart`, `SessionEnd`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `Notification`, `MessageDisplay`, `Elicitation`, `ElicitationResult`.
- Config: `hooks` object in `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy settings, plugin `hooks/hooks.json`, skill/subagent frontmatter. Structure: event → `[{matcher, hooks:[{type, command|url|server+tool|prompt, timeout, if, statusMessage, once, async}]}]`. Matchers are exact/`|`-lists or JS regex; `"*"`/`""`/omitted match all.
- Handler types: `command` (shell; exec form with `args` or shell form), `http` (POST JSON), `mcp_tool` (call a tool on a connected MCP server), `prompt` (single-turn model evaluation), `agent` (spawn a tool-using subagent, experimental).
- Transport: JSON on stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, tool fields…); decision via exit code + stdout JSON.
- Exit codes: `0` → stdout parsed as JSON decision if valid, plain text added as context; `2` → "Exit 2 is the way a hook signals 'stop, don't do this.'" (blocks on `PreToolUse`, `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `SubagentStop`, `PreModelSwitch`; stderr shown to the model/user); other → non-blocking error, action proceeds.
- JSON output: `continue`, `stopReason`, `systemMessage`, `hookSpecificOutput.{permissionDecision: allow|deny|ask, permissionDecisionReason, updatedInput, additionalContext}`; `PermissionRequest` uses a `decision` object; `PermissionDenied` supports `retry: true`.
- Modify tool input: yes, `updatedInput` on `PreToolUse` (and `UserPromptExpansion`). Inject context: yes, `additionalContext` on `UserPromptSubmit`, `PostToolUse`, etc.
- Timeouts: 600 s default for command/http/mcp_tool (30 s on `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch`; 10 s on `MessageDisplay`), 30 s `prompt`, 60 s `agent`. "All matching hooks run in parallel."

### OpenAI Codex CLI

Sources: https://learn.chatgpt.com/docs/hooks (redirect target of https://developers.openai.com/codex/hooks) ; https://learn.chatgpt.com/docs/config-file/config-reference (redirect target of https://developers.openai.com/codex/config-reference)

- Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `Interrupt`, `SessionStart`, `SubagentStart`, `SessionEnd`.
- Config: `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`; `<repo>/.codex/hooks.json` or inline `[hooks]` in `<repo>/.codex/config.toml`; plugin `hooks/hooks.json`. "Lifecycle hooks configured inline in config.toml. Uses the same event schema as hooks.json." "Project-local hooks load only when the project `.codex/` layer is trusted." Feature flag `[features] hooks = true|false` (`codex_hooks` deprecated alias); admins can set `allow_managed_hooks_only = true` in `requirements.toml`.
- Handler types: `command` and `mcp_tool`; "The `prompt` and `agent` handlers are parsed but skipped."
- Transport: JSON stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`; turn-scoped add `turn_id`, `permission_mode`). Output: `continue`, `stopReason`, `systemMessage`, `additionalContext`, `hookSpecificOutput.{permissionDecision: allow|deny|ask, permissionDecisionReason, updatedInput}`; `PostToolUse` also accepts legacy `decision: "block"`.
- Exit codes: `0` success (JSON parsed, plain text added as context), `2` blocking (reason from stderr), other = failure but operation continues.
- Matchers: regex on tool name for `PreToolUse`/`PostToolUse`/`PermissionRequest`; trigger for compact events; source for `SessionStart`; not supported on `UserPromptSubmit`, `Stop`, `Interrupt`.
- Timeouts: 600 s default; `SessionEnd`/`Interrupt` 1 s (max 3).
- Trust: "Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition. Codex records trust against the hook's current hash." `/hooks` manages trust; `--dangerously-bypass-hook-trust` for automation.
- Adjacent controls: `notify` = "Command invoked for notifications; receives a JSON payload from Codex." (e.g. `agent-turn-complete`); `approval_policy` = `on-request | never | { granular = {...} }` (`untrusted` deprecated); `sandbox_mode` = `read-only | workspace-write | danger-full-access`.
- The Codex hooks doc makes no statement about Claude Code compatibility; the event names and JSON fields are nonetheless the same strings.

### Gemini CLI

Source: https://geminicli.com/docs/hooks/reference/ (mirrors https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)

- Events: `BeforeTool`, `AfterTool`, `BeforeAgent` ("after a user submits a prompt, but before the agent begins planning"), `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `SessionStart`, `SessionEnd`, `Notification`, `PreCompress`.
- Config: `hooks` in `settings.json` (`~/.gemini/settings.json`, `.gemini/settings.json`): event → `[{matcher, sequential, hooks:[{type:"command", command, name, timeout, description}]}]`. Matchers are regex/exact on tool name (`read_.*`, `mcp_<server>_<tool>`).
- Transport: JSON stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`). Output: `decision: allow|deny` (alias `block`), `reason`, `systemMessage`, `continue`, `suppressOutput`, `hookSpecificOutput` with `tool_input` ("merges with and overrides" model arguments on `BeforeTool`), `additionalContext` (`AfterTool`, `BeforeAgent`), `llm_request` (override outgoing request), `llm_response` (synthetic response, skips LLM), `toolConfig: {mode, allowedFunctionNames}`.
- Exit codes: `0` success (JSON parsed; "the preferred code for all logic, including intentional blocks"); `2` "System Block"; other = warning, continue.
- Blocking events: `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`. Advisory only: `SessionStart`, `SessionEnd`, `Notification`, `PreCompress`.

### Cursor

Source: https://cursor.com/docs/agent/hooks

- Events: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`; Tab: `beforeTabFileRead`, `afterTabFileEdit`; app: `workspaceOpen`.
- Config: `~/.cursor/hooks.json`, `<project>/.cursor/hooks.json`, enterprise system dirs, team dashboard. `{"version": 1, "hooks": {"<event>": [{"command": "./script.sh", "timeout": N, "failClosed": bool}]}}`.
- Transport: "Hooks are spawned processes that communicate over stdio using JSON in both directions."
- Output: `permission: allow|deny|ask`; `user_message`, `agent_message`, `additional_context`, `updated_input` (replace tool input on `preToolUse`), `followup_message` (auto-submit next message on `stop`/`subagentStop`). Exit code `2` also blocks; non-zero without `failClosed: true` lets the action through.

### OpenCode

Source: https://opencode.ai/docs/plugins/

- Plugins are "JavaScript/TypeScript modules" in `.opencode/plugins/` or `~/.config/opencode/plugins/`, or npm packages listed in `opencode.json`. A plugin exports a function receiving `{project, client, $, directory, worktree}` and returning a hooks object.
- Hooks: `tool.execute.before`, `tool.execute.after`, `chat.message`, `chat.params`, `permission.ask`, `event` (bus events such as `session.created`, `session.compacted`, `session.idle`, `session.error`, `file.edited`, `message.updated`, `command.executed`, `permission.asked`, `lsp.client.diagnostics`), `shell.env`, `experimental.session.compacting`.
- Block by throwing: `throw new Error("Do not read .env files")`. Modify by mutating `output.args` (e.g. `output.args.command = escape(output.args.command)`). Inject context via `output.context.push(...)` in the compaction hook.
- Transport: in-process JS function calls, not shell/JSON.

### Aider

Sources: https://aider.chat/docs/usage/lint-test.html ; https://aider.chat/docs/git.html

- No general hook system. `--lint-cmd <cmd>` / auto-lint ("By default, aider will lint any files which it edits"; disable with `--no-auto-lint`); `--test-cmd` with `--auto-test` runs "after each time the AI edits your code"; on non-zero exit "aider will try and fix any errors". Auto-commits on by default (`--no-auto-commits`, `--no-dirty-commits`); `--git-commit-verify` re-enables git pre-commit hooks (aider uses `--no-verify` by default).
- The only "hook" points are therefore: post-edit lint/test commands (deterministic, output fed back to the model) and git pre-commit hooks.

### Hermes (Nous Research Hermes Agent)

"Hermes" here is Nous Research's Hermes Agent (https://github.com/NousResearch/hermes-agent), listed on agentskills.io as "a personal AI agent by Nous Research that runs across a CLI, a desktop app, and messaging platforms".

Sources: https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks ; https://hermes-agent.nousresearch.com/docs/developer-guide/plugins

- Core hook names: `pre_tool_call`, `post_tool_call`, `transform_tool_result`, `transform_terminal_output`, `pre_llm_call`, `post_llm_call`, `transform_llm_output`, `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`, `pre_approval_request`, `post_approval_response`, `subagent_start`, `subagent_stop`, streaming hooks (`on_stream_start`/`delta`/`end`), gateway-only `agent:start`/`agent:step`/`agent:end`, `command:*`, and more.
- Two transports: (a) shell hooks in the `hooks:` block of `~/.hermes/config.yaml` (scripts under `~/.hermes/agent-hooks/`), stdin JSON `{"hook_event_name","tool_name","tool_input","session_id","cwd","profile","extra"}`, stdout `{"decision":"block","reason":...}` / `{"action":"block","message":...}` / `{"action":"modify","args":{...}}` / `{"context":"..."}`, or exit code 2 to block; (b) Python plugins in `~/.hermes/plugins/<name>/` with `register(ctx)` calling `ctx.register_hook("pre_tool_call", fn)`; `pre_tool_call` returns `{"action":"block"}` or `{"action":"approve"}` ("escalates to the human-approval gate"); `pre_llm_call` returns `{"context": "..."}` ("injected into the user message, never the system prompt").
- Semantics: "First valid `block` or `approve` directive wins"; arg modifications are shallow-merged and "multiple `modify` hooks accumulate". Timeouts: `plugins.hook_callback_timeout` default 30 s; `pre_tool_call` timeout fails closed ("the tool is blocked with a timeout message"); other hooks fail open; shell hooks default 60 s, fail-open unless `fail_closed: true` on `pre_tool_call`. "Hook callback errors are isolated and logged rather than crashing the agent."

### Table B: coding agents

| Agent | Native hook events (canonical names) | Can block? | Modify tool input? | Inject context? | Config format | Transport |
|---|---|---|---|---|---|---|
| Claude Code | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SubagentStart/Stop`, `SessionStart/End`, `PreCompact/PostCompact`, `Notification`, + ~20 more | Yes (exit 2 or `permissionDecision: deny`) on PreToolUse, UserPromptSubmit, Stop, SubagentStop, PreModelSwitch… | Yes (`updatedInput`) | Yes (`additionalContext`, plain stdout) | JSON `hooks` in `settings.json` / plugin `hooks.json` | shell command (stdin/stdout JSON), HTTP POST, MCP tool, prompt, agent |
| Codex CLI | `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact/PostCompact`, `UserPromptSubmit`, `SubagentStart/Stop`, `Stop`, `Interrupt`, `SessionStart/End` | Yes (exit 2 or `permissionDecision: deny`) | Yes (`updatedInput`) | Yes (`additionalContext`) | `hooks.json` or `[hooks]` in `config.toml`; `features.hooks`; hash-based trust | shell command (stdin/stdout JSON), MCP tool; `prompt`/`agent` parsed but skipped |
| Gemini CLI | `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `SessionStart/End`, `Notification`, `PreCompress` | Yes (`decision: deny`/`block`, exit 2) on Before/After Tool/Agent/Model | Yes (`hookSpecificOutput.tool_input`, `llm_request`, `toolConfig`) | Yes (`additionalContext`, `llm_response`) | `hooks` in `settings.json` | shell command (stdin/stdout JSON) |
| Cursor | `preToolUse`, `postToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `stop`, `sessionStart/End`, `subagentStart/Stop`, `preCompact`, … | Yes (`permission: deny`, exit 2; fail-open unless `failClosed`) | Yes (`updated_input`) | Yes (`additional_context`, `agent_message`, `followup_message`) | `hooks.json` (`version: 1`) | shell command (stdin/stdout JSON) |
| OpenCode | `tool.execute.before/after`, `chat.message`, `chat.params`, `permission.ask`, `event` bus, `shell.env`, `experimental.session.compacting` | Yes (throw) | Yes (mutate `output.args`) | Yes (`output.context.push`) | JS/TS plugin module; npm via `opencode.json` | in-process plugin API |
| Hermes Agent | `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `on_session_start/end`, `pre_approval_request`, `subagent_start/stop`, transform_* hooks, gateway events | Yes (`action: block`, exit 2; `pre_tool_call` fails closed on timeout) | Yes (`action: modify`, shallow-merged) | Yes (`context`, into user message only) | `hooks:` in `config.yaml` (shell) or `plugin.yaml` + `register(ctx)` (Python) | shell command (stdin/stdout JSON) or in-process Python |
| Aider | none (post-edit `--lint-cmd`/`--test-cmd`, auto-commit, git pre-commit via `--git-commit-verify`) | No (failures are fed back to the model) | No | Indirectly (lint/test output) | CLI flags / config | shell command |

---

## 4. Cross-agent abstraction feasibility

### Common denominator across coding agents

Every hook-capable agent above (Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Hermes) exposes these six moments; names differ, semantics line up:

| Canonical event | Claude Code | Codex | Gemini CLI | Cursor | OpenCode | Hermes |
|---|---|---|---|---|---|---|
| before tool call (blockable, input-modifiable) | `PreToolUse` | `PreToolUse` | `BeforeTool` | `preToolUse` (+ `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`) | `tool.execute.before` | `pre_tool_call` |
| after tool call (context-injectable) | `PostToolUse` / `PostToolUseFailure` | `PostToolUse` | `AfterTool` | `postToolUse` / `postToolUseFailure` | `tool.execute.after` | `post_tool_call` |
| user prompt submitted (blockable, context-injectable) | `UserPromptSubmit` | `UserPromptSubmit` | `BeforeAgent` | `beforeSubmitPrompt` | `chat.message` | `pre_llm_call` |
| agent finished a turn | `Stop` | `Stop` | `AfterAgent` | `stop` | `session.idle` event | `post_llm_call` / `agent:end` |
| session start / end | `SessionStart` / `SessionEnd` | `SessionStart` / `SessionEnd` | `SessionStart` / `SessionEnd` | `sessionStart` / `sessionEnd` | `session.created` event | `on_session_start` / `on_session_end` |
| before context compaction | `PreCompact` | `PreCompact` | `PreCompress` | `preCompact` | `experimental.session.compacting` | not documented |

Shared transport among the shell-based five (Claude Code, Codex, Gemini CLI, Cursor, Hermes shell hooks): spawn a command, JSON on stdin containing at least `session_id`, `cwd`, `hook_event_name`, and for tool events a tool name plus tool input; decision returned as JSON on stdout; exit code 2 means block; matchers on tool name.

### Where they diverge

- **Event names and casing**: `PreToolUse` (Claude, Codex) vs `BeforeTool` (Gemini) vs `preToolUse` (Cursor) vs `tool.execute.before` (OpenCode) vs `pre_tool_call` (Hermes).
- **Decision field**: `hookSpecificOutput.permissionDecision: allow|deny|ask` (Claude, Codex) vs top-level `decision: allow|deny|block` (Gemini) vs `permission: allow|deny|ask` (Cursor) vs `{"decision":"block"}` / `{"action":"block"}` (Hermes) vs `throw` (OpenCode).
- **Input-modification field**: `updatedInput` (Claude, Codex) vs `hookSpecificOutput.tool_input` merge (Gemini) vs `updated_input` (Cursor) vs `{"action":"modify","args":{}}` shallow-merge (Hermes) vs mutate `output.args` (OpenCode).
- **Context-injection field**: `additionalContext` (Claude, Codex, Gemini) vs `additional_context` / `agent_message` (Cursor) vs `context` (Hermes, user message only) vs `output.context.push` (OpenCode, compaction only).
- **Non-zero-exit semantics**: Claude, Codex, Gemini treat non-0/non-2 as "proceed with warning"; Cursor is fail-open unless `failClosed: true`; Hermes shell hooks fail open unless `fail_closed: true`, but plugin `pre_tool_call` fails closed on timeout.
- **Model-level hooks**: Gemini (`BeforeModel`/`AfterModel`/`BeforeToolSelection`, `llm_request`/`llm_response` override) and Hermes (`pre_llm_call`/`post_llm_call`/`transform_llm_output`) expose the model call; Claude Code and Codex do not (Claude's `PreModelSwitch` is about switching models, not intercepting requests).
- **Handler types**: Claude Code has `command`, `http`, `mcp_tool`, `prompt`, `agent`; Codex has `command`, `mcp_tool`; Gemini and Cursor have `command` only; OpenCode and Hermes plugins are in-process code.
- **Trust/gating**: Codex requires per-hook hash trust; Claude Code requires workspace trust for project skill/subagent hooks; Gemini/Cursor docs read here do not describe a trust step (**unverified**).
- **Aider** has no hook events at all; only post-edit lint/test and commit behaviour.

### Existing cross-agent efforts (primary repos only)

- `weykon/agent-hooks` (Rust): "Unified hook registration for AI coding CLI tools" for Claude Code, Cursor, Codex, Windsurf, Kiro, OpenCode, Gemini; a `ToolAdapter` trait with `register_hooks()`, `unregister_hooks()`, `supported_events()`; a bridge script normalizes payloads to JSONL (`{"kind":{"type":"stop"},"session_id":...,"cwd":...}`). Early-stage (3 commits at fetch time). https://github.com/weykon/agent-hooks
- `sondera-ai/sondera-coding-agent-hooks`: "A reference monitor for AI coding agents. Rust hook binaries and Cedar policies intercept every shell command, file operation, and web request". Adapters for Claude Code, Cursor, GitHub Copilot, Gemini CLI, Antigravity, Codex, Hermes, OpenCode, OpenHands, VS Code; each "forwards it over gRPC to `sondera serve`" which returns Allow/Deny/Escalate; stages PreModel/PostModel/PreTool/PostTool; "If the harness cannot be reached, enforcement hooks fail closed." https://github.com/sondera-ai/sondera-coding-agent-hooks
- Also surfaced by search but not fetched (unverified): `o11y-dev/opentelemetry-hooks` (telemetry export from Claude Code, Codex, Cursor, Gemini CLI, Copilot, OpenCode, Windsurf hooks) and `eandualem/agent-backbone` PR #123 (hook adapters for Codex, Gemini CLI, OpenCode).

### Portable config standards checked

- **AGENTS.md**: "Think of AGENTS.md as a README for agents"; "AGENTS.md is just standard Markdown"; defines no hooks or lifecycle. Supported by Codex, Gemini CLI, Aider, Cursor, Copilot, Junie, Devin, Windsurf, VS Code, others. https://agents.md
- **Agent Skills (agentskills.io)**: "a folder containing a `SKILL.md` file" with metadata and instructions, optional `scripts/`, `references/`, `assets/`; loaded by progressive disclosure. "originally developed by Anthropic, released as an open standard". Client list includes Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Hermes Agent, Copilot, and many more. No hook/lifecycle mechanism is defined by the spec page. https://agentskills.io (Claude Code separately allows hooks in skill frontmatter, per https://code.claude.com/docs/en/hooks.)
- **MCP**: The 2026-07-28 spec defines server features (Resources, Prompts, Tools), client feature Elicitation, and Extensions (Tasks, Skills over MCP, MCP Apps). "Hosts must obtain explicit user consent before invoking any tool" but "MCP itself cannot enforce these security principles at the protocol level". No "hooks", "middleware" or interceptor mechanism appears; the closest is Multi Round-Trip Requests (`resultType: "input_required"`), which lets a *server* ask for more input mid-call, not intercept a host's tool call. https://modelcontextprotocol.io/specification/latest ; https://blog.modelcontextprotocol.io/posts/2026-07-28/ . MCP is, however, already used as a hook *transport* by Claude Code and Codex (`type: "mcp_tool"` handlers).

---

## 5. Verdict, with reasoning

1. **The frameworks are agent-building runtimes, not control planes.** LangChain's own definition ("Agent = Model + Harness … any middleware that shapes behavior"), LangGraph ("runtime for building … agents"), AutoGen ("agents … are created by the runtime"), CrewAI (Crews/Flows you define), OpenAI Agents SDK ("a built-in loop"), ADK ("registered once on the Runner"), Pydantic AI ("a typed, extensible agent loop") all place hooks *inside* a loop the framework runs. A hook such as `wrap_tool_call` or `before_tool_callback` is invoked by that framework's tool executor. Claude Code, Codex, Gemini CLI and Cursor run their own executors in their own processes and never call into a Python/TS framework you control. There is no documented adapter in any of these frameworks for subscribing to an external agent's events.

2. **The coding agents already solved the "hooks layer" problem for themselves, with a converging shape.** Five of the seven (Claude Code, Codex, Gemini CLI, Cursor, Hermes) use the same architecture: declarative config, spawn a process, JSON in, JSON/exit-code out, exit 2 = block. Codex and Cursor reuse Claude Code's exact event names and output fields (`PreToolUse`, `hookSpecificOutput.permissionDecision`, `updatedInput`, `additionalContext`); Gemini CLI uses the same architecture with different names; OpenCode and Hermes-plugins are in-process. A cross-agent layer is therefore a *config generator plus payload normalizer* over these native surfaces, which is exactly what `weykon/agent-hooks` and `sondera-coding-agent-hooks` do. None of the agent-building frameworks would be on the path between the agent and the hook script.

3. **Using LangChain/LangGraph/etc. would add a loop you do not need.** The only way to route Claude Code's `PreToolUse` through, say, `HumanInTheLoopMiddleware` would be to write a hook command that starts a LangGraph run whose sole job is to evaluate a policy and print JSON. That imports checkpointers, thread IDs and interrupt/resume semantics designed for pausing *your own* graph, to answer a synchronous yes/no that the calling agent needs within a timeout. AutoGen is additionally in maintenance mode.

4. **Where the frameworks might still appear**: as an *implementation detail inside a hook handler* when the handler is itself an LLM-driven judge (Claude Code's `prompt`/`agent` handler types do this natively; CrewAI's string guardrails and OpenAI's guardrails show the pattern). That is a use of the frameworks as ordinary application libraries, not as the hooks layer.

### What to borrow from the frameworks

- **The before / after / wrap triad and `jump_to`** (LangChain middleware): a normalized hook should be classifiable as node-style (return state/decision) or wrap-style (control whether the underlying action runs, and how many times). Coding agents only expose node-style today; a layer could emulate wrap-style by pairing `pre` + `post` with an ID.
- **"Return None to proceed; return a value to override; first non-None wins"** (ADK callback chaining; CrewAI `@on` proceed/mutate/replace/abort; Hermes "first valid block or approve directive wins"). This is a clean composition rule for multiple hooks on one event and maps onto Claude Code's "exit 2 overrides any JSON allow".
- **Decision vocabulary `approve | edit | reject`** (LangChain `HumanInTheLoopMiddleware`) ≈ `allow | ask | deny` + `updatedInput` (Claude/Codex/Cursor) ≈ `block | approve | modify` (Hermes). Pick one canonical set and map.
- **Explicit fail-open vs fail-closed** (Hermes `fail_closed`, Cursor `failClosed`, Sondera "fail closed"; OpenAI guardrails' parallel-vs-blocking mode). Make it a per-hook attribute.
- **Guardrail tripwires and tool guardrails** (OpenAI Agents SDK): the distinction between validating tool *input* (can skip the call or replace the output) and tool *output* (can replace) is the same split as PreToolUse/PostToolUse and is worth keeping explicit in the abstraction.
- **Termination conditions as composable predicates** (AutoGen `&`/`|`, Vercel `stopWhen`): a declarative way to express "block when X and Y" for the common case without a script.
- **Matcher/filter syntax** (CrewAI `@on(..., agents=[...], tools=[...])`; Claude/Codex/Gemini regex tool matchers): keep tool-name matching as the primary filter, since all shell-based agents support it.
- **Do not borrow** LangGraph's interrupt/resume/checkpointer model for the transport: the coding agents block synchronously on a child process and have timeouts (Claude 600 s, Codex 600 s, Hermes 30–60 s); there is no "resume later with a thread ID" in any of them except via the agent's own permission prompt (`ask`).

---

## Sources (all fetched 2026-09-14)

Frameworks
- https://docs.langchain.com/oss/python/langchain/overview
- https://docs.langchain.com/oss/python/langchain/middleware
- https://docs.langchain.com/oss/python/langchain/middleware/custom
- https://docs.langchain.com/oss/python/langchain/middleware/built-in
- https://reference.langchain.com/python/langchain_core/callbacks/
- https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/callbacks/base.py
- https://docs.langchain.com/oss/python/langgraph/overview
- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://microsoft.github.io/autogen/stable/index.html
- https://github.com/microsoft/autogen
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/agent-and-agent-runtime.html
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/cookbook/tool-use-with-intervention.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html
- https://docs.crewai.com/en/introduction
- https://docs.crewai.com/en/concepts/crews
- https://docs.crewai.com/en/concepts/tasks
- https://docs.crewai.com/en/learn/execution-hooks
- https://openai.github.io/openai-agents-python/
- https://openai.github.io/openai-agents-python/ref/lifecycle/
- https://openai.github.io/openai-agents-python/guardrails/
- https://openai.github.io/openai-agents-python/human_in_the_loop/
- https://adk.dev/ (redirect target of https://google.github.io/adk-docs/)
- https://adk.dev/callbacks/types-of-callbacks/
- https://adk.dev/plugins/
- https://pydantic.dev/docs/ai/ (redirect target of https://ai.pydantic.dev)
- https://pydantic.dev/docs/ai/core-concepts/agent/
- https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/filters
- https://huggingface.co/docs/smolagents/main/en/reference/agents
- https://ai-sdk.dev/docs/agents/loop-control

Coding agents
- https://code.claude.com/docs/en/hooks
- https://learn.chatgpt.com/docs/hooks (redirect target of https://developers.openai.com/codex/hooks)
- https://learn.chatgpt.com/docs/config-file/config-reference (redirect target of https://developers.openai.com/codex/config-reference)
- https://geminicli.com/docs/hooks/reference/ (source: https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)
- https://cursor.com/docs/agent/hooks
- https://opencode.ai/docs/plugins/
- https://aider.chat/docs/usage/lint-test.html
- https://aider.chat/docs/git.html
- https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks
- https://hermes-agent.nousresearch.com/docs/developer-guide/plugins

Standards and cross-agent projects
- https://modelcontextprotocol.io/specification/latest (2026-07-28)
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://agentskills.io
- https://agents.md
- https://github.com/weykon/agent-hooks
- https://github.com/sondera-ai/sondera-coding-agent-hooks

Pages that failed (404 on 2026-09-14): https://docs.langchain.com/oss/python/langchain/callbacks ; https://pydantic.dev/docs/ai/core-concepts/deferred-tools/ ; https://ai-sdk.dev/docs/agents/tool-approval

---

## Unverified / open questions

- **LangChain callbacks' stated purpose**: no current doc page fetched contains a sentence saying callbacks are observational; the conclusion rests on the API (methods return nothing that alters control flow) and on the middleware docs being the documented control surface.
- **AutoGen `on_publish` / `on_response`** on `InterventionHandler`: only `on_send` appears in the fetched cookbook.
- **Pydantic AI deferred-tool details** (`ToolApproved`/`ToolDenied`, code-driven approval): the deferred-tools page 404'd; only `requires_approval=True` → `DeferredToolRequests` is confirmed from the agent page.
- **Vercel AI SDK `needsApproval`**: referenced on the loop-control page as a stop condition; the tool-approval page 404'd.
- **Mastra** was not researched.
- **Gemini CLI and Cursor trust/consent step for project-level hooks**: not described in the pages read.
- **Claude Code `Stop` accepting `updatedInput` "for next turn"**: reported by the fetched hooks page summary; worth re-reading the exact table before relying on it.
- **Codex `notify` payload schema**: the reference page confirms it "receives a JSON payload from Codex" with events like `agent-turn-complete`, but the field list was not captured.
- **OpenCode `permission.ask` hook return contract** (how it sets allow/deny): the plugins page lists the hook; its exact return shape was not captured.
- **Hermes `PreCompact`-equivalent**: no compaction hook found in the hooks page summary.
- **Whether Codex's hook JSON is intentionally Claude Code-compatible**: the strings match, but the Codex docs make no compatibility claim.
