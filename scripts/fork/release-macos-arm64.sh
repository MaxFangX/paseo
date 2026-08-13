#!/usr/bin/env bash
#
# Fork-only (maxfangx): build an unsigned production macOS arm64 desktop app
# and publish it to GitHub Releases on the fork.
#
# Usage: scripts/fork/release-macos-arm64.sh [options]
#   --branch <name>  Branch the release is named after (default: current git branch)
#   --commit <sha>   Commit to tag the release at (default: HEAD; must be pushed)
#   --dry-run        Build, smoke-test, and package, but skip publishing
#   --draft          Publish the GitHub release as a draft
#   --skip-build     Reuse packages/desktop/release/mac-arm64/Paseo.app from a prior run
#
# The release (and its tag) is named maxfangx-<branch>-<YYYY_MM_DD> (UTC date).
# A leading "maxfangx-" on the branch is not doubled, so branch
# maxfangx-v0.4.0-beta.2 releases as maxfangx-v0.4.0-beta.2-<date>.
#
# Publishing requires `gh` authed with push access to the target repo
# (override with PASEO_FORK_RELEASE_REPO) and HEAD pushed to that repo.
#
# Why not electron-builder's dmg/zip targets: without a Developer ID cert the
# bundle must be uniformly ad-hoc re-signed after packing (electron-builder
# leaves mismatched ad-hoc signatures that SIGABRT at launch on arm64), and
# electron-builder archives before we can re-sign — while repacking with --pd
# nests Paseo.app inside itself. So build the bare .app (mac.target=dir),
# re-sign, then package with hdiutil/ditto.

set -euo pipefail

cd "$(dirname "$0")/../.."

DRY_RUN=0 DRAFT=0 SKIP_BUILD=0 BRANCH="" COMMIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --draft) DRAFT=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$BRANCH" == "HEAD" ]]; then
    echo "detached HEAD; pass --branch <name>" >&2
    exit 1
  fi
fi

REPO="${PASEO_FORK_RELEASE_REPO:-MaxFangX/paseo}"
RELEASE_NAME="maxfangx-${BRANCH#maxfangx-}-$(date -u +%Y_%m_%d)"
RELEASE_NAME="${RELEASE_NAME//\//-}"
COMMIT="$(git rev-parse "${COMMIT:-HEAD}")"

APP="packages/desktop/release/mac-arm64/Paseo.app"
OUT_DIR="packages/desktop/release/fork"
DMG="$OUT_DIR/Paseo-$RELEASE_NAME-arm64.dmg"
ZIP="$OUT_DIR/Paseo-$RELEASE_NAME-arm64.zip"

echo "==> Release $RELEASE_NAME from $BRANCH @ $COMMIT (repo $REPO)"

if [[ "$SKIP_BUILD" == 0 ]]; then
  # The client compiles against relay's dist declarations, but build:desktop
  # only rebuilds relay later (inside the server build), so a stale local
  # relay dist fails the client build. Rebuild it first.
  npm run build:relay:clean

  # Unsigned build: skip cert discovery and notarization, and build only the
  # bare .app (dir target) since we package dmg/zip ourselves after re-signing.
  CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:desktop -- \
    --publish never --mac --arm64 -c.mac.notarize=false -c.mac.target=dir
fi

if [[ ! -d "$APP" ]]; then
  echo "missing $APP; run without --skip-build" >&2
  exit 1
fi

echo "==> Re-signing $APP with a uniform ad-hoc identity"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "==> Smoke-testing packaged app"
(
  cd packages/desktop
  node -e '
    const path = require("node:path");
    const { smokePackagedDesktopApp } = require("./e2e/packaged-app-smoke.js");
    smokePackagedDesktopApp({ appPath: path.resolve(process.argv[1]) }).then(
      () => process.exit(0),
      (err) => { console.error(err); process.exit(1); },
    );
  ' "release/mac-arm64/Paseo.app"
)

echo "==> Packaging dmg + zip"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
ditto "$APP" "$STAGING/Paseo.app"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname Paseo -srcfolder "$STAGING" -ov -format UDZO "$DMG"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "==> Dry run: skipping publish. Artifacts in $OUT_DIR"
  exit 0
fi

NOTES="Unsigned personal build of Paseo from branch \`$BRANCH\` at $COMMIT.

macOS blocks the first launch of unsigned apps: right-click Paseo.app and
choose Open, or run \`xattr -dr com.apple.quarantine /Applications/Paseo.app\`."

echo "==> Publishing $RELEASE_NAME to $REPO"
# The release tags $COMMIT on GitHub, which fails with an opaque 422 when the
# commit only exists locally. Check first.
if ! gh api "repos/$REPO/commits/$COMMIT" --silent 2> /dev/null; then
  echo "commit $COMMIT is not on $REPO; push the branch first" >&2
  exit 1
fi
if gh release view "$RELEASE_NAME" --repo "$REPO" > /dev/null 2>&1; then
  echo "release already exists; replacing assets"
  gh release upload "$RELEASE_NAME" "$DMG" "$ZIP" --clobber --repo "$REPO"
else
  draft_flag=()
  if [[ "$DRAFT" == 1 ]]; then
    draft_flag=(--draft)
  fi
  gh release create "$RELEASE_NAME" "$DMG" "$ZIP" \
    --repo "$REPO" \
    --target "$COMMIT" \
    --title "$RELEASE_NAME" \
    --notes "$NOTES" \
    ${draft_flag[@]+"${draft_flag[@]}"} # macOS bash 3.2 + set -u: empty "${a[@]}" is unbound
fi

echo "==> Done: https://github.com/$REPO/releases/tag/$RELEASE_NAME"
