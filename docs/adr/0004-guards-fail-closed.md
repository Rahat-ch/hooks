# Guards fail closed; every other Hook fails open

If a Guard cannot reach a Decision (parse failure, bad input, internal error, timeout), it blocks and gives a reason. Every other Hook (format-on-edit, check, notify, session-context, audit-log) swallows its own errors and exits 0. A security Hook that silently lets things through when it breaks is worse than none: users trust it. A broken formatter or notifier should never stop the agent working. This also matches Host behaviour: Copilot CLI already blocks on any non-zero exit, and Claude Code 2.1.288 made PreToolUse match failures block.

## Consequences

Guards need low false-positive rates, because every parse failure becomes a block. Each Hook's fail mode is documented with that Hook.
