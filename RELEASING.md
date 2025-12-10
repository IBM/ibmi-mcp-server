# Release Process for IBM i MCP Server

This document describes the automated release process for the `server/` package (`@ibm/ibmi-mcp-server` on npm).

## Overview

The release process uses `standard-version` to automate:
- Version bumping in `package.json` and `package-lock.json`
- Changelog generation from commit messages
- Git tag creation
- GitHub release creation with release notes
- npm package publication

## Prerequisites

1. **Commit Access**: You must have push access to the `main` branch
2. **npm Publishing Rights**: Verify you have publish permissions for `@ibm/ibmi-mcp-server` (requires access to `@ibm` organization)
3. **Release Environment Access**: You must be approved for the "Release" environment in GitHub (repository maintainers can configure this)
4. **Clean Working Directory**: Ensure all changes are committed
5. **Up-to-date main**: Pull latest changes from `origin/main`

## Release Workflow

### Step 1: Ensure Clean State

```bash
# Switch to main branch
git checkout main

# Pull latest changes
git pull origin main

# Verify clean working directory
git status
```

### Step 2: Run Automated Release

The release process uses conventional commits to determine version bumps automatically.

**Note:** All release commands can be run from the **root directory** or from `server/`.

#### Automatic Version Bump (Recommended)

```bash
# From root directory (recommended)
npm run release

# OR from server directory
cd server
npm run release
```

This analyzes your commits since the last release and automatically:
- Bumps **patch** version (0.1.0 → 0.1.1) for bug fixes
- Bumps **minor** version (0.1.0 → 0.2.0) for new features
- Bumps **major** version (0.1.0 → 1.0.0) for breaking changes

#### Manual Version Bump

If you want to specify the version bump type explicitly:

```bash
# From root directory (recommended)
npm run release:patch   # Patch release (0.1.0 → 0.1.1)
npm run release:minor   # Minor release (0.1.0 → 0.2.0)
npm run release:major   # Major release (0.1.0 → 1.0.0)

# OR from server directory
cd server
npm run release:patch
npm run release:minor
npm run release:major
```

**What standard-version does:**
1. Bumps version in `package.json` and `package-lock.json`
2. Generates/updates `CHANGELOG.md` with commits since last release
3. Creates git commit: `chore(release): 0.2.0`
4. Creates git tag: `v0.2.0`

### Step 3: Review Changes (Recommended)

Before pushing, review what standard-version created:

```bash
# View the generated changelog
cat server/CHANGELOG.md

# View the release commit
git show HEAD

# Check the tag was created
git tag -l
```

### Step 4: Undo Release (If Needed)

If something looks wrong, undo before pushing:

```bash
# Delete the tag
git tag -d v0.2.0

# Undo the commit
git reset --hard HEAD~1
```

Then fix the issues and run `npm run release` again.

### Step 5: Push to Trigger Automation

```bash
# Push the commit and tag together
git push --follow-tags origin main
```

**This triggers the GitHub Actions workflow which:**
1. Runs type checking, linting, and tests
2. Builds the package
3. Publishes to npm with provenance

**Note:** GitHub releases are created manually (see Step 6 below)

### Step 6: Create GitHub Release (Manual)

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

1. **Verify npm**: `npm view @ibm/ibmi-mcp-server`
2. **Check workflow**: https://github.com/IBM/ibmi-mcp-server/actions
3. **Confirm GitHub release**: https://github.com/IBM/ibmi-mcp-server/releases

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

## Troubleshooting

### Release Failed After Pushing

If the GitHub Actions workflow fails:

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
cd server

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

Before creating a release:

- [ ] All tests passing locally: `npm test`
- [ ] Code builds successfully: `npm run build`
- [ ] Commits use conventional format
- [ ] BREAKING CHANGES documented if applicable
- [ ] Main branch is up-to-date
- [ ] No uncommitted changes
- [ ] Ready for changelog review

After pushing release:

- [ ] GitHub Actions workflow completed successfully
- [ ] Package published to npm
- [ ] Version visible with `npm view @ibm/ibmi-mcp-server`
- [ ] GitHub release created manually with polished notes
- [ ] CHANGELOG.md updated in repository

## First-Time Release

The initial release (v0.1.0) uses a special command:

```bash
# From root directory (recommended)
npm run release:first

# OR from server directory
cd server
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
cd server
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
