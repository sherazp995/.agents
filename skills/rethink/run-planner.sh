#!/usr/bin/env bash
# One advisor call for the rethink skill: read-only, stopped only when idle or runaway, with an output check.
# Usage: run-planner.sh claude|codex <repo dir> <prompt file> <out file> <idle seconds> [sections] [effort]
#   <idle seconds>: the call is killed only when its answer, stream and log all stop growing for this long;
#   a call that keeps producing output keeps running. RETHINK_CEILING (default 2700) caps one call's total
#   seconds, to catch a runaway loop; RETHINK_POLL (default 10) is how often growth is checked.
#   <effort> (codex only): low, medium or high (default high). Pass "" as <sections> to skip the check.
#   Paths must be absolute. <sections> is a "|"-separated list. Each item is a heading line such as
#   "## Steps" (it must appear as a whole line and its section must hold a non-blank line), or
#   "## Verdict=approve,changes needed" (also: the section's first non-blank line, trimmed, must be
#   one of the comma-separated values).
# Writes <out file> (the answer), <out file>.prompt (guard + prompt as sent), <out file>.log
# (stderr and CLI noise), <out file>.stream (claude only: stream-json events; the answer is taken from
# its result event) and <out file>.meta (side, model, exit, seconds, check).
# Exit: 0 valid; 2 bad arguments or setup (nothing run); 3 output empty, missing a heading or no result;
#       124 stopped (check says idle or ceiling); 130 cancelled; other = the CLI's own failure.
# To change this file, write a new copy and rename it over this one (mv). Never edit it in place:
# bash reads a running script as it goes, so an in-place edit breaks calls already running.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
die() { echo "run-planner: $*" >&2; exit 2; }

[ "$#" -ge 5 ] && [ "$#" -le 7 ] || die "expected 5 to 7 arguments, got $#"
side="$1" repo="$2" prompt="$3" out="$4" limit="$5" need="${6:-}" effort="${7:-high}"
ceiling="${RETHINK_CEILING:-2700}" poll="${RETHINK_POLL:-10}"
case "$effort" in low|medium|high) ;; *) die "effort must be low, medium or high: $effort" ;; esac
case "$side" in claude) model="opus" ;; codex) model="gpt-6-astra" ;; *) die "unknown planner: $side" ;; esac
for p in "$repo" "$prompt" "$out"; do case "$p" in /*) ;; *) die "path must be absolute: $p" ;; esac; done
for n in "$limit" "$ceiling" "$poll"; do
  case "$n" in ''|*[!0-9]*) die "seconds must be positive integers: $n" ;; esac
  [ "$((10#$n))" -gt 0 ] || die "seconds must be positive integers: $n"
done
limit=$((10#$limit)) ceiling=$((10#$ceiling)) poll=$((10#$poll))
[ -d "$repo" ] || die "repo is not a directory: $repo"
[ -r "$prompt" ] || die "prompt not readable: $prompt"
[ -r "$here/guard.md" ] || die "guard.md missing: $here/guard.md"
full="$out.prompt" log="$out.log" meta="$out.meta" stream="$out.stream"
real() { ( cd "$(dirname "$1")" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename "$1")" ); }
rprompt="$(real "$prompt")"
[ -n "$rprompt" ] || die "cannot resolve prompt path: $prompt"
for p in "$full" "$log" "$meta" "$stream" "$out"; do
  rp="$(real "$p")" || die "output directory missing: $p"
  [ -n "$rp" ] || die "output directory missing: $p"
  [ "$rp" != "$rprompt" ] || die "output path collides with the prompt: $p"
done
if [ -n "$need" ]; then
  case "$need" in *'|') die "empty section spec at the end of: $need" ;; esac
  IFS='|' read -r -a heads <<< "$need"
  for h in "${heads[@]}"; do [ -n "$h" ] || die "empty heading in: $need"; done
fi
tbin="$(command -v timeout || command -v gtimeout || true)"
[ -n "$tbin" ] || die "needs GNU timeout (brew install coreutils)"

code=2 check="not run" start=$(date +%s) pid=""
write_meta() {
  printf 'side: %s\nmodel: %s\neffort: %s\nexit: %s\nseconds: %s\ncheck: %s\n' \
    "$side" "$model" "$effort" "$code" "$(( $(date +%s) - start ))" "$check" > "$meta" \
    || { echo "run-planner: cannot write $meta" >&2; code=2; }
}
# GNU timeout leads its own process group, so signal the whole group: timeout, planner, children.
stop_group() {
  kill -TERM -- "-$1" 2>/dev/null
  sleep 5; kill -KILL -- "-$1" 2>/dev/null
}
cancel() {
  [ -n "$pid" ] && stop_group "$pid"
  code=130 check="cancelled"; write_meta; exit 130
}
trap cancel INT TERM HUP

{ cat "$here/guard.md" && printf '\n' && cat "$prompt"; } > "$full" || { check="prompt assembly failed"; write_meta; exit 2; }
{ : > "$out" && { [ "$side" != claude ] || : > "$stream"; }; } || { check="cannot write output"; write_meta; exit 2; }
cd "$repo" || { check="cannot enter repo"; write_meta; exit 2; }

if [ "$side" = claude ]; then
  "$tbin" --kill-after=30 "$ceiling" claude -p --model "$model" --permission-mode plan --permission-prompts none \
    --tools "Read,Grep,Glob" --strict-mcp-config --no-session-persistence --settings '{"disableAllHooks":true}' \
    --output-format stream-json --verbose --include-partial-messages < "$full" > "$stream" 2> "$log" &
else
  git_flag=""
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git_flag="--skip-git-repo-check"
  "$tbin" --kill-after=30 "$ceiling" codex exec -C "$repo" -m "$model" --sandbox read-only -c approval_policy=never \
    --ignore-user-config --ignore-rules --ephemeral --color never $git_flag \
    -c "model_reasoning_effort=\"$effort\"" -c 'mcp_servers={}' -o "$out" - < "$full" > "$log" 2>&1 &
fi
pid=$!

# Idle watch: progress is growth of the answer, the stream or the log. Only silence stops a call.
grown() { cat "$out" "$stream" "$log" 2>/dev/null | wc -c | tr -d ' '; }
idle=0 seen=-1 moved=$start
while kill -0 "$pid" 2>/dev/null; do
  now=$(date +%s) size=$(grown)
  if [ "$size" != "$seen" ]; then
    seen=$size moved=$now
  elif [ $(( now - moved )) -ge "$limit" ]; then
    idle=1; stop_group "$pid"; break
  fi
  sleep "$poll"
done
wait "$pid"
code=$?
pid=""
elapsed=$(( $(date +%s) - start ))
if [ "$idle" -eq 1 ]; then
  code=124 check="idle"
elif [ "$code" -eq 124 ] || { [ "$code" -eq 137 ] && [ "$elapsed" -ge "$ceiling" ]; }; then
  code=124 check="ceiling"
elif [ "$code" -ne 0 ]; then
  check="cli failed"
elif [ "$side" = claude ] && ! python3 -I "$here/stream-result.py" "$stream" "$out"; then
  code=3 check="no result in stream"
elif [ ! -s "$out" ]; then
  code=3 check="empty"
else
  check="ok"
  if [ -n "$need" ]; then
    for h in "${heads[@]}"; do
      name="${h%%=*}" vals=""
      [ "$name" != "$h" ] && vals="${h#*=}"
      awk -v H="$name" -v V="$vals" '
        { l = $0; sub(/[ \t\r]+$/, "", l) }
        l == H { found = 1; insec = 1; next }
        insec && /^## / { insec = 0 }
        insec && NF && first == "" { first = $0 }
        END {
          if (!found) exit 4
          if (first == "") exit 5
          if (V == "") exit 0
          g = first; gsub(/^[ \t]+|[ \t\r]+$/, "", g)
          n = split(V, a, ","); for (i = 1; i <= n; i++) if (g == a[i]) exit 0
          exit 6
        }' "$out"
      case $? in
        0) ;;
        4) code=3; check="missing heading line: $name"; break ;;
        5) code=3; check="empty section: $name"; break ;;
        6) code=3; check="bad value in $name (allowed: $vals)"; break ;;
        *) code=3; check="section check failed on $name"; break ;;
      esac
    done
  fi
fi
write_meta
exit "$code"
