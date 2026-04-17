#!/usr/bin/env bash

# release-undo.sh
# Undoes a local release (before pushing)
# Handles both scenarios:
# 1. Uncommitted changes from prepare phase
# 2. Committed/tagged from finalize phase

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo -e "${RED}  IBM i MCP Server - Undo Release${NC}"
echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo ""

cd "$SERVER_DIR"

# Detect current state
UNCOMMITTED_CHANGES=false
RELEASE_COMMIT=false

# Check for uncommitted changes to release files
if ! git diff-index --quiet HEAD -- package.json package-lock.json CHANGELOG.md; then
    UNCOMMITTED_CHANGES=true
fi

# Check if HEAD is a release commit
if [[ "$(git log -1 --pretty=%B)" =~ ^chore\(release\): ]]; then
    RELEASE_COMMIT=true
    LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
fi

# Handle Scenario A: Only uncommitted changes (prepare phase)
if [ "$UNCOMMITTED_CHANGES" = true ] && [ "$RELEASE_COMMIT" = false ]; then
    echo -e "${BLUE}Detected: Uncommitted release preparation${NC}"
    echo ""
    echo -e "${YELLOW}This will reset the following files to HEAD:${NC}"
    echo "  • package.json"
    echo "  • package-lock.json"
    echo "  • CHANGELOG.md"
    echo ""

    read -p "Are you sure you want to undo the release preparation? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Undo cancelled"
        exit 0
    fi

    echo ""
    echo -e "${BLUE}Resetting uncommitted changes...${NC}"

    # Reset the files to HEAD
    git checkout HEAD -- package.json package-lock.json CHANGELOG.md
    echo -e "${GREEN}✓ Reset release files to HEAD${NC}"

    echo ""
    echo -e "${GREEN}✓ Release preparation undone successfully${NC}"
    echo ""
    echo "You can now run ./scripts/release-prepare.sh again if needed"
    echo ""
    exit 0
fi

# Handle Scenario B: Committed and tagged (finalize phase)
if [ "$RELEASE_COMMIT" = true ]; then
    # Check if tag has been pushed
    if [ -n "$LATEST_TAG" ] && git ls-remote --tags origin | grep -q "refs/tags/$LATEST_TAG"; then
        echo -e "${RED}Error: Tag $LATEST_TAG has already been pushed to remote${NC}"
        echo ""
        echo "To undo a pushed release, you need to:"
        echo "  1. Delete the GitHub release (if created)"
        echo "  2. Unpublish from npm (within 72 hours):"
        echo -e "     ${GREEN}npm unpublish @ibm/ibmi-mcp-server@${LATEST_TAG#v}${NC}"
        echo "  3. Delete the remote tag:"
        echo -e "     ${GREEN}git push origin :refs/tags/$LATEST_TAG${NC}"
        echo "  4. Reset the commit:"
        echo -e "     ${GREEN}git reset --hard HEAD~1${NC}"
        echo "  5. Force push:"
        echo -e "     ${GREEN}git push --force origin main${NC}"
        echo ""
        exit 1
    fi

    echo -e "${BLUE}Detected: Finalized release (committed and tagged)${NC}"
    if [ -n "$LATEST_TAG" ]; then
        echo "Release: $LATEST_TAG"
    fi
    echo "Commit: $(git rev-parse --short HEAD)"
    echo ""
    echo -e "${YELLOW}This will:${NC}"
    if [ -n "$LATEST_TAG" ]; then
        echo "  • Delete tag $LATEST_TAG"
    fi
    echo "  • Reset HEAD to previous commit"
    echo "  • Discard version bump and changelog changes"
    echo ""

    read -p "Are you sure you want to undo this release? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Undo cancelled"
        exit 0
    fi

    echo ""
    echo -e "${BLUE}Undoing release...${NC}"

    # Delete the tag if it exists
    if [ -n "$LATEST_TAG" ]; then
        git tag -d "$LATEST_TAG"
        echo -e "${GREEN}✓ Deleted tag $LATEST_TAG${NC}"
    fi

    # Reset to previous commit
    git reset --hard HEAD~1
    echo -e "${GREEN}✓ Reset to previous commit${NC}"

    echo ""
    echo -e "${GREEN}✓ Release undone successfully${NC}"
    echo ""
    echo "You can now make changes and run ./scripts/release-prepare.sh again"
    echo ""
    exit 0
fi

# No release to undo
echo -e "${YELLOW}No release found to undo${NC}"
echo ""
echo "There are no uncommitted release changes or release commits to undo."
echo ""
exit 0
