#!/usr/bin/env bash
set -euo pipefail

# release.sh — Tag and push a new CortexKit Antigravity auth monorepo release
#
# Usage:
#   ./scripts/release.sh --prepare 1.7.0 # commit version sync, without tagging
#   ./scripts/release.sh 1.7.0        # verify, tag and push prepared v1.7.0
#   ./scripts/release.sh 1.7.0 --dry  # preview without committing/pushing

PREPARE=""
if [[ "${1:-}" == "--prepare" ]]; then
  PREPARE="yes"
  shift
fi
VERSION="${1:-}"
DRY="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh [--prepare] <version> [--dry]"
  echo "  e.g. ./scripts/release.sh 1.7.0"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z)"
  exit 1
fi

TAG="v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag '$TAG' already exists"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean — commit or stash changes first"
  git status --short
  exit 1
fi

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
  echo "Warning: releasing from '$BRANCH' (not main/master)"
  read -rp "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""
echo "  Releasing CortexKit Antigravity auth packages $TAG"
echo "  ───────────────────────────────────────────────"
echo ""

if [[ "$DRY" == "--dry" ]]; then
  echo "→ Version sync (dry run):"
  node scripts/version-sync.mjs "$VERSION" --dry-run
  echo ""
  if [[ -n "$PREPARE" ]]; then
    echo "[DRY RUN] Would commit version sync; no gate, tag or push."
  else
    echo "[DRY RUN] Would verify the prepared commit and native-inert gate, tag $TAG, and push to origin."
  fi
  exit 0
fi

if [[ -n "$PREPARE" ]]; then
  echo "→ Syncing version to $VERSION..."
  node scripts/version-sync.mjs "$VERSION"
  bun scripts/sync-release-lock.ts "$VERSION"
  echo "→ Committing version bump..."
  git add packages/core/package.json packages/opencode/package.json packages/pi/package.json bun.lock
  if git diff --cached --quiet; then
    echo "  (no changes — version already at $VERSION)"
  else
    git commit -m "release: $TAG"
  fi
  echo "Prepared $TAG. No gate, tag or push was run."
  echo "Run the MOTOR native-inert gate and record its stdout, then ./scripts/release.sh $VERSION."
  exit 0
fi

echo "→ Verifying CI workflows on the exact release commit..."
bun scripts/check-release-ci.ts

echo ""

echo "→ Verifying the prepared version-sync commit..."
bun scripts/check-release-version.ts "$VERSION"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: pre-release checks changed the working tree — refusing to tag"
  exit 1
fi

echo "→ Verifying the native-inert gate on the exact release commit..."
bun scripts/check-native-inert-release.ts

echo "→ Creating tag $TAG..."
git tag -a "$TAG" -m "Release $TAG"
echo ""

echo "→ Pushing to origin..."
git push origin "$BRANCH"
git push origin "$TAG"
echo ""

echo "  ✓ Released $TAG"
echo "  → GitHub Actions will now: test → build → publish core, OpenCode, and Pi packages"
echo "  → Watch: https://github.com/cortexkit/antigravity-auth/actions"
