#!/usr/bin/env bash

# release-undo.sh
# Undoes a local release (before pushing).

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
    LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
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
    echo ""
    echo -e "${GREEN}✓ Release preparation undone successfully${NC}"
    exit 0
fi

# Scenario B: committed and tagged
if [ "$RELEASE_COMMIT" = true ]; then
    if [ -n "$LATEST_TAG" ] && git ls-remote --tags origin | grep -q "refs/tags/$LATEST_TAG"; then
        VERSION=${LATEST_TAG#v}
        echo -e "${RED}Error: Tag $LATEST_TAG has already been pushed to remote${NC}"
        echo ""
        echo "To undo a pushed release, you need to:"
        echo "  1. Delete the GitHub release (if created)"
        echo "  2. Unpublish from npm (within 72 hours):"
        echo -e "     ${GREEN}npm unpublish @ibm/ibmi-mcp-server@${VERSION}${NC}"
        echo -e "     ${GREEN}npm unpublish @ibm/ibmi-cli@${VERSION}${NC}"
        echo "  3. Delete the remote tag:"
        echo -e "     ${GREEN}git push origin :refs/tags/$LATEST_TAG${NC}"
        echo "  4. Reset the commit:"
        echo -e "     ${GREEN}git reset --hard HEAD~1${NC}"
        echo "  5. Force push:"
        echo -e "     ${GREEN}git push --force origin main${NC}"
        exit 1
    fi

    echo -e "${BLUE}Detected: Finalized release (committed and tagged)${NC}"
    [ -n "$LATEST_TAG" ] && echo "Release: $LATEST_TAG"
    echo "Commit: $(git rev-parse --short HEAD)"
    echo ""
    echo -e "${YELLOW}This will:${NC}"
    [ -n "$LATEST_TAG" ] && echo "  • Delete tag $LATEST_TAG"
    echo "  • Reset HEAD to previous commit"
    echo ""

    read -p "Are you sure you want to undo this release? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Undo cancelled"
        exit 0
    fi

    if [ -n "$LATEST_TAG" ]; then
        git tag -d "$LATEST_TAG"
        echo -e "${GREEN}✓ Deleted tag $LATEST_TAG${NC}"
    fi

    git reset --hard HEAD~1
    echo -e "${GREEN}✓ Reset to previous commit${NC}"
    exit 0
fi

echo -e "${YELLOW}No release found to undo${NC}"
exit 0
