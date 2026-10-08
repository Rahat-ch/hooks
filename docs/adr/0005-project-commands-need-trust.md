# Project commands run only in a trusted project

hardhooks is often installed per user (`init --user`, or the plugin), so it runs in every repo the user opens, cloned ones included. Some Hooks run commands, and a repo can choose them: command options in its `.hardhooks.json`, or what Hooks autodetect from its files (package.json scripts, ruff / go vet / cargo check, formatters). Running whatever a freshly cloned repo names is remote code execution. So, like `direnv allow`, these Project commands run only after the user runs `hardhooks trust` in that project. Trust stores a hash of the project root path and the files that choose the commands in the user state dir, never the repo, and lapses when any of them changes. Untrusted, the Hook skips the command, nothing blocks, and the user gets a one-line notice once per session per Hook. Guards, options that are not commands, and commands from the user's own config are unaffected.

## Considered Options

- **Trust only the repo config's command options, and keep autodetection free.** Rejected: autodetection is the bigger hole. A package.json `lint` script is arbitrary code, and `cargo check` runs build scripts.
- **Exempt formatters on PATH (gofmt, a global prettier).** Rejected: the project's config chose them, and that config can run code. prettier loads `plugins` named even in a JSON `.prettierrc`, `prettier.config.js` is a script, and dprint downloads process plugins. Project-local binaries (`node_modules`, `.venv`) are the project's code outright. Trusting every detected formatter keeps one rule that is easy to explain. The cost: in an untrusted Go repo, gofmt waits for `hardhooks trust`.
- **Hash every file that can influence a run** (test files, `node_modules`, build scripts). Rejected as impossible: `npm test` runs the whole repo. Trust means "I trust this project". The hash is a tripwire for the files that *choose* what runs, so a `git pull` that rewrites them asks again.
- **Always ask through the Host (`ask` Decisions).** Rejected: Stop and PostToolUse can't ask, and several Hosts ignore `ask` (`src/hosts`).

## What the hash covers

These files at the project root (the nearest ancestor with `.git`):

- the applicable `.hardhooks.json`, whole;
- package.json's `scripts` and `prettier` fields only, so a dependency bump (often made by the agent itself) doesn't revoke trust mid-session;
- prettier, biome, dprint, ruff and rustfmt config files, whole;
- whether `pyproject.toml`, `go.mod`, `Cargo.toml` and the lockfiles exist. They only switch a tool on, or pick the package manager.

## Consequences

- Nested configs (monorepo packages), installed dependencies and virtualenvs are not covered: trusting a project trusts what you installed in it.
- A Hook that autodetects a command must call `trust.mayRun` before running it. A Hook whose option is a command lists it in `commandOptions`, so the dispatcher withholds a repo-config value and the user config's value, if any, applies instead.
- An agent could try to run `hardhooks trust --yes` itself, perhaps steered by the repo. `--yes` is refused when `CLAUDECODE` is set, and the prompt needs a terminal, not a pipe. This is defence in depth, not a guarantee: a Guard rule for `hardhooks trust` would close it further.
- `hardhooks test` runs cases with the project's real trust (its sandbox never runs anything) and says when commands are withheld. `hardhooks init` says so too.
