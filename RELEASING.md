# Releasing

This repo ships two npm packages that always release together, with the same version:

- [`@ibm/ibmi-mcp-server`](https://www.npmjs.com/package/@ibm/ibmi-mcp-server): the MCP server
- [`@ibm/ibmi-cli`](https://www.npmjs.com/package/@ibm/ibmi-cli): the `ibmi` CLI, which exact-pins the server version

Each release also publishes a multi-arch container image (`amd64`, `arm64`, `ppc64le`) to `ghcr.io/ibm/ibmi-mcp-server` and creates a GitHub Release.

## How a release works

A release is a pull request. Merging it publishes everything.

1. **Open the release PR.** Run `/release [patch|minor|major]` in Claude Code from the repo root on an up-to-date `main`. It bumps the version, writes `CHANGELOG.md` and the release notes, and opens a PR named `chore(release): X.Y.Z`.
2. **Review and merge the PR.** The PR body shows the release notes. Edit `.github/release-notes/vX.Y.Z.md` on the PR branch to change them.
3. **Approve the release.** Merging starts the [Release workflow](https://github.com/IBM/ibmi-mcp-server/actions/workflows/release.yml). After the checks pass, it waits for one approval of the `Release` environment.

After the approval, the workflow does the rest:

| Job | What it does |
|-----|--------------|
| `plan` | Reads the version from `package.json`. Stops if tag `vX.Y.Z` already exists. |
| `verify` | `npm ci`, build, typecheck, lint, test. |
| `approve` | Waits for approval of the `Release` environment. |
| `tag` | Creates tag `vX.Y.Z` on the merged commit. |
| `npm` | Publishes the server, then the CLI, through npm trusted publishing (with provenance). |
| `docker` | Builds the three platform images. |
| `manifest` | Creates the `vX.Y.Z` multi-arch manifest and moves `latest`. Runs only if `npm` succeeded. |
| `github` | Creates the GitHub Release from `.github/release-notes/vX.Y.Z.md`, marked as latest. |

The workflow runs on any push to `main` that changes `package.json`. If the version in `package.json` already has a tag, it does nothing.

## Opening the release PR

`/release` runs these steps. You can also run them yourself.

```bash
npm run release:prepare:minor   # or :patch, :major, or release:prepare for auto
```

`release:prepare` runs tests and typecheck, then `standard-version` bumps the root version and writes the `CHANGELOG.md` section. `scripts/sync-workspace-versions.mjs` copies the version into both `packages/*/package.json` and the CLI's pin on the server. Nothing is committed.

Then:

1. Edit the new `CHANGELOG.md` section. `standard-version` deletes any `## Unreleased` block, so copy that block out before `release:prepare` and merge it back in.
2. Write `.github/release-notes/vX.Y.Z.md`. This file becomes the GitHub Release body. The `/release` skill defines its format.
3. Open the PR:

   ```bash
   npm run release:finalize
   ```

   This creates branch `release/vX.Y.Z`, commits the release files and the notes as `chore(release): X.Y.Z` (DCO-signed), pushes the branch, and opens the PR.

To start over before the PR is merged, run `npm run release:undo`. It resets the prepared files, or closes the PR and deletes the release branch.

## When a release fails

Every publish step skips work that is already done, so it is safe to run again.

- **A job failed after approval.** Fix the cause, then use **Re-run failed jobs** on the workflow run.
- **The run can't be re-run** (for example, it is too old). After tag `vX.Y.Z` exists, start the Release workflow by hand on that tag: `gh workflow run release.yml --repo IBM/ibmi-mcp-server --ref vX.Y.Z`. It builds the tagged commit and skips what is already published.
- **The fix needs code changes.** Release a new patch version.
- **A broken version reached npm.** npm versions cannot be reused. Release a new patch version.

## Pre-releases

Use `standard-version` directly with `--skip.commit --skip.tag`, then sync versions. Do not let `standard-version` commit or tag.

```bash
npx standard-version --skip.commit --skip.tag --prerelease alpha   # 0.8.0-alpha.0
node scripts/sync-workspace-versions.mjs
# write .github/release-notes/v0.8.0-alpha.0.md
npm run release:finalize
```

A version that contains `-` publishes to the npm dist-tag `next`, does not move the `latest` image, and becomes a GitHub pre-release. Install one with `npm install @ibm/ibmi-mcp-server@next`.

## One-time setup

### npm trusted publishing

The workflow publishes with OpenID Connect (OIDC), not an npm token. On npmjs.com, open **Settings → Trusted publishing** for each package (`@ibm/ibmi-mcp-server` and `@ibm/ibmi-cli`) and add a GitHub Actions publisher:

| Field | Value |
|-------|-------|
| Organization or user | `IBM` |
| Repository | `ibmi-mcp-server` |
| Workflow filename | `release.yml` |
| Environment name | leave empty |
| Allowed actions | `npm publish` |

Leave the environment name empty. The `npm` job does not use the `Release` environment, because each job that uses it needs its own approval.

After the first release publishes through trusted publishing, harden each package: set **Settings → Publishing access** to **Require two-factor authentication and disallow tokens**, then delete the `NPM_TOKEN` repository secret.

### Release environment

**Settings → Environments → Release** holds the approval gate. Add the maintainers who approve releases as required reviewers. The environment needs no secrets.

## Conventional commits

`standard-version` picks the version bump and builds the changelog from commit messages:

| Commit | Bump |
|--------|------|
| `fix(scope): ...` | patch |
| `feat(scope): ...` | minor |
| `feat(scope)!: ...` or a `BREAKING CHANGE:` footer | major (minor while the version is below 1.0.0) |
| `docs`, `chore`, `ci`, `test`, `refactor` | none |

Commit types and changelog sections are configured in `.versionrc.json`.
