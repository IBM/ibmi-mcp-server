#!/usr/bin/env bash

# release-finalize.sh
# Pushes the reviewed and approved release to GitHub

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  IBM i MCP Server - Finalize Release${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

cd "$SERVER_DIR"

# Check for uncommitted changes to release files
if git diff-index --quiet HEAD -- package.json package-lock.json CHANGELOG.md; then
    echo -e "${RED}Error: No release changes detected${NC}"
    echo "Run ./scripts/release-prepare.sh first to prepare a release"
    exit 1
fi

# Check if already committed (this would mean finalize was already run)
if [[ "$(git log -1 --pretty=%B)" =~ ^chore\(release\): ]]; then
    echo -e "${RED}Error: Release already committed${NC}"
    echo "The release has already been finalized."
    echo "To undo and start over, run: ./scripts/release-undo.sh"
    exit 1
fi

# Get version from package.json (since tag doesn't exist yet)
VERSION=$(node -p "require('./package.json').version")

echo "Release version: v$VERSION"
echo ""

# Show a preview of what will be committed
echo -e "${BLUE}Review the changelog one last time:${NC}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
# Extract just the latest version's changelog (up to the next version header)
awk '/^## \['$VERSION'\]/,/^## \[/ {if (/^## \[/ && !first) {first=1; print; next} if (!second && /^## \[/) {second=1; exit} if (first) print}' CHANGELOG.md
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo -e "${YELLOW}This will:${NC}"
echo "  • Stage: package.json, package-lock.json, CHANGELOG.md"
echo "  • Create commit: chore(release): $VERSION"
echo "  • Create tag: v$VERSION"
echo "  • Push commit and tag to origin/main"
echo "  • Trigger GitHub Actions workflow"
echo "  • Publish to npm (after workflow approval)"
echo ""

read -p "Are you ready to finalize this release? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Release cancelled"
    echo "Changes remain uncommitted. Run ./scripts/release-undo.sh to reset them."
    exit 0
fi

echo ""
echo -e "${BLUE}Creating release commit and tag...${NC}"

# Stage the release files
git add package.json package-lock.json CHANGELOG.md

# Create release commit
git commit -m "chore(release): $VERSION"
echo -e "${GREEN}✓ Created commit: chore(release): $VERSION${NC}"

# Create annotated tag
git tag -a "v$VERSION" -m "chore(release): $VERSION"
echo -e "${GREEN}✓ Created tag: v$VERSION${NC}"

echo ""
echo -e "${BLUE}Pushing to GitHub...${NC}"

# Push the commit and tag
git push --follow-tags origin main

echo ""
echo -e "${GREEN}✓ Release pushed successfully!${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo ""
echo "  1. Monitor GitHub Actions workflow:"
echo -e "     ${GREEN}https://github.com/IBM/ibmi-mcp-server/actions${NC}"
echo ""
echo "  2. Approve the Release environment if required"
echo ""
echo "  3. After npm publish succeeds, create GitHub release:"
echo -e "     ${GREEN}https://github.com/IBM/ibmi-mcp-server/releases/new?tag=v$VERSION${NC}"
echo ""
echo "  4. Verify npm publication:"
echo -e "     ${GREEN}npm view @ibm/ibmi-mcp-server@$VERSION${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Release v$VERSION is on its way! 🚀${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
