# One dispatcher per Event, not one settings entry per Hook

`hardhooks init` writes one Host settings entry per Event (`hardhooks run <Event>`), with a matcher that covers every enabled Hook. The dispatcher reads `.hardhooks.json`, runs each enabled Hook in-process and merges their Decisions: block beats ask, and ask beats allow. We chose this over one entry per Hook because several Hooks share an Event (three Guards fire on PreToolUse for Bash), and each Node spawn costs about 19 ms. Turning a Hook on or off is a config change rather than a settings edit, and the merge rules belong to us instead of varying by Host.

## Consequences

- The Host sees one hook per Event, so per-Hook timing and Decisions must come from our own output (audit-log, `hardhooks test`), not the Host's UI.
- A crash in the dispatcher affects every Hook for that Event. Each Hook runs isolated inside it, and fail modes follow ADR-0004.
