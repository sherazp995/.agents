#!/usr/bin/env bash
# Caller-side watchdog for a rethink (or review) run folder. Start it in the background next to the lead.
# Usage: watch-run.sh <run dir> <done file name> <deadline seconds> [stall seconds] [poll seconds]
#   Exits when <run dir>/<done file name> is non-empty (0), when no file under <run dir> (subfolders too) changed for
#   <stall seconds> (3, default 1500), or when <deadline seconds> passed since start (4).
#   Exit 2: bad arguments. Prints one line saying which, then the newest files.
# To change this file, write a new copy and rename it over this one (mv); see run-planner.sh.
set -u
die() { echo "watch-run: $*" >&2; exit 2; }

[ "$#" -ge 3 ] && [ "$#" -le 5 ] || die "expected 3 to 5 arguments, got $#"
dir="$1" done_name="$2" limit="$3" stall="${4:-1500}" poll="${5:-60}"
[ -d "$dir" ] || die "run dir is not a directory: $dir"
case "$done_name" in ''|*/*) die "done file must be a plain file name: $done_name" ;; esac
for n in "$limit" "$stall" "$poll"; do
  case "$n" in ''|*[!0-9]*) die "seconds must be positive integers: $n" ;; esac
  [ "$((10#$n))" -gt 0 ] || die "seconds must be positive integers: $n"
done
limit=$((10#$limit)) stall=$((10#$stall)) poll=$((10#$poll))

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
  if [ $(( now - start )) -ge "$limit" ]; then
    echo "DEADLINE: ${limit} s passed"; newest; exit 4
  fi
  sleep "$poll"
done
