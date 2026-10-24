#!/usr/bin/env bash
# Run fresh Claude and Codex reviews concurrently, collecting both outcomes.
# Usage: launch.sh <checkout dir> <run dir> <prompt>
set -u

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <checkout dir> <run dir> <prompt>" >&2
  exit 2
fi
wt="$1"
run="$2"
prompt="$3"
mkdir -p "$run" || exit 1
run=$(cd "$run" && pwd) || exit 1
# Callers may precreate the folder. Reserve it atomically, and keep the marker
# after completion so a second launch cannot overwrite this run's evidence.
if [[ -e "$run/started_at" ]] || ! mkdir "$run/.launcher-started" 2>/dev/null; then
  echo "Run directory already used: $run; choose a new run directory" >&2
  exit 2
fi
printf '%s\n' "$prompt" > "$run/prompt.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$run/started_at"

claude_pid=
codex_pid=
finish() {
  local status="$1"
  printf '%s\n' "$status" > "$run/launcher.exit"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$run/finished_at"
  echo "claude exit=$(cat "$run/claude.exit" 2>/dev/null) codex exit=$(cat "$run/codex.exit" 2>/dev/null) run=$run"
}
interrupt() {
  local status="$1" signal="$2" pid reviewer
  trap '' INT TERM HUP
  printf '%s\n' "$signal" > "$run/interrupted"
  # Job control gives each owned reviewer its own process group. Terminate the
  # whole group, including workflow children, without touching other reviews.
  for pid in "$claude_pid" "$codex_pid"; do
    [[ -z "$pid" ]] || kill -TERM -- "-$pid" 2>/dev/null || true
  done
  # Nested workflow runners need their own one-second cleanup grace first.
  sleep 2
  for pid in "$claude_pid" "$codex_pid"; do
    [[ -z "$pid" ]] || kill -KILL -- "-$pid" 2>/dev/null || true
  done
  for pid in "$claude_pid" "$codex_pid"; do
    [[ -z "$pid" ]] || wait "$pid" 2>/dev/null || true
  done
  for reviewer in claude codex; do
    [[ -s "$run/$reviewer.exit" ]] || printf '%s\n' "$status" > "$run/$reviewer.exit"
  done
  finish "$status"
  exit "$status"
}
trap 'interrupt 130 INT' INT
trap 'interrupt 143 TERM' TERM
trap 'interrupt 129 HUP' HUP
set -m

# Preserve the established fresh-session invocations and output files.
(
  cd "$wt" && claude -p "$prompt" --permission-mode auto --output-format text \
    < /dev/null > "$run/claude.md" 2> "$run/claude.err"
  status=$?
  printf '%s\n' "$status" > "$run/claude.exit"
  exit "$status"
) &
claude_pid=$!
(
  codex exec -m gpt-6-astra --approve-for-me \
    -c sandbox_workspace_write.network_access=true \
    -C "$wt" -o "$run/codex.md" "$prompt" \
    < /dev/null > "$run/codex.log" 2>&1
  status=$?
  printf '%s\n' "$status" > "$run/codex.exit"
  exit "$status"
) &
codex_pid=$!
printf 'claude=%s codex=%s\n' "$claude_pid" "$codex_pid" > "$run/pids"

# Wait separately: wait with multiple PIDs returns only the last one's status.
claude_status=0
codex_status=0
wait "$claude_pid" || claude_status=$?
wait "$codex_pid" || codex_status=$?
status=0
if [[ "$claude_status" -ne 0 ]]; then
  status=$claude_status
elif [[ "$codex_status" -ne 0 ]]; then
  status=$codex_status
fi
for reviewer in claude codex; do
  if [[ ! -s "$run/$reviewer.md" ]] || ! LC_ALL=C grep -q '[^[:space:]]' "$run/$reviewer.md"; then
    echo "$reviewer did not produce a nonempty report" >&2
    [[ "$status" -ne 0 ]] || status=1
  fi
done
finish "$status"
exit "$status"
