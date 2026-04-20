#!/bin/bash

# Usage: ./scripts/list-prs.sh <from-tag> <to-tag> [--detailed]
# Example: ./scripts/list-prs.sh v0.1.2 v0.2.0
# Example: ./scripts/list-prs.sh v0.1.2 v0.2.0 --detailed
LATEST_TAG=$(git describe --tags --abbrev=0)
echo "Latest Tag Detected: $LATEST_TAG"

FROM_TAG=${1:-"$LATEST_TAG"}
TO_TAG=${2:-"HEAD"}
DETAILED=${3:-""}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Release Changes: $FROM_TAG → $TO_TAG"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Count total commits
TOTAL_COMMITS=$(git log $FROM_TAG..$TO_TAG --oneline --no-merges | wc -l | tr -d ' ')
PR_COMMITS=$(git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="#[0-9]" | wc -l | tr -d ' ')

echo "📊 Summary: $TOTAL_COMMITS total commits ($PR_COMMITS with PR numbers)"
echo ""

# ============================================================
# SECTION 1: Merged Pull Requests (sorted by PR number)
# ============================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Merged Pull Requests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$DETAILED" = "--detailed" ]; then
  git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="#[0-9]" | \
    sort -t'#' -k2 -n | \
    nl -w2 -s'. '
else
  git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="#[0-9]" | \
    sed -E 's/^[0-9a-f]+ //' | \
    sort -t'#' -k2 -n | \
    nl -w2 -s'. '
fi

# ============================================================
# SECTION 2: Commits by Conventional Type
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Commits by Type (Conventional Commits)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Features
FEAT_COUNT=$(git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="^feat" | wc -l | tr -d ' ')
if [ "$FEAT_COUNT" -gt 0 ]; then
  echo "✨ Features ($FEAT_COUNT):"
  git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="^feat" | \
    sed -E 's/^[0-9a-f]+ //' | nl -w2 -s'.  '
  echo ""
fi

# Fixes
FIX_COUNT=$(git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="^[Ff]ix" | wc -l | tr -d ' ')
if [ "$FIX_COUNT" -gt 0 ]; then
  echo "🐛 Bug Fixes ($FIX_COUNT):"
  git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="^[Ff]ix" | \
    sed -E 's/^[0-9a-f]+ //' | nl -w2 -s'.  '
  echo ""
fi

# Documentation
DOCS_COUNT=$(git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="^[Dd]ocs\|^[Uu]pdate.*[Dd]ocs\|^[Aa]dd.*[Dd]ocs" | wc -l | tr -d ' ')
if [ "$DOCS_COUNT" -gt 0 ]; then
  echo "📚 Documentation ($DOCS_COUNT):"
  git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="^[Dd]ocs\|^[Uu]pdate.*[Dd]ocs\|^[Aa]dd.*[Dd]ocs" | \
    sed -E 's/^[0-9a-f]+ //' | nl -w2 -s'.  '
  echo ""
fi

# Chores/Dependencies
CHORE_COUNT=$(git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="^chore\|[Dd]ependenc" | wc -l | tr -d ' ')
if [ "$CHORE_COUNT" -gt 0 ]; then
  echo "🔧 Chores & Dependencies ($CHORE_COUNT):"
  git log $FROM_TAG..$TO_TAG --oneline --no-merges --grep="^chore\|[Dd]ependenc" | \
    sed -E 's/^[0-9a-f]+ //' | nl -w2 -s'.  '
  echo ""
fi

# ============================================================
# SECTION 3: All Commits (for reference)
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  All Commits"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$DETAILED" = "--detailed" ]; then
  git log $FROM_TAG..$TO_TAG --oneline --no-merges | nl -w2 -s'. '
else
  git log $FROM_TAG..$TO_TAG --oneline --no-merges | \
    sed -E 's/^[0-9a-f]+ //' | nl -w2 -s'. '
fi

# ============================================================
# SECTION 4: Suggested Changelog Categorization
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  💡 Changelog Suggestions"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Determine version bump suggestion
if [ "$FEAT_COUNT" -gt 0 ]; then
  echo "📦 Suggested Version Bump: MINOR (new features detected)"
elif [ "$FIX_COUNT" -gt 0 ]; then
  echo "📦 Suggested Version Bump: PATCH (bug fixes only)"
else
  echo "📦 Suggested Version Bump: PATCH (documentation/chores)"
fi

echo ""
echo "📝 Focus on PR-based changes (${PR_COMMITS} commits with PR numbers)"
echo "   Individual commits without PRs can often be grouped or omitted"
echo ""
echo "Use: ./scripts/list-prs.sh $FROM_TAG $TO_TAG --detailed"
echo "     to see commit hashes for detailed analysis"
echo ""
