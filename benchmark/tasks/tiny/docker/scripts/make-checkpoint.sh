#!/bin/bash
# make-checkpoint.sh <dir> <repo-url> <commit> [strip-path ...]
#
# Materialise tiny at <commit> in <dir> with a fresh, single-commit git history ("checkpoint"):
# nothing about the upstream history is reachable. [strip-path ...] are removed first (the
# author's own agent instruction files). Used by the image build (task.Dockerfile) and by the
# host-side tree export (image.ts checkpoint-tree / ref-tree), so both produce byte-identical
# trees and the same commit id.
set -euo pipefail
dir=$1
repo=$2
commit=$3
shift 3

[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "make-checkpoint: commit must be a full sha1" >&2; exit 2; }
mkdir -p "$dir"
cd "$dir"
if [ -n "$(ls -A .)" ]; then echo "make-checkpoint: $dir is not empty" >&2; exit 2; fi

git init -q .
git fetch -q --depth 1 "$repo" "$commit"
[ "$(git rev-parse FETCH_HEAD)" = "$commit" ] || { echo "make-checkpoint: fetched $(git rev-parse FETCH_HEAD), wanted $commit" >&2; exit 1; }
git -c advice.detachedHead=false checkout -q FETCH_HEAD
rm -rf .git
for p in "$@"; do
  case "$p" in /*|*..*) echo "make-checkpoint: bad strip path $p" >&2; exit 2 ;; esac
  rm -rf -- "./$p"
done

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
echo "make-checkpoint: $(git rev-parse HEAD) (tiny $commit)"
