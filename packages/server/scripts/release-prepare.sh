#!/usr/bin/env bash

# release-prepare.sh
# Generates a draft changelog and version bump, then pauses for review

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  IBM i MCP Server - Release Preparation${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Check if we're in a clean state
if ! git diff-index --quiet HEAD --; then
    echo -e "${RED}Error: Working directory has uncommitted changes${NC}"
    echo "Please commit or stash your changes before preparing a release"
    exit 1
fi

# Check if we're on main
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo -e "${YELLOW}Warning: You're on branch '$CURRENT_BRANCH', not 'main'${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Get the release type from argument or use auto
RELEASE_TYPE=${1:-auto}

echo -e "${BLUE}Step 1: Running prerelease checks${NC}"
echo ""

cd "$SERVER_DIR"

# Run tests
echo "Running tests..."
if ! npm test; then
    echo ""
    echo -e "${RED}Error: Tests failed${NC}"
    echo "Please fix failing tests before preparing a release"
    exit 1
fi

echo -e "${GREEN}✓ Tests passed${NC}"
echo ""

# Run typecheck
echo "Running typecheck..."
if ! npm run typecheck; then
    echo ""
    echo -e "${RED}Error: Type checking failed${NC}"
    echo "Please fix type errors before preparing a release"
    exit 1
fi

echo -e "${GREEN}✓ Typecheck passed${NC}"
echo ""

echo -e "${BLUE}Step 2: Generating changelog and version bump${NC}"
echo "Release type: $RELEASE_TYPE"
echo ""

# Run standard-version with --skip.commit --skip.tag flags
# This generates the changelog and bumps version WITHOUT creating commit/tag
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

# Get the new version from package.json
NEW_VERSION=$(node -p "require('./package.json').version")

echo ""
echo -e "${GREEN}✓ Version bumped to $NEW_VERSION${NC}"
echo -e "${GREEN}✓ Changelog generated${NC}"
echo -e "${GREEN}✓ Files ready for review (not committed yet)${NC}"
echo ""

echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  REVIEW REQUIRED${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "The changelog has been auto-generated from commits, but may need enhancement."
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo ""
echo "  1. Review the changes:"
echo -e "     ${GREEN}git diff${NC}"
echo ""
echo "  2. Review the generated changelog:"
echo -e "     ${GREEN}cat CHANGELOG.md${NC}"
echo ""
echo "  3. (Optional) Enhance the changelog with Claude:"
echo -e "     ${GREEN}claude \"Review and enhance the v$NEW_VERSION changelog for clarity\"${NC}"
echo ""
echo "  4. (Optional) Manually edit CHANGELOG.md if needed:"
echo -e "     ${GREEN}vim CHANGELOG.md${NC}"
echo ""
echo "  5. When satisfied with the changes, finalize the release:"
echo -e "     ${GREEN}./scripts/release-finalize.sh${NC}"
echo ""
echo "  6. To undo this preparation (resets uncommitted changes):"
echo -e "     ${GREEN}./scripts/release-undo.sh${NC}"
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
