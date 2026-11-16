#!/usr/bin/env bash

# release-undo.sh
# Undoes a prepared release, or closes an unmerged release pull request.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo -e "${RED}  IBM i MCP Server monorepo - Undo Release${NC}"
echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo ""

cd "$REPO_ROOT"

RELEASE_FILES=(
    package.json
    package-lock.json
    CHANGELOG.md
    packages/server/package.json
    packages/cli/package.json
)

UNCOMMITTED_CHANGES=false
RELEASE_COMMIT=false

if ! git diff-index --quiet HEAD -- "${RELEASE_FILES[@]}"; then
    UNCOMMITTED_CHANGES=true
fi

if [[ "$(git log -1 --pretty=%B)" =~ ^chore\(release\): ]]; then
    RELEASE_COMMIT=true
fi

# Scenario A: only uncommitted prepare changes
if [ "$UNCOMMITTED_CHANGES" = true ] && [ "$RELEASE_COMMIT" = false ]; then
    echo -e "${BLUE}Detected: Uncommitted release preparation${NC}"
    echo ""
    echo -e "${YELLOW}This will reset the following files to HEAD:${NC}"
    for f in "${RELEASE_FILES[@]}"; do echo "  • $f"; done
    echo ""

    read -p "Are you sure you want to undo? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Undo cancelled"
        exit 0
    fi

    git checkout HEAD -- "${RELEASE_FILES[@]}"
    echo -e "${GREEN}✓ Reset release files to HEAD${NC}"
    echo "Release notes in .github/release-notes/ are left in place."
    echo ""
    echo -e "${GREEN}✓ Release preparation undone successfully${NC}"
    exit 0
fi

# Scenario B: release committed on a release/v<version> branch
if [ "$RELEASE_COMMIT" = true ]; then
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    VERSION=$(node -p "require('./package.json').version")

    if [ "$BRANCH" != "release/v$VERSION" ]; then
        echo -e "${RED}Error: HEAD is a release commit but the branch is '$BRANCH', not 'release/v$VERSION'${NC}"
        echo "Undo only works on an unmerged release branch."
        exit 1
    fi

    if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
        echo -e "${RED}Error: v$VERSION is already released (tag v$VERSION exists on origin)${NC}"
        echo "A published npm version cannot be reused. Release a new patch version instead."
        exit 1
    fi

    echo -e "${BLUE}Detected: Release commit on $BRANCH${NC}"
    echo ""
    echo -e "${YELLOW}This will:${NC}"
    echo "  • Close the release pull request and delete $BRANCH on origin (if pushed)"
    echo "  • Switch to main and delete the local $BRANCH branch"
    echo ""

    read -p "Are you sure you want to undo this release? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Undo cancelled"
        exit 0
    fi

    if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
        gh pr close "$BRANCH" --repo IBM/ibmi-mcp-server --delete-branch \
            || git push origin --delete "$BRANCH"
        echo -e "${GREEN}✓ Closed the release PR and deleted origin/$BRANCH${NC}"
    fi

    git switch main
    git branch -D "$BRANCH"
    echo -e "${GREEN}✓ Deleted local branch $BRANCH${NC}"
    exit 0
fi

echo -e "${YELLOW}No release found to undo${NC}"
exit 0
