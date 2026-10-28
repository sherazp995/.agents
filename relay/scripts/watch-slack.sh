#!/usr/bin/env bash
# Bridges an inbound Slack message into the Claude Code session that is
# supervising Relay.
#
# Why this exists: nothing pushes Slack into a Claude Code session. But a
# background task COMPLETING does notify it. So this blocks until a new run
# appears, prints what was said, and exits, which surfaces the message to the
# supervising session as a completion notification.
#
# This is operator visibility, not a Relay feature. Relay's own loop answers
# without it and does not depend on it.
#
# Usage: scripts/watch-slack.sh [timeout_seconds]
set -uo pipefail

DB_URL="${RELAY_DB_URL:-postgres://relay:relay@localhost:5432/relay}"
CHANNEL="${RELAY_WATCH_CHANNEL:-D0BPT8XL44Q}"
TIMEOUT="${1:-1500}"

latest_run() {
  psql "$DB_URL" -tAc "SELECT id FROM runs ORDER BY created_at DESC LIMIT 1" 2>/dev/null | tr -d '[:space:]'
}

baseline="$(latest_run)"
echo "watching for a new Slack message. baseline run: ${baseline:-none}. timeout: ${TIMEOUT}s"

deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  current="$(latest_run)"
  if [ -n "$current" ] && [ "$current" != "$baseline" ]; then
    echo "=== NEW SLACK ACTIVITY ==="
    psql "$DB_URL" -c \
      "SELECT state, round(cost_usd::numeric,4) AS cost, created_at FROM runs WHERE id = '$current'" 2>/dev/null

    # The orchestrator log deliberately omits inbound message text, because an
    # earlier gate finding removed it so a pasted credential could not land in
    # a log file. So the text comes from Slack itself.
    tok="$(security find-generic-password -s relay-slack-bot-token -w 2>/dev/null)"
    if [ -n "$tok" ]; then
      curl -sS "https://slack.com/api/conversations.history?channel=${CHANNEL}&limit=6" \
        -H "Authorization: Bearer $tok" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('could not parse the Slack response'); raise SystemExit
if not d.get('ok'):
    print('slack error:', d.get('error')); raise SystemExit
for m in reversed(d.get('messages', [])):
    who = 'RELAY' if m.get('bot_id') else 'OPERATOR'
    txt = (m.get('text') or '').replace(chr(10), ' ')[:400]
    print(f'[{who}] {txt}')
"
    fi
    unset tok
    exit 0
  fi
  sleep 5
done

echo "no new Slack activity within ${TIMEOUT}s. baseline run unchanged: ${baseline:-none}"
exit 0
