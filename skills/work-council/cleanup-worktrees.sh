#!/usr/bin/env bash
# Remove one build-workflow run's worktrees and branches, then .claude/worktrees if that left it empty.
#   cleanup-worktrees.sh <run-id>            remove them
#   cleanup-worktrees.sh <run-id> --list     only print them
# Run from inside the repository. Touches only branches named worktree-<run-id>-<digits>.
set -euo pipefail

usage() {
  echo "usage: cleanup-worktrees.sh <wf_run-id> [--list]" >&2
  exit 2
}

# Validate everything before any git command: a typo must never fall through to removal.
(( $# == 1 || $# == 2 )) || usage
run_id="$1"
mode="${2:-remove}"
[[ "$run_id" =~ ^wf_[A-Za-z0-9_-]+$ ]] || usage
[[ "$mode" == remove || "$mode" == --list ]] || usage

root="$(git rev-parse --show-toplevel)"
prefix="worktree-${run_id}-"

# Exactly this run: the prefix followed only by the builder number. A longer run id that
# starts with this one (wf_a-1 vs wf_a-1-2) leaves a non-digit suffix and is skipped.
is_this_run() {
  local suffix="${1#"$prefix"}"
  [[ "$1" == "$prefix"* && "$suffix" =~ ^[0-9]+$ ]]
}

# Porcelain output: a "worktree <path>" line, then "branch refs/heads/<name>" for a checked-out branch.
path=''
while IFS= read -r line; do
  case "$line" in
    'worktree '*) path="${line#worktree }" ;;
    'branch refs/heads/'*)
      is_this_run "${line#branch refs/heads/}" || continue
      if [[ "$mode" == --list ]]; then
        echo "$path"
      else
        git worktree remove --force "$path"
      fi
      ;;
  esac
done < <(git worktree list --porcelain)

[[ "$mode" == --list ]] && exit 0

while IFS= read -r branch; do
  is_this_run "$branch" && git branch -D "$branch" >/dev/null
done < <(git for-each-ref --format='%(refname:short)' "refs/heads/${prefix}*")

# rmdir only succeeds on an empty directory, so another run's worktree or any file keeps it.
rmdir "$root/.claude/worktrees" 2>/dev/null || true
