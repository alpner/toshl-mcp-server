#!/usr/bin/env bash
# Updates a local checkout that an MCP client (Claude Desktop) runs over stdio, to the fork's
# deploy/vps: the same code the VPS runs. Fork-only; never part of an upstream PR.
#
#   scripts/update-local-checkout.sh
#
# Quit the MCP client first and start it again afterwards; it runs dist/src/index.js from here.
#
# The checkout gets a local branch "desktop" that is reset to <fork>/deploy/vps on every run,
# so force-pushes of deploy/vps are fine. (deploy/vps itself can't be the branch here when
# another worktree has it checked out.) Remote found by URL; override with FORK_REMOTE.
set -euo pipefail

BRANCH=deploy/vps
LOCAL_BRANCH=desktop
FORK_REPO=alpner/toshl-mcp-server

die() { echo "!! $*" >&2; exit 1; }
step() { echo "==> $*"; }

cd "$(git rev-parse --show-toplevel)"

FORK=${FORK_REMOTE:-$(git remote -v | awk -v repo="$FORK_REPO" '$2 ~ repo"(\\.git)?$" && $3 == "(fetch)" { print $1; exit }')}
[ -n "$FORK" ] || die "no remote for $FORK_REPO; set FORK_REMOTE"

dirty=$(git status --porcelain --untracked-files=no)
[ -z "$dirty" ] || die "uncommitted changes would be lost; commit or stash them first:
$dirty"

current=$(git branch --show-current || true)
if [ -n "$current" ] && [ "$current" != "$LOCAL_BRANCH" ]; then
    # Anything not on deploy/vps would vanish from the checkout (the branch itself is kept).
    git fetch --quiet "$FORK"
    extra=$(git log --oneline --no-merges "$FORK/$BRANCH..HEAD")
    [ -z "$extra" ] || die "$current has commits that aren't on $FORK/$BRANCH:
$extra"
fi

step "Fetching $FORK/$BRANCH"
git fetch --quiet "$FORK"
git checkout --quiet -B "$LOCAL_BRANCH" "$FORK/$BRANCH"
git branch --quiet --set-upstream-to="$FORK/$BRANCH" "$LOCAL_BRANCH"
echo "    $LOCAL_BRANCH is now at $(git log --oneline -1)"

if [ -f package-lock.json ] && ! git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
    echo "    note: untracked package-lock.json from an earlier npm install; yarn.lock is the lockfile."
    echo "          Delete it so a stray npm install can't bring back old versions."
fi

step "Installing (frozen lockfile, no lifecycle scripts)"
npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts --silent
step "Building"
npx tsc
test -f dist/src/index.js || die "dist/src/index.js missing after the build"

step "Done. Start your MCP client again."
