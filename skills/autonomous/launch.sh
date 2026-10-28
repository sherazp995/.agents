#!/usr/bin/env bash
# Start an autonomous run: build approved plans unattended, one headless session per repo.
#
#   launch.sh [--slack-channel C --slack-thread T] [<plan>...]
#   launch.sh --resume <run id>
#
# Every plan must pass `plan-approval.py verify`; one that does not is recorded as stopped with the
# reason (and printed), and the others still run. With no plan paths it takes every plan under
# ~/.agents/tmp/plans that verifies and still has an unticked step. Plans are grouped by their
# `Repo:` line; each group gets its own headless session, all started at once, and a group's plans
# run in order inside its session, so no two sessions touch one checkout. Sessions run detached
# (their own process session, stdin closed), so they outlive the chat that started them; this
# script returns at once and prints the run id.
#
# Engine: `claude -p` with bypassPermissions and the no-remote-writes PreToolUse hook (--settings),
# else, when claude is not installed, `codex exec` with the same hook wired through -c overrides.
# AUTONOMOUS_ENGINE=claude|codex picks one. The session gets AGENTS_AUTONOMOUS_RUN=<run dir>.
# AGENTS_AUTONOMOUS_ROOT and AGENTS_PLANS_DIR move the run and plan folders (tests use them).
set -u

here=$(cd "$(dirname "$0")" && pwd)
agents=$(cd "$here/../.." && pwd)
root=${AGENTS_AUTONOMOUS_ROOT:-$agents/tmp/autonomous}
plans_dir=${AGENTS_PLANS_DIR:-$agents/tmp/plans}
state_py="$here/run-state.py"
adapter="$agents/hooks/adapters/run.py"

usage() {
  echo "Usage: $0 [--slack-channel C --slack-thread T] [<plan>...] | --resume <run id>" >&2
  exit 2
}

state() { python3 "$state_py" "$@"; }

# Read one value from state.json: state_get <run dir> <python expression over s>.
state_get() {
  python3 -c 'import json,sys; s=json.load(open(sys.argv[1]+"/state.json")); print(eval(sys.argv[2]))' "$1" "$2"
}

pick_engine() {
  local wanted=${AUTONOMOUS_ENGINE:-}
  if [[ -z "$wanted" ]]; then
    if command -v claude > /dev/null 2>&1; then wanted=claude
    elif command -v codex > /dev/null 2>&1; then wanted=codex
    else
      echo "autonomous: neither claude nor codex is installed; nothing can run the plans" >&2
      exit 1
    fi
  fi
  case "$wanted" in
    claude|codex) ;;
    *) echo "autonomous: AUTONOMOUS_ENGINE must be claude or codex, not $wanted" >&2; exit 2 ;;
  esac
  if ! command -v "$wanted" > /dev/null 2>&1; then
    echo "autonomous: $wanted is not installed" >&2
    exit 1
  fi
  if [[ ! -x "$adapter" || ! -x "$agents/hooks/bin/no-remote-writes" ]]; then
    echo "autonomous: the no-remote-writes guard is missing ($agents/hooks); refusing to run unguarded" >&2
    exit 1
  fi
  echo "$wanted"
}

# The headless session for one group, run in the foreground of a detached process (see spawn).
run_group() {
  local run_dir=$1 group=$2 engine repo prompt status outcome text report
  engine=$(state_get "$run_dir" 's["engine"]')
  repo=$(state_get "$run_dir" "s['groups'][$group]['repo']")
  prompt=$(cat "$run_dir/group-$group.prompt.txt")
  export AGENTS_AUTONOMOUS_RUN="$run_dir"
  # Checks must leave no untracked files, or every stage's tree hash goes stale (__pycache__ did, 2026-10-29).
  export PYTHONDONTWRITEBYTECODE=1
  # Headless claude kills background tasks 10 minutes after the last turn otherwise.
  export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
  cd "$repo" || { state group-exit "$run_dir" "$group" 1; return 1; }
  local hook="$adapter $engine no-remote-writes --fail-closed"
  if [[ "$engine" == claude ]]; then
    python3 -c 'import json,sys; print(json.dumps({"hooks": {"PreToolUse": [{"matcher": "Bash|Monitor|mcp__.*|Artifact.*",
      "hooks": [{"type": "command", "command": sys.argv[1], "timeout": 30}]}]}}, indent=2))' "$hook" \
      > "$run_dir/claude-settings.json"
    claude -p "$prompt" --permission-mode bypassPermissions --settings "$run_dir/claude-settings.json" \
      --output-format text < /dev/null > "$run_dir/group-$group.out" 2> "$run_dir/group-$group.err"
    status=$?
  else
    # Codex runs a -c registered hook only when its hash is trusted under hooks.state; the hash is
    # sha256 of the handler's identity as sorted compact JSON (relay/src/autonomous/worker-config.ts).
    local overrides=()
    while IFS= read -r line; do overrides+=(-c "$line"); done < <(python3 -c '
import hashlib, json, sys
command = sys.argv[1]
identity = {"event_name": "pre_tool_use", "hooks": [{"async": False, "command": command, "timeout": 30,
            "type": "command"}], "matcher": "Bash"}
digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                        .encode()).hexdigest()
key = "/<session-flags>/config.toml:pre_tool_use:0:0"
print("hooks.PreToolUse=[{matcher=\"Bash\",hooks=[{type=\"command\",command=%s,timeout=30}]}]" % json.dumps(command))
print("hooks.state={%s={trusted_hash=%s}}" % (json.dumps(key), json.dumps("sha256:" + digest)))' "$hook")
    codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C "$repo" "${overrides[@]}" \
      -o "$run_dir/group-$group.out" "$prompt" < /dev/null > "$run_dir/group-$group.err" 2>&1
    status=$?
  fi
  outcome=$(state group-exit "$run_dir" "$group" "$status")
  # A session that ended before its group was done, when no other session is left to report: the
  # runner sends the run's report itself, so the user always hears how the run ended.
  if [[ "$outcome" == "crashed last" ]]; then
    report=$(state report "$run_dir")
    text="Autonomous run $(basename "$run_dir") ended early: the session for $repo exited ($status) with tasks unfinished. Resume with \`$here/launch.sh --resume $(basename "$run_dir")\`."
    if [[ "$(state_get "$run_dir" 'bool(s["slack"])')" == True ]]; then
      relay live say --channel "$(state_get "$run_dir" 's["slack"]["channel"]')" \
        --thread "$(state_get "$run_dir" 's["slack"]["thread"]')" --text "$text" --file "$report"
    else
      relay notify --file "$report" "$text"
    fi
  fi
  return "$status"
}

# Start one group's session detached and record it.
spawn() {
  local run_dir=$1 group=$2 repo tasks log pid
  repo=$(state_get "$run_dir" "s['groups'][$group]['repo']")
  tasks=$(state_get "$run_dir" "', '.join(s['groups'][$group]['tasks'])")
  cat > "$run_dir/group-$group.prompt.txt" <<EOF
You are the headless session of autonomous run $(basename "$run_dir"), group $group.
Read $here/run-prompt.md and follow it exactly.
Run directory: $run_dir (also in \$AGENTS_AUTONOMOUS_RUN).
Group: $group. Repo: $repo.
Tasks in order: $tasks.
EOF
  log="$run_dir/group-$group.log"
  pid=$(python3 -c '
import subprocess, sys
log = open(sys.argv[1], "ab")
process = subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                           start_new_session=True)
print(process.pid)' "$log" /bin/bash "$here/launch.sh" --run-group "$run_dir" "$group") || return 1
  state group-started "$run_dir" "$group" "$pid" "$log"
  echo "group $group: $repo ($tasks), session pid $pid, log $log"
}

# Plans under the plans folder that verify and still have an unticked step; the rest are printed.
discover() {
  python3 - "$here/plan-approval.py" "$plans_dir" <<'EOF'
import re
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path
approval = SourceFileLoader('plan_approval', sys.argv[1]).load_module()
for plan in sorted(Path(sys.argv[2]).glob('*.md')):
    try:
        approval.verify(plan)
    except approval.PlanError as error:
        print(f'skipped {plan}: {error}', file=sys.stderr)
        continue
    steps = approval.split_plan(plan.read_text())[1].get('Steps', [])
    if any(re.match(r'\s*[-*+] \[ \]', line) for line in steps):
        print(plan)
    else:
        print(f'skipped {plan}: every step is ticked (done)', file=sys.stderr)
EOF
}

if [[ "${1:-}" == --run-group ]]; then
  [[ $# -eq 3 ]] || usage
  run_group "$2" "$3"
  exit $?
fi

channel=
thread=
resume=
plans=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slack-channel) [[ $# -ge 2 ]] || usage; channel=$2; shift 2 ;;
    --slack-thread) [[ $# -ge 2 ]] || usage; thread=$2; shift 2 ;;
    --resume) [[ $# -ge 2 ]] || usage; resume=$2; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "autonomous: unknown option $1" >&2; usage ;;
    *) plans+=("$1"); shift ;;
  esac
done
if [[ -n "$channel" && -z "$thread" || -z "$channel" && -n "$thread" ]]; then
  echo "autonomous: --slack-channel and --slack-thread go together" >&2
  exit 2
fi

if [[ -n "$resume" ]]; then
  [[ ${#plans[@]} -eq 0 && -z "$channel" ]] || usage
  run_dir="$root/$resume"
  [[ -f "$run_dir/state.json" ]] || { echo "autonomous: no run $resume under $root" >&2; exit 1; }
  engine=$(state_get "$run_dir" 's["engine"]')
  AUTONOMOUS_ENGINE=$engine pick_engine > /dev/null || exit 1
  groups=$(state resume "$run_dir") || exit 1
  if [[ -z "$groups" ]]; then
    echo "autonomous: run $resume has nothing to resume (every task ended, or its session still runs)"
    exit 0
  fi
  for group in $groups; do spawn "$run_dir" "$group" || exit 1; done
  echo "run $resume resumed"
  exit 0
fi

engine=$(pick_engine) || exit 1
if [[ ${#plans[@]} -eq 0 ]]; then
  while IFS= read -r plan; do plans+=("$plan"); done < <(discover)
  if [[ ${#plans[@]} -eq 0 ]]; then
    echo "autonomous: no approved, unfinished plan under $plans_dir" >&2
    exit 1
  fi
fi

run_id="$(date +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
run_dir="$root/$run_id"
mkdir -p "$root" || exit 1
slack_args=()
[[ -z "$channel" ]] || slack_args=(--slack-channel "$channel" --slack-thread "$thread")
summary=$(state init "$run_dir" --engine "$engine" ${slack_args[@]+"${slack_args[@]}"} "${plans[@]}") || exit 1
python3 -c 'import json,sys
for s in json.loads(sys.argv[1])["stopped"]:
    print("stopped %s (%s): %s" % (s["task"], s["plan"], s["reason"]))' "$summary"
groups=$(python3 -c 'import json,sys; print(" ".join(str(g["group"]) for g in json.loads(sys.argv[1])["groups"]))' "$summary")
if [[ -z "$groups" ]]; then
  echo "run $run_id: no plan verified, nothing started ($run_dir)"
  exit 1
fi
for group in $groups; do spawn "$run_dir" "$group" || exit 1; done
echo "run $run_id started ($run_dir)"
