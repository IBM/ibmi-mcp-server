#!/usr/bin/env bash

# release-prepare.sh
# Generates a draft changelog and version bump for the monorepo.
# Both @ibm/ibmi-mcp-server and @ibm/ibmi-cli get the same version.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  IBM i MCP Server monorepo - Release Preparation${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

cd "$REPO_ROOT"

if ! git diff-index --quiet HEAD --; then
    echo -e "${RED}Error: Working directory has uncommitted changes${NC}"
    echo "Please commit or stash your changes before preparing a release"
    exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo -e "${YELLOW}Warning: You're on branch '$CURRENT_BRANCH', not 'main'${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

RELEASE_TYPE=${1:-auto}

echo -e "${BLUE}Step 1: Running prerelease checks across workspaces${NC}"
echo ""

echo "Running tests..."
if ! npm test --workspaces --if-present; then
    echo ""
    echo -e "${RED}Error: Tests failed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Tests passed${NC}"
echo ""

echo "Running typecheck..."
if ! npm run typecheck --workspaces --if-present; then
    echo ""
    echo -e "${RED}Error: Type checking failed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Typecheck passed${NC}"
echo ""

echo -e "${BLUE}Step 2: Bumping version and generating changelog${NC}"
echo "Release type: $RELEASE_TYPE"
echo ""

# standard-version at root updates root package.json + CHANGELOG.md,
# then sync-workspace-versions.mjs propagates the version into both
# packages/*/package.json and pins the CLI's server dep to exact.
if [ "$RELEASE_TYPE" == "auto" ]; then
    npx standard-version --skip.commit --skip.tag
elif [ "$RELEASE_TYPE" == "patch" ]; then
    npx standard-version --skip.commit --skip.tag --release-as patch
elif [ "$RELEASE_TYPE" == "minor" ]; then
    npx standard-version --skip.commit --skip.tag --release-as minor
elif [ "$RELEASE_TYPE" == "major" ]; then
    npx standard-version --skip.commit --skip.tag --release-as major
else
    echo -e "${RED}Error: Invalid release type '$RELEASE_TYPE'${NC}"
    echo "Valid types: auto, patch, minor, major"
    exit 1
fi

node "$SCRIPT_DIR/sync-workspace-versions.mjs"

NEW_VERSION=$(node -p "require('./package.json').version")

echo ""
echo -e "${GREEN}✓ Version bumped to $NEW_VERSION across all workspaces${NC}"
echo -e "${GREEN}✓ Changelog generated${NC}"
echo -e "${GREEN}✓ Files ready for review (not committed yet)${NC}"
echo ""

echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  REVIEW REQUIRED${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "  1. Review changes: ${GREEN}git diff${NC}"
echo "  2. Review changelog: ${GREEN}cat CHANGELOG.md${NC}"
echo "  3. When satisfied, finalize: ${GREEN}./scripts/release-finalize.sh${NC}"
echo "  4. To undo, run: ${GREEN}./scripts/release-undo.sh${NC}"
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
