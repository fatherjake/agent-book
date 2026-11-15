#!/bin/bash
# make-checkpoint.sh <dir> <upstream-commit> [patch-dir]
#
# Materialise mastodon/mastodon at <upstream-commit> in <dir> with a fresh, single-commit git
# history ("checkpoint"): nothing about upstream history (and so nothing about the future) is
# reachable. Patches in [patch-dir] (*.patch, applied in order) are environment-compatibility fixes
# (e.g. yanked gem versions in Gemfile.lock); they are part of the checkpoint commit.
#
# Used by the image build (task.Dockerfile) and by the host-side reference-tree export
# (image.ts `ref-tree`), so both produce byte-identical trees and the same commit id.
set -euo pipefail
dir=$1
commit=$2
patches=${3:-}
repo=${MASTODON_REPO_URL:-https://github.com/mastodon/mastodon.git}

[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "make-checkpoint: commit must be a full sha1" >&2; exit 2; }
mkdir -p "$dir"
cd "$dir"
if [ -n "$(ls -A .)" ]; then echo "make-checkpoint: $dir is not empty" >&2; exit 2; fi

git init -q .
git fetch -q --depth 1 "$repo" "$commit"
[ "$(git rev-parse FETCH_HEAD)" = "$commit" ] || { echo "make-checkpoint: fetched $(git rev-parse FETCH_HEAD), wanted $commit" >&2; exit 1; }
git -c advice.detachedHead=false checkout -q FETCH_HEAD
rm -rf .git

if [ -n "$patches" ] && [ -d "$patches" ]; then
  for p in "$patches"/*.patch; do
    [ -e "$p" ] || continue
    echo "make-checkpoint: applying $(basename "$p")"
    git apply --whitespace=nowarn "$p"
  done
fi

# Fresh history: one commit, fixed identity and dates (reproducible commit id), no reflogs.
git init -q -b main .
git config core.logAllRefUpdates false
git config gc.auto 0
git add -A
GIT_AUTHOR_NAME=frugal GIT_AUTHOR_EMAIL=frugal@localhost GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' \
GIT_COMMITTER_NAME=frugal GIT_COMMITTER_EMAIL=frugal@localhost GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' \
  git commit -q --no-verify --no-gpg-sign -m checkpoint
git repack -adq
git prune --expire=now
rm -rf .git/logs .git/hooks/*.sample .git/FETCH_HEAD .git/ORIG_HEAD .git/COMMIT_EDITMSG .git/description
echo "make-checkpoint: $(git rev-parse HEAD) (upstream $commit)"
