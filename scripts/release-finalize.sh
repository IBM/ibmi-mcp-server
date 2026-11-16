#!/usr/bin/env bash

# release-finalize.sh
# Commits the release prepared by release-prepare.sh on a release/v<version>
# branch, pushes it, and opens the release pull request. Merging that pull
# request starts .github/workflows/release.yml, which tags, publishes and
# creates the GitHub Release.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="IBM/ibmi-mcp-server"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  IBM i MCP Server monorepo - Open Release PR${NC}"
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
NOTES=".github/release-notes/v$VERSION.md"
BRANCH="release/v$VERSION"

if [ ! -s "$NOTES" ]; then
    echo -e "${RED}Error: $NOTES is missing or empty${NC}"
    echo "Write the release notes first (the /release skill does this)."
    exit 1
fi

echo "Release version: v$VERSION"
echo ""
echo -e "${YELLOW}This will:${NC}"
echo "  • Create branch $BRANCH"
echo "  • Commit ${RELEASE_FILES[*]} $NOTES"
echo "    as: chore(release): $VERSION"
echo "  • Push the branch and open a pull request against main"
echo ""
echo "Nothing is published until the pull request is merged and the"
echo "Release environment is approved."
echo ""

read -p "Open the release PR? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled. Run ./scripts/release-undo.sh to reset changes."
    exit 0
fi

git switch -c "$BRANCH"
git add "${RELEASE_FILES[@]}" "$NOTES"
git commit -s -m "chore(release): $VERSION"
echo -e "${GREEN}✓ Committed chore(release): $VERSION on $BRANCH${NC}"

git push -u origin "$BRANCH"

BODY=$(mktemp)
{
    echo "Merging this pull request releases **v$VERSION** of \`@ibm/ibmi-mcp-server\` and \`@ibm/ibmi-cli\`."
    echo ""
    echo "After the merge, the [Release workflow](https://github.com/$REPO/actions/workflows/release.yml) runs the checks and waits for approval of the \`Release\` environment. Then it tags \`v$VERSION\`, publishes both packages to npm and the image to ghcr.io, and creates the GitHub Release from \`$NOTES\`."
    echo ""
    echo "The release notes below are the GitHub Release body. Edit \`$NOTES\` on this branch to change them."
    echo ""
    echo "---"
    echo ""
    cat "$NOTES"
} > "$BODY"

PR_URL=$(gh pr create --repo "$REPO" --base main --head "$BRANCH" \
    --title "chore(release): $VERSION" --body-file "$BODY")
rm -f "$BODY"

echo ""
echo -e "${GREEN}✓ Release PR opened: $PR_URL${NC}"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "  1. Review and merge the PR"
echo "  2. Approve the Release environment:"
echo -e "     ${GREEN}https://github.com/$REPO/actions/workflows/release.yml${NC}"
