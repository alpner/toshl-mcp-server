#!/usr/bin/env bash
# Rebuilds the fork's deploy/vps branch: upstream master plus the open PRs listed in DEPLOY.md.
# Fork-only; never part of an upstream PR.
#
#   scripts/rebuild-deploy-branch.sh             rebuild, build, test, push
#   scripts/rebuild-deploy-branch.sh --no-push   same, but leave the push to you
#
# Steps:
#   1. Read the PR table from DEPLOY.md (working tree, so an uncommitted edit counts).
#   2. With gh available, refuse if a listed PR is no longer open or its branch differs.
#   3. Fetch upstream and the fork, then recreate deploy/vps from upstream/master.
#   4. Merge each PR branch from the fork, in table order. A conflict stops the script,
#      unless git rerere already holds a recorded resolution for it.
#   5. Put the fork-only files (FORK_ONLY_PATHS) back as one commit on top.
#   6. Frozen install (--ignore-scripts), tsc, credential-free tests.
#   7. Push with --force-with-lease against the deploy/vps the fork had before.
#
# Then deploy on the server: ssh root@<server> /srv/toshl-mcp/deploy.sh
#
# Remotes are found by URL; override with UPSTREAM_REMOTE / FORK_REMOTE.
set -euo pipefail

BRANCH=deploy/vps
UPSTREAM_REPO=hktari/toshl-mcp-server
FORK_REPO=alpner/toshl-mcp-server
# Files that exist only on deploy/vps. They are carried over from the working tree.
FORK_ONLY_PATHS=(DEPLOY.md deploy scripts/rebuild-deploy-branch.sh scripts/update-local-checkout.sh)

push=true
case "${1:-}" in
    --no-push) push=false ;;
    '') ;;
    *) echo "usage: $0 [--no-push]" >&2; exit 2 ;;
esac

die() { echo "!! $*" >&2; exit 1; }
step() { echo "==> $*"; }

cd "$(git rev-parse --show-toplevel)"

remote_for() {
    git remote -v | awk -v repo="$1" '$2 ~ repo"(\\.git)?$" && $3 == "(fetch)" { print $1; exit }'
}
UPSTREAM=${UPSTREAM_REMOTE:-$(remote_for "$UPSTREAM_REPO")}
FORK=${FORK_REMOTE:-$(remote_for "$FORK_REPO")}
[ -n "$UPSTREAM" ] || die "no remote for $UPSTREAM_REPO; set UPSTREAM_REMOTE"
[ -n "$FORK" ] || die "no remote for $FORK_REPO; set FORK_REMOTE"

# 1. PR list: table rows like  | [#45](...) | `fix/some-branch` | ... |
mapfile -t ROWS < <(sed -nE 's/^\| *\[#([0-9]+)\]\([^)]*\) *\| *`([^`]+)` *\|.*/\1 \2/p' DEPLOY.md)
[ "${#ROWS[@]}" -gt 0 ] || die "no PR rows found in DEPLOY.md"
step "PRs from DEPLOY.md, in merge order:"
for row in "${ROWS[@]}"; do
    read -r number branch <<<"$row"
    echo "    #$number  $branch"
done

# Only the fork-only files may differ from what was pushed; anything else would be lost.
dirty=$(git status --porcelain --untracked-files=no -- . "${FORK_ONLY_PATHS[@]/#/:!}")
[ -z "$dirty" ] || die "uncommitted changes outside the fork-only files:
$dirty"

# 2. PR state, when gh can tell us.
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    for row in "${ROWS[@]}"; do
        read -r number branch <<<"$row"
        info=$(gh pr view "$number" --repo "$UPSTREAM_REPO" --json state,headRefName --jq '"\(.state) \(.headRefName)"')
        read -r state head <<<"$info"
        [ "$state" = OPEN ] || die "#$number is $state upstream: remove it from DEPLOY.md, then rerun"
        [ "$head" = "$branch" ] || die "#$number's branch is $head, but DEPLOY.md says $branch"
    done
    step "All listed PRs are open"
else
    echo "    (gh unavailable: skipping the PR state check)"
fi

# 3. Fetch, snapshot the fork-only files, recreate the branch.
step "Fetching $UPSTREAM and $FORK"
git fetch --quiet --prune "$UPSTREAM"
git fetch --quiet --prune "$FORK"
lease=$(git rev-parse --verify --quiet "refs/remotes/$FORK/$BRANCH" || true)

if [ "$(git branch --show-current)" = "$BRANCH" ] && [ -n "$lease" ]; then
    stray=$(git log --format='%h %s' "$lease..HEAD" -- . "${FORK_ONLY_PATHS[@]/#/:!}")
    [ -z "$stray" ] || die "local $BRANCH has commits outside the fork-only files that would be lost:
$stray"
fi

snapshot="$(git rev-parse --git-dir)/deploy-fork-only-snapshot"
rm -rf "$snapshot"
mkdir -p "$snapshot"
for path in "${FORK_ONLY_PATHS[@]}"; do
    if [ -e "$path" ]; then
        mkdir -p "$snapshot/$(dirname "$path")"
        cp -R "$path" "$snapshot/$path"
    fi
done
echo "    fork-only files saved in $snapshot"

step "Recreating $BRANCH from $UPSTREAM/master ($(git rev-parse --short "$UPSTREAM/master"))"
# --force: the only local changes left are fork-only files, and those are in the snapshot.
git checkout --quiet --force -B "$BRANCH" "$UPSTREAM/master"

# 4. Merge each PR. rerere replays resolutions recorded on earlier rebuilds.
for row in "${ROWS[@]}"; do
    read -r number branch <<<"$row"
    git rev-parse --verify --quiet "refs/remotes/$FORK/$branch" >/dev/null || die "$FORK/$branch not found"
    if git -c rerere.enabled=true -c rerere.autoUpdate=true merge --quiet --no-ff --no-edit \
        -m "Merge #$number ($branch) into $BRANCH" "$FORK/$branch" >/dev/null 2>&1; then
        echo "    merged #$number $branch"
        continue
    fi
    # rerere stages only the files it fully resolved; anything left unmerged needs a human.
    unresolved=$(git diff --name-only --diff-filter=U)
    if [ -z "$unresolved" ] && git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
        git -c core.editor=true commit --quiet --no-edit
        echo "    merged #$number $branch (conflict resolved from the recorded resolution)"
        continue
    fi
    echo "!! #$number $branch conflicts in:" >&2
    echo "$unresolved" | sed 's/^/     /' >&2
    cat >&2 <<EOF
   Resolve, then: git -c rerere.enabled=true commit --no-edit   (rerere records it for next time)
   and rerun this script. Or give up: git merge --abort && git checkout -B $BRANCH $FORK/$BRANCH
   Fork-only files from before the rebuild are in $snapshot
EOF
    exit 1
done

# 5. Fork-only files back on top.
for path in "${FORK_ONLY_PATHS[@]}"; do
    if [ -e "$snapshot/$path" ]; then
        mkdir -p "$(dirname "$path")"
        rm -rf "$path"
        cp -R "$snapshot/$path" "$path"
        git add -- "$path"
    fi
done
for script in deploy/*.sh scripts/rebuild-deploy-branch.sh scripts/update-local-checkout.sh; do
    if [ -e "$script" ]; then
        git update-index --chmod=+x -- "$script"
    fi
done
git commit --quiet -m "deploy: fork-only deployment files

DEPLOY.md, deploy/ and scripts/ for running $BRANCH on the VPS. Not part
of any upstream PR."
step "Fork-only files committed on top"

# 6. Build and credential-free tests.
step "Installing (frozen lockfile, no lifecycle scripts)"
npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts --silent
step "Typecheck and build"
npx tsc
# No leading "/": Git Bash would rewrite it into a Windows path and every live suite would run.
if npx jest --testPathIgnorePatterns 'node_modules' 'tests.api.' --listTests | grep -E 'tests[/\\]api[/\\]' >/dev/null; then
    die "live API suites would run; refusing"
fi
step "Credential-free tests"
if ! results=$(npx jest --testPathIgnorePatterns 'node_modules' 'tests.api.' 2>&1); then
    echo "$results" | grep -E '^(FAIL|Tests:|Test Suites:)|●' | head -n 30 >&2
    die "tests failed; not pushing"
fi
echo "$results" | grep -E '^(Tests|Test Suites):' | sed 's/^/    /'

# 7. Push.
if [ -n "$lease" ]; then
    step "Changes against the deployed $BRANCH ($(git rev-parse --short "$lease")):"
    git diff --stat "$lease" HEAD | tail -n 15
fi
if ! $push; then
    step "Not pushed (--no-push). Push with: git push --force-with-lease=$BRANCH:${lease:-} $FORK $BRANCH"
    exit 0
fi
step "Pushing $BRANCH to $FORK"
git push --quiet --force-with-lease="$BRANCH:${lease}" "$FORK" "$BRANCH"
step "Done: $(git rev-parse --short HEAD). Deploy with: ssh root@<server> /srv/toshl-mcp/deploy.sh"
