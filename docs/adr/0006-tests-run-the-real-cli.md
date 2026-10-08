# Tests run the real CLI

Every test spawns the bundled CLI (`node dist/hardhooks.mjs …`) the way a Host does: a payload on stdin, the project as the working directory, and a hermetic environment (temp HOME, config and state dirs, no inherited Host variables, a controlled PATH). Projects are temp directories, repos use real git, and where a real program would be slow or have side effects (desktop notifiers, formatters, check commands, a git that hangs), a fake program on PATH records its calls and answers as told. Tests assert only what a Host or user sees: stdout, stderr, exit code, and files the CLI writes for the user (audit logs, formatted files).

This reverses the testing decision in the v1 spec (#1, "Seam 1: the dispatcher entry"), under which most tests called `dispatch()` in-process with an injected config, clock, process runner and, for dispatcher tests, test-only Hooks. The maintainer decided (#22) that tests should mirror exactly what Hosts do. An in-process seam can pass while the shipped bundle is broken: argument parsing, stdin handling, config and state lookup from the real environment, the platform's process spawning and the bundling itself all sit outside it. Injection points also invite tests of states no Host can produce (a test-only Hook that throws, a config object no file could express).

## Considered Options

- **Keep the in-process seam, with a few process-level smoke tests (the spec).** Fast and fully controllable, but it tests a wrapper-less product nobody runs, and the injected fakes drift from the real environment. Rejected by the maintainer.
- **Both, permanently.** Rejected: two ways to test every behaviour, and the in-process one is always the easier one to reach for.

## Consequences

- Tests are slower (a Node start per CLI run, about 50 ms) and run concurrently within a file (`sequence.concurrent`) to compensate. Each test builds its own sandbox, so tests never share state.
- Behaviour that only test-only Hooks could reach is tested through real Hooks and real configs, or not at all. Paths no real Hook can reach (a fail-open Hook that throws: every one swallows its own errors) lose their tests; each dropped case is listed where its file was converted.
- The product gets outside knobs only where real behaviour can't be arranged. So far there is one: `HARDHOOKS_NOW` (an ISO 8601 date) fixes the CLI's clock, for dates, turn lengths and audit-log days. Everything else uses real behaviour: detached notifications are awaited through the fake notifier's record file, timeouts are real time with small configured values, and trust is granted with the real `hardhooks trust --yes`.
- On Windows, a program the product spawns by bare name without a shell (git, desktop notifiers, gofmt, rustfmt, ruff) must be a real `.exe`, which can't be faked. Those cases are POSIX-only (`it.skipIf(process.platform === "win32")`). Command lines run through the shell, and Node formatters run as `node <script>`, are faked on every OS.
- Migration is expand–migrate–contract (#22): the harness and the dispatcher and config tests first, then the remaining files, then the in-process helpers and the injection points in `src/` (`hooks`, `config`, `trusted` on `dispatch`) go.
