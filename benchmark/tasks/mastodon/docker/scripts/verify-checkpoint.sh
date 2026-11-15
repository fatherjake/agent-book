#!/bin/bash
# verify-checkpoint.sh [dir]  (default /workspace)
# Fails unless <dir> is a clean git repo whose history is exactly one commit, with no other refs,
# remotes, packs, reflogs, stashes, shallow info or unreachable objects.
set -euo pipefail
cd "${1:-/workspace}"
fail() { echo "verify-checkpoint: FAIL: $*" >&2; exit 1; }

[ "$(git rev-list --all --count)" = 1 ] || fail "expected exactly 1 commit, got $(git rev-list --all --count)"
[ -z "$(git rev-list --max-parents=0 HEAD | sed 1d)" ] || fail "more than one root"
refs=$(git for-each-ref --format='%(refname)')
[ "$refs" = refs/heads/main ] || fail "unexpected refs: $refs"
[ -z "$(git remote)" ] || fail "remotes present: $(git remote)"
[ ! -e .git/shallow ] || fail ".git/shallow present"
[ ! -e .git/packed-refs ] || [ -z "$(grep -v '^#' .git/packed-refs | grep -v ' refs/heads/main$' || true)" ] || fail "extra packed refs"
[ ! -d .git/logs ] || [ -z "$(find .git/logs -type f)" ] || fail "reflogs present"
[ ! -e .git/refs/stash ] || fail "stash present"
for f in FETCH_HEAD ORIG_HEAD MERGE_HEAD; do [ ! -e ".git/$f" ] || fail ".git/$f present"; done
packs=$(find .git/objects/pack -name '*.pack' | wc -l)
[ "$packs" -le 1 ] || fail "$packs packs"
all=$(git cat-file --batch-all-objects --batch-check='%(objectname)' | sort)
reachable=$(git rev-list --objects --all | cut -d' ' -f1 | sort)
[ "$all" = "$reachable" ] || fail "object store holds $(comm -23 <(echo "$all") <(echo "$reachable") | wc -l) unreachable objects"
[ -z "$(git status --porcelain --ignore-submodules=none)" ] || { git status --porcelain | head -20 >&2; fail "working tree not clean"; }
echo "verify-checkpoint: OK $(git rev-parse HEAD) ($(echo "$all" | wc -l) objects, $packs pack)"
