# Release Process for the IBM i MCP Server monorepo

This document describes the automated release process for the two npm packages shipped from this repo:

- [`@ibm/ibmi-mcp-server`](https://www.npmjs.com/package/@ibm/ibmi-mcp-server) — the MCP server binary (`ibmi-mcp-server`)
- [`@ibm/ibmi-cli`](https://www.npmjs.com/package/@ibm/ibmi-cli) — the `ibmi` command-line interface

Both packages **always release with the same version** on the same `v*` git tag. The CLI declares an exact-pinned dependency on the server (no caret), so npm will refuse to install a mismatched pair.

## Overview

The release process is split into **three phases** to enable manual changelog review and enhancement:

1. **Prepare**: Run prerelease checks, bump the root version, regenerate CHANGELOG, and propagate the version into both packages (WITHOUT committing)
2. **Review**: Manually review and optionally enhance the changelog
3. **Finalize**: Create commit, tag, and push to trigger automation

This workflow uses `standard-version` for version bumping and changelog generation at the repo root, with a follow-on `scripts/sync-workspace-versions.mjs` pass that writes the new version into `packages/*/package.json` and updates the CLI's server dependency pin.

All commands run from the repo root — no `cd` into subdirectories required.

## Prerequisites

1. **Commit Access**: You must have push access to the `main` branch
2. **npm Publishing Rights**: Verify you have publish permissions for `@ibm/ibmi-mcp-server` (requires access to `@ibm` organization)
3. **Release Environment Access**: You must be approved for the "Release" environment in GitHub (repository maintainers can configure this)
4. **Clean Working Directory**: Ensure all changes are committed
5. **Up-to-date main**: Pull latest changes from `origin/main`

## Release Workflow

The new release workflow is split into three distinct phases for better control and changelog quality.

### Phase 1: Prepare Release

From the repo root, run the prepare script:

```bash
./scripts/release-prepare.sh [auto|patch|minor|major]
```

**What this does:**
1. ✅ Runs `npm test --workspaces --if-present` (must pass for both packages)
2. ✅ Runs `npm run typecheck --workspaces --if-present` (must pass)
3. 📝 Generates CHANGELOG.md from conventional commits (single changelog at repo root)
4. 📝 Bumps version in root `package.json`
5. 📝 Runs `scripts/sync-workspace-versions.mjs` to write the new version into `packages/server/package.json`, `packages/cli/package.json`, and update the CLI's exact-pinned dep on `@ibm/ibmi-mcp-server`
6. 📝 Refreshes root `package-lock.json`
7. ⚠️ **Does NOT create commit or tag yet**

**Version bump options:**
- `auto` (default) - Automatically determines version from commits
- `patch` - Patch release (0.1.0 → 0.1.1)
- `minor` - Minor release (0.1.0 → 0.2.0)
- `major` - Major release (0.1.0 → 1.0.0)

**Example:**
```bash
./scripts/release-prepare.sh minor
```

If tests or typecheck fail, the script exits without making any changes.

### Phase 2: Review Changelog (Manual)

After prepare completes, you have uncommitted changes ready for review:

```bash
# View all changes
git diff

# Review the generated changelog
cat CHANGELOG.md

# (Optional) Enhance with Claude
claude "Review and enhance the v0.2.0 changelog for clarity and completeness"

# (Optional) Manually edit if needed
vim CHANGELOG.md
```

**Tips for enhancing changelogs:**
- Add user-facing descriptions (not just technical commit messages)
- Group related changes together
- Add links to documentation or issues
- Highlight breaking changes clearly
- Remove internal/non-user-facing changes

Take your time in this phase - the changelog is what users see!

### Phase 3: Finalize Release

When you're satisfied with the changelog and changes:

```bash
./scripts/release-finalize.sh
```

**What this does:**
1. Validates that release files are modified but not committed
2. Shows final changelog preview
3. Asks for confirmation
4. Stages files: root `package.json`, `package-lock.json`, `CHANGELOG.md`, `packages/server/package.json`, `packages/cli/package.json`
5. Creates commit: `chore(release): X.Y.Z` (DCO-signed)
6. Creates annotated tag: `vX.Y.Z`
7. Pushes commit and tag to `origin/main`

**This triggers the GitHub Actions workflow which:**
- Runs type checking, linting, and tests across both workspaces
- Builds both packages (server first — CLI imports from its `dist/public`)
- Publishes `@ibm/ibmi-mcp-server` to npm with provenance
- Waits for the server version to be visible on the registry (polls up to 30 × 5s)
- Publishes `@ibm/ibmi-cli` to npm with provenance

### Undo Release (Before Pushing)

If you need to undo at any point **before finalizing**:

```bash
./scripts/release-undo.sh
```

**This intelligently handles two scenarios:**

**Scenario A** - Uncommitted changes (after prepare):
- Resets `package.json`, `package-lock.json`, `CHANGELOG.md` to HEAD
- You can re-run prepare

**Scenario B** - Committed and tagged (after finalize, before push):
- Deletes the local tag
- Resets to previous commit
- You can start over

⚠️ **Cannot undo after pushing!** See troubleshooting section for recovery steps.

### Using npm Scripts

You can also use npm scripts instead of calling the shell scripts directly:

```bash

# Prepare release
npm run release:prepare        # auto version
npm run release:prepare:patch  # patch version
npm run release:prepare:minor  # minor version
npm run release:prepare:major  # major version

# Finalize release
npm run release:finalize

# Undo release
npm run release:undo
```

### Quick Reference

```bash
# Complete release workflow

npm run release:prepare:minor  # Prepare with minor version bump
# Review and edit CHANGELOG.md
npm run release:finalize       # Commit, tag, and push

# Undo if needed (before finalize)
npm run release:undo
```

### Create GitHub Release (Manual)

After the GitHub Actions workflow completes and npm publish succeeds:

1. **Go to GitHub Releases**: https://github.com/IBM/ibmi-mcp-server/releases
2. **Click "Create a new release"** or use the "Draft a new release" button
3. **Choose the tag** you just pushed (e.g., `v0.2.0`)
4. **Write release notes** using the CHANGELOG.md as a guide:
   - Add a friendly summary of the release
   - Organize changes into sections (New Features, Improvements, Bug Fixes)
   - Add links to documentation or examples
   - Reference relevant issues/PRs
5. **Publish release** when ready

**Tip:** Use CHANGELOG.md as your starting point, then enhance with:
- User-friendly descriptions (not just commit messages)
- Links to relevant documentation
- Migration guides for breaking changes
- Screenshots or examples where helpful

### Step 7: Verify Release

After publishing the GitHub release:

1. **Verify npm (both packages)**:
   ```bash
   npm view @ibm/ibmi-mcp-server@X.Y.Z version
   npm view @ibm/ibmi-cli@X.Y.Z version
   # Confirm the CLI's server dep is exact-pinned:
   npm view @ibm/ibmi-cli@X.Y.Z dependencies
   ```
2. **Check workflow**: https://github.com/IBM/ibmi-mcp-server/actions
3. **Confirm GitHub release**: https://github.com/IBM/ibmi-mcp-server/releases
4. **Smoke-test the CLI**: `npm i -g @ibm/ibmi-cli@X.Y.Z && ibmi --version`

## Conventional Commits

For standard-version to work optimally, follow the conventional commit format:

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Commit Types

| Type | Description | Version Bump |
|------|-------------|--------------|
| `feat` | New feature | Minor (0.1.0 → 0.2.0) |
| `fix` | Bug fix | Patch (0.1.0 → 0.1.1) |
| `docs` | Documentation only | None |
| `style` | Code style (formatting, etc) | None |
| `refactor` | Code refactoring | None |
| `perf` | Performance improvement | Patch |
| `test` | Adding/updating tests | None |
| `chore` | Maintenance tasks | None |
| `ci` | CI/CD changes | None |

### Breaking Changes

To trigger a major version bump, add `BREAKING CHANGE:` in the commit footer:

```
feat(sql): redesign query execution API

BREAKING CHANGE: The executeSql function now returns a Promise<Result>
instead of Result. Update all callers to use await.
```

### Examples

```bash
# Feature (minor bump)
git commit -m "feat(auth): add OAuth2 support for IBM i authentication"

# Bug fix (patch bump)
git commit -m "fix(sql): handle null values in query results correctly"

# Multiple fixes
git commit -m "fix(connection): resolve timeout issues

- Increase default timeout to 30s
- Add retry logic for transient failures
- Improve error messages"

# Documentation (no bump)
git commit -m "docs: update API documentation for executeSql"

# Breaking change (major bump)
git commit -m "feat(api)!: redesign tool interface

BREAKING CHANGE: All tools now use async/await instead of callbacks"
```

### Scope Guidelines

Use scopes to indicate which part of the codebase changed:

- `auth`: Authentication/authorization
- `sql`: SQL execution and queries
- `connection`: IBM i connection management
- `tools`: MCP tools
- `config`: Configuration
- `api`: Public API
- `deps`: Dependencies

## Enhancing Changelogs

The auto-generated changelog from conventional commits is a good starting point, but often benefits from human enhancement for clarity and user-friendliness.

### Why Enhance Changelogs?

Auto-generated changelogs:
- Use raw commit messages (often technical)
- May include internal changes users don't care about
- Lack context and examples
- Don't highlight important changes

Enhanced changelogs:
- Use user-friendly language
- Focus on user-facing changes
- Provide context and migration guides
- Highlight breaking changes clearly

### Using Claude for Enhancement

During the review phase, you can use Claude to enhance the changelog:

```bash
# After running release-prepare.sh
claude "Review the CHANGELOG.md and enhance it for clarity. Focus on:
- Making descriptions user-friendly
- Highlighting breaking changes
- Adding migration guidance where needed
- Removing internal/non-user-facing changes"
```

**Example prompts:**
- `"Enhance this changelog for v0.2.0 with user-friendly descriptions"`
- `"Review this changelog and suggest improvements for clarity"`
- `"Rewrite these technical commit messages as user-facing feature descriptions"`

### Manual Editing Tips

When manually editing `CHANGELOG.md`:

**DO:**
- ✅ Use clear, non-technical language
- ✅ Group related changes together
- ✅ Add links to issues/PRs for context
- ✅ Highlight breaking changes prominently
- ✅ Include migration guides for breaking changes
- ✅ Add code examples where helpful

**DON'T:**
- ❌ Remove the version header or date
- ❌ Change the markdown link format
- ❌ Remove important bug fixes
- ❌ Add unreleased changes to this version

### Example: Before and After

**Before (Auto-generated):**
```markdown
### Features
* feat(sql): add query timeout parameter (#123)
```

**After (Enhanced):**
```markdown
### Features
* **Query Timeouts**: SQL queries now support a timeout parameter to prevent long-running queries from blocking. Set `timeout: 30000` (in ms) in your query options. [#123](https://github.com/IBM/ibmi-mcp-server/pull/123)
```

## Troubleshooting

### Tests Failing During Prepare

If `npm test` fails during the prepare phase:

1. The script exits before making any changes
2. Fix the failing tests
3. Commit the fixes
4. Run `release-prepare.sh` again

**No cleanup needed** - nothing was changed.

### Typecheck Failing During Prepare

If `npm run typecheck` fails during the prepare phase:

1. The script exits before making any changes
2. Fix the type errors
3. Commit the fixes
4. Run `release-prepare.sh` again

**No cleanup needed** - nothing was changed.

### Need to Undo Uncommitted Release

If you ran `release-prepare.sh` but want to start over:

```bash

./scripts/release-undo.sh
```

This resets `package.json`, `package-lock.json`, and `CHANGELOG.md` to HEAD.

### Already Committed But Need Changes

If you ran `release-finalize.sh` but haven't pushed yet:

```bash

./scripts/release-undo.sh  # Deletes tag and resets commit
# Make your changes
./scripts/release-prepare.sh [type]
# Review again
./scripts/release-finalize.sh
```

### Release Failed After Pushing

If the GitHub Actions workflow fails after you've pushed:

1. **Check workflow logs**: https://github.com/IBM/ibmi-mcp-server/actions
2. **Common issues**:
   - Tests failing: Fix tests and create a patch release
   - npm token expired: Update `NPM_TOKEN` secret in GitHub Settings
   - Build errors: Fix build and create a patch release

### Wrong Version Published

If you published the wrong version:

1. **Delete GitHub release** (if you created one):
   ```bash
   gh release delete v0.2.0
   # Or delete manually in GitHub UI
   ```

2. **Unpublish from npm** (within 72 hours only):
   ```bash
   npm unpublish @ibm/ibmi-mcp-server@0.2.0
   ```

3. **Delete git tag**:
   ```bash
   git tag -d v0.2.0
   git push origin :refs/tags/v0.2.0
   ```

4. **Revert the release commit**:
   ```bash
   git revert HEAD
   git push origin main
   ```

5. **Create correct release**

### Changelog Not Generated

If CHANGELOG.md is empty or missing entries:

1. Ensure you're using conventional commit messages
2. Check that commits exist since the last tag
3. Manually edit CHANGELOG.md if needed
4. Commit the changes and create a patch release

### Can't Push --follow-tags

If you get permission errors:

1. Verify you have write access to the repository
2. Check branch protection rules allow tag creation
3. Ensure you're on the main branch

## Pre-Release Versions

To create beta, alpha, or release candidate versions:

```bash

# Create pre-release version
standard-version --prerelease alpha
# Creates: 0.2.0-alpha.0

# Subsequent pre-releases
standard-version --prerelease alpha
# Creates: 0.2.0-alpha.1

# Graduate to stable
npm run release
# Creates: 0.2.0
```

Push with `git push --follow-tags origin main` as usual.

## Release Checklist

### Before Prepare Phase

- [ ] All tests passing locally: `npm test`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] Code builds successfully: `npm run build`
- [ ] Commits use conventional format
- [ ] BREAKING CHANGES documented in commits if applicable
- [ ] Main branch is up-to-date: `git pull origin main`
- [ ] No uncommitted changes: `git status`

### During Review Phase

- [ ] Review generated `CHANGELOG.md`
- [ ] Enhance changelog with user-friendly descriptions
- [ ] Verify breaking changes are highlighted
- [ ] Check all version bumps are correct
- [ ] Optionally use Claude/AI for enhancement
- [ ] Manually edit if needed

### Before Finalize Phase

- [ ] Satisfied with `CHANGELOG.md` content
- [ ] Reviewed all changes: `git diff`
- [ ] Ready to commit and push

### After Pushing Release

- [ ] GitHub Actions workflow completed successfully
- [ ] Package published to npm
- [ ] Version visible with `npm view @ibm/ibmi-mcp-server`
- [ ] GitHub release created manually with polished notes
- [ ] Announce release (if applicable)

## First-Time Release

The initial release (v0.1.0) uses a special command:

```bash
# From root directory (recommended)
npm run release:first

# OR from server directory

npm run release:first
```

This creates the initial CHANGELOG.md and tags v0.1.0 without requiring commits since a previous release.

## Creating GitHub Releases

GitHub releases are created **manually** after npm publishing completes. This gives you full control over release note formatting and presentation.

### Quick Guide to Manual Release Creation

1. **Wait for npm publish to complete** (check GitHub Actions)
2. **Go to Releases page**: https://github.com/IBM/ibmi-mcp-server/releases
3. **Click "Draft a new release"**
4. **Choose your tag** from the dropdown (e.g., `v0.2.0`)
5. **Title your release** (e.g., "Version 0.2.0" or "v0.2.0 - OAuth Support")
6. **Write release notes** in the description:
   - Start with CHANGELOG.md content as a base
   - Enhance with user-friendly descriptions
   - Add sections: New Features, Improvements, Bug Fixes
   - Include links to docs, PRs, or issues
   - Use formatting: **bold**, `code`, bullet points
7. **Click "Publish release"**

### Release Notes Best Practices

**Good release notes include:**
- Clear summary of what changed
- User-facing feature descriptions (not just commit messages)
- Links to relevant documentation
- Migration guides for breaking changes
- Screenshots or code examples where helpful
- Contributor acknowledgments

**Example format:**
```markdown
## New Features 🎉

**OAuth2 Authentication**: Added modern OAuth2 support for secure IBM i connections. Configure your OAuth2 provider in connection settings. See [authentication docs](link).

## Improvements ⚡

**Performance**: Query execution is now 2x faster for large result sets.

## Bug Fixes 🐛

**Connection Timeout**: Fixed intermittent timeout issues when connecting to IBM i systems.

## What's Changed
* feat: add OAuth2 authentication by @ajshedivy in #123
* perf: optimize query execution by @contributor in #124
* fix: resolve connection timeout issue by @ajshedivy in #125

**Full Changelog**: https://github.com/IBM/ibmi-mcp-server/compare/v0.1.0...v0.2.0
```

## Publishing to npm is Automated

**Important:** Do **NOT** run `npm publish` manually. Publishing happens automatically via GitHub Actions when you push a release tag.

The workflow (`npm run release` → `git push --follow-tags`) triggers GitHub Actions, which:
1. Runs all validation (typecheck, lint, test)
2. Builds the package
3. **Publishes to npm automatically**

After npm publishing succeeds, you create the GitHub release manually (see "Creating GitHub Releases" section above).

### Manual Publishing (Emergency Only)

If you absolutely must publish manually (e.g., GitHub Actions is down):

```bash
# ONLY from server directory

npm publish

# For scoped packages (@ibm namespace)
npm publish --access public
```

**⚠️ Warning:** Manual publishing bypasses:
- Automated validation (tests, linting, type checking)
- Version consistency checks
- Audit trail in GitHub Actions
- Release environment approval gates

## Configuring the Release Environment

The workflow uses a GitHub "Release" environment for approval gates before npm publishing.

### Setup Steps:

Repository administrators should configure the "Release" environment:

1. Go to **Settings** → **Environments** → **New environment**
2. Name it: `Release`
3. Configure protection rules:
   - ✅ **Required reviewers**: Add team members who can approve npm publishes
   - ✅ **Wait timer**: Optional delay before publishing (e.g., 5 minutes)
   - ✅ **Deployment branches**: Limit to `main` branch only

### Environment Secrets:

The `Release` environment needs:
- `NPM_TOKEN` - npm authentication token with publish permissions for @ibm organization

### Benefits:

- **Manual approval**: Require approval before publishing to npm (even though automated)
- **Audit trail**: Track who approved each npm publish in GitHub
- **Branch protection**: Only publish from main branch
- **Prevent accidents**: Catch mistakes before they reach npm registry

## Additional Resources

- **Conventional Commits**: https://www.conventionalcommits.org/
- **standard-version**: https://github.com/conventional-changelog/standard-version
- **Semantic Versioning**: https://semver.org/
- **npm Provenance**: https://docs.npmjs.com/generating-provenance-statements
- **GitHub Environments**: https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment

## Getting Help

If you encounter issues:

1. Check GitHub Actions logs
2. Review npm publish logs
3. Verify Release environment configuration
4. Consult this documentation
5. Ask in the team chat or create an issue
