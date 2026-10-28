#!/usr/bin/env bash
# Caller-side watchdog for a rethink (or review) run folder. Start it in the background next to the lead.
# Usage: watch-run.sh <run dir> <done file name> [stall seconds] [poll seconds]
#   Exits when <run dir>/<done file name> is non-empty (0), or when no file under <run dir> (subfolders too, planner
#   logs included) changed for <stall seconds> (3, default 900). There is no deadline: a run that keeps writing runs on.
#   Exit 2: bad arguments. Prints one line saying which, then the newest files.
# To change this file, write a new copy and rename it over this one (mv); see run-planner.sh.
set -u
die() { echo "watch-run: $*" >&2; exit 2; }

[ "$#" -ge 2 ] && [ "$#" -le 4 ] || die "expected 2 to 4 arguments, got $#"
dir="$1" done_name="$2" stall="${3:-900}" poll="${4:-60}"
[ -d "$dir" ] || die "run dir is not a directory: $dir"
case "$done_name" in ''|*/*) die "done file must be a plain file name: $done_name" ;; esac
for n in "$stall" "$poll"; do
  case "$n" in ''|*[!0-9]*) die "seconds must be positive integers: $n" ;; esac
  [ "$((10#$n))" -gt 0 ] || die "seconds must be positive integers: $n"
done
stall=$((10#$stall)) poll=$((10#$poll))

start=$(date +%s) last=$start
# Progress = a file newer than the marker from the previous check (find -newer works on BSD and GNU find).
mark="$(mktemp "${TMPDIR:-/tmp}/watch-run.XXXXXX")" next="$mark.next"
trap 'rm -f "$mark" "$next"' EXIT
newest() { ls -lt "$dir" | sed -n '2,6p'; }
while :; do
  now=$(date +%s)
  if [ -s "$dir/$done_name" ]; then
    echo "DONE: $done_name written after $(( now - start )) s"; exit 0
  fi
  : > "$next"
  if [ -n "$(find "$dir" -type f -newer "$mark" 2>/dev/null | head -1)" ]; then last=$now; fi
  mv -f "$next" "$mark"
  if [ $(( now - last )) -ge "$stall" ]; then
    echo "STALL: no file changed for ${stall} s, at $(( now - start )) s"; newest; exit 3
  fi
  sleep "$poll"
done
