# TypeScript on Node, not a native binary

Hooks are written in TypeScript and shipped as one pre-bundled `.mjs` run with `node` (Node 20 or later) in exec form, even though cross-agent hook tools in 2026 mostly ship a single native binary (rtk, dcg, nah). We chose it because `unbash` is a synchronous, dependency-free, actively maintained bash parser in TypeScript, and because Claude Code mods are JS/TS, so the same Decision logic can be reused there later. We accept about 19 ms of Node startup per spawn (measured; `npx` costs about 147 ms and is ruled out) and that some Claude Code users won't have Node installed.

## Considered Options

- **Go with `mvdan.cc/sh`**: the best bash parser and a single static binary, but no code sharing with mods.
- **Rust**: a single binary, but weaker bash parsing (tree-sitter).
- **Bash + jq**: what people copy-paste today, but hard to test and broken on Windows.

## Consequences

- Compiled binaries (`bun build --compile` or Node SEA) for users without Node are deferred to v1.1.
- Never rely on plugin dependency auto-install for native addons: it runs with `--ignore-scripts`.
