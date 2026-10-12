#!/usr/bin/env bash
# Starts one fresh Claude session and one fresh Codex session, side by side, each
# given only the review prompt, in the given checkout. Waits for both and writes
# their final messages and exit codes into the run folder.
#
# Usage: launch.sh <checkout dir> <run dir> <prompt>
set -u

wt="$1"
run="$2"
prompt="$3"

mkdir -p "$run"
printf '%s\n' "$prompt" > "$run/prompt.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$run/started_at"

# Claude: print mode is a new session with no history; auto mode lets it run its
# review workflow without stopping for approvals.
(
  cd "$wt" && claude -p "$prompt" --permission-mode auto --output-format text \
    < /dev/null > "$run/claude.md" 2> "$run/claude.err"
  echo $? > "$run/claude.exit"
) &
claude_pid=$!

# Codex: stdin must be closed, or exec waits for more input forever.
(
  codex exec -m gpt-6-astra --approve-for-me \
    -c sandbox_workspace_write.network_access=true \
    -C "$wt" -o "$run/codex.md" "$prompt" \
    < /dev/null > "$run/codex.log" 2>&1
  echo $? > "$run/codex.exit"
) &
codex_pid=$!

echo "claude=$claude_pid codex=$codex_pid" > "$run/pids"
wait "$claude_pid" "$codex_pid"
date -u +%Y-%m-%dT%H:%M:%SZ > "$run/finished_at"
echo "claude exit=$(cat "$run/claude.exit" 2>/dev/null) codex exit=$(cat "$run/codex.exit" 2>/dev/null) run=$run"
