# Releasing

Pushing a `v*` tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml). It goes through these steps in order:

1. **Check versions:** the tag must match the versions in `package.json`, `package-lock.json` and `.claude-plugin/plugin.json`, and the tagged commit must be on `main`.
2. **Run the full CI** ([`ci.yml`](../.github/workflows/ci.yml)): typecheck, unit and smoke tests on Linux, macOS and Windows with Node 20, 22 and 24, plus validation of the packed Claude Code plugin.
3. **Publish the tarball that CI validated** to npm, with provenance. A version with a `-` suffix (`0.2.0-rc.1`) goes to the `next` dist-tag. Every other version goes to `latest`.
4. **Check the published package:** run `npm i -g hardhooks@<version>`, `hardhooks init --dry-run` and `hardhooks test` on Node 20 on all three OSes, and check that the `$schema` URL serves this version's schema.
5. **Create the GitHub release** with generated notes and the tarball attached.

The steps that need a human are below.

## One-time setup

The workflow authenticates with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), which npm recommends over long-lived tokens. A trusted publisher is configured in the package's settings on npmjs.com, so the package has to exist first. The first publish therefore needs a token.

1. **Create the `npm` environment.** On GitHub, go to Settings → Environments → New environment, and name it `npm`. The publish job runs in it. You can add yourself as a required reviewer so that every publish waits for your approval.
2. **Bootstrap the first publish.** Use one of these:
   - **Token (recommended):** create a granular access token on npmjs.com with read and write access to packages, and a short expiry. Add it as the `NPM_TOKEN` secret of the `npm` environment. npm tries OIDC first and falls back to this token, so the first tagged release publishes through the workflow, with provenance.
   - **Manual:** run `npm run build && npm publish --access public` from the tagged commit on your machine, with 2FA. This publish has no provenance. When you push the tag, the workflow's publish job then fails because the version already exists, so create that GitHub release by hand with `gh release create v<x.y.z> --generate-notes`.
3. **Configure the trusted publisher** once `hardhooks` exists on npm. On npmjs.com, open `hardhooks` → Settings → Trusted Publisher → GitHub Actions, and set:
   - Organization or user: `Rahat-ch`
   - Repository: `hooks`
   - Workflow filename: `release.yml`
   - Environment: `npm`
   - Allowed actions: `npm publish`

   A new configuration expires unless a publish uses it within 2 days, so do this shortly before a release.
4. **Lock it down.** In the package's Publishing access settings, choose "Require two-factor authentication and disallow tokens". Revoke the bootstrap token and delete the `NPM_TOKEN` secret.

`package.json` `repository.url` must stay `git+https://github.com/Rahat-ch/hooks.git`. npm checks that it matches the repository the provenance comes from.

## Every release

1. **Bump the versions together.** Run `npm version <x.y.z> --no-git-tag-version`, which updates `package.json` and `package-lock.json`. Set the same `version` in `.claude-plugin/plugin.json`. Plugin installs only update when that version changes, and the workflow refuses a tag whose versions don't all match. Commit the change to `main` and make sure CI is green.
2. **Run the per-Host smoke checklist** ([#15](https://github.com/Rahat-ch/hooks/issues/15)) against a local build. Run `npm run build && npm pack`, install the tarball globally, run `hardhooks init` in a scratch repo, and work through each Host: Claude Code, Copilot CLI, Cursor, Devin CLI and Continue. For each one, check that a force-push is blocked, `.env` can't be read, an edit is formatted, the session start shows the context, and (with `check` on) a failing check blocks the stop. Update the README's compatibility table if anything changed.
3. **Tag and push:**

   ```sh
   git tag -a v<x.y.z> -m v<x.y.z>
   git push origin v<x.y.z>
   ```

   Then watch the Release workflow. If you set a required reviewer on the `npm` environment, approve the publish job when it asks.
4. **Check the results.** The workflow already does these checks, so this is a spot check:
   - On macOS, Linux and Windows, `npm i -g hardhooks && hardhooks init --dry-run` works on a clean machine. The `verify` jobs do this on GitHub's runners. Try it on at least one real machine too.
   - The `$schema` URL `https://unpkg.com/hardhooks/hardhooks.schema.json` returns this version's schema (the `schema` job). unpkg can cache the unversioned URL for a few minutes.
   - The plugin installs: `claude plugin marketplace add Rahat-ch/hooks`, then `claude plugin install hardhooks@hardhooks` (or `claude plugin update`) in a fresh Claude Code.
   - The npm page shows the provenance badge, and the GitHub release has the tarball.

## When something fails

- **Before publish (version check or CI):** nothing was published. Fix the problem on `main`, delete the tag (`git push --delete origin v<x.y.z>` and `git tag -d v<x.y.z>`), then tag again.
- **During or after publish:** npm never lets a version be reused. If the package is broken, deprecate it with `npm deprecate hardhooks@<x.y.z> "<why>"`, then release the next patch version. If only `verify`, `schema` or `github-release` failed, re-run the failed jobs from the Actions UI. For example, if unpkg was slow, a re-run doesn't publish again.
- **`ENEEDAUTH` / 404 on publish:** check that the trusted publisher's fields match exactly. They are case-sensitive, and the workflow filename has no path. Also check that the job ran in the `npm` environment, and that `NPM_TOKEN` is present if this is the bootstrap publish.
