#!/usr/bin/env bash

# release-finalize.sh
# Commits the release prepared by release-prepare.sh, tags it, pushes to origin.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  IBM i MCP Server monorepo - Finalize Release${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

cd "$REPO_ROOT"

RELEASE_FILES=(
    package.json
    package-lock.json
    CHANGELOG.md
    packages/server/package.json
    packages/cli/package.json
)

if git diff-index --quiet HEAD -- "${RELEASE_FILES[@]}"; then
    echo -e "${RED}Error: No release changes detected${NC}"
    echo "Run ./scripts/release-prepare.sh first to prepare a release"
    exit 1
fi

if [[ "$(git log -1 --pretty=%B)" =~ ^chore\(release\): ]]; then
    echo -e "${RED}Error: Release already committed${NC}"
    echo "To undo, run: ./scripts/release-undo.sh"
    exit 1
fi

VERSION=$(node -p "require('./package.json').version")
echo "Release version: v$VERSION"
echo ""

echo -e "${BLUE}Review the changelog one last time:${NC}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
awk '/^## \['$VERSION'\]/,/^## \[/ {if (/^## \[/ && !first) {first=1; print; next} if (!second && /^## \[/) {second=1; exit} if (first) print}' CHANGELOG.md
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo -e "${YELLOW}This will:${NC}"
echo "  • Stage: ${RELEASE_FILES[*]}"
echo "  • Create commit: chore(release): $VERSION"
echo "  • Create tag: v$VERSION"
echo "  • Push commit + tag to origin/main"
echo "  • Trigger GitHub Actions workflow (publishes both packages)"
echo ""

read -p "Are you ready to finalize this release? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Release cancelled. Run ./scripts/release-undo.sh to reset changes."
    exit 0
fi

echo ""
echo -e "${BLUE}Creating release commit and tag...${NC}"

git add "${RELEASE_FILES[@]}"
git commit -s -m "chore(release): $VERSION"
echo -e "${GREEN}✓ Created commit: chore(release): $VERSION${NC}"

git tag -a "v$VERSION" -m "chore(release): $VERSION"
echo -e "${GREEN}✓ Created tag: v$VERSION${NC}"

echo ""
echo -e "${BLUE}Pushing to GitHub...${NC}"
git push --follow-tags origin main

echo ""
echo -e "${GREEN}✓ Release pushed successfully!${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "  1. Monitor: ${GREEN}https://github.com/IBM/ibmi-mcp-server/actions${NC}"
echo "  2. Approve the Release environment if required"
echo "  3. After both packages publish, create GitHub release:"
echo "     ${GREEN}https://github.com/IBM/ibmi-mcp-server/releases/new?tag=v$VERSION${NC}"
echo "  4. Verify npm publications:"
echo "     ${GREEN}npm view @ibm/ibmi-mcp-server@$VERSION${NC}"
echo "     ${GREEN}npm view @ibm/ibmi-cli@$VERSION${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Release v$VERSION is on its way! 🚀${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
