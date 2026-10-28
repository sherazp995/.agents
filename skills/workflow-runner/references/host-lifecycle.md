# Waiting on agents and background work

The one home for how a session or lead waits on work it started. Skills that wait link here instead of restating it: rethink, general-review, cohabit_pr_review, dual-pr-review, doing-substantial-work, llm-council and work-council.

## The rule

A turn never ends while an agent or command it started still runs, unless the host is known to resume it when that work finishes (below). Otherwise wait for each one, or stop it and report it unfinished. A final message is a result, never "still running".

Every wait names three things: its condition (a file is non-empty, a `.meta` or exit file exists, an agent returned), its deadline (from the calling skill), and its expiry action (stop the owned work, report it incomplete with the reason, keep any lock whose holder's exit is not confirmed).

## What each host resumes

| Host | Resumed when its work finishes | Not resumed |
| --- | --- | --- |
| Claude Code session | Yes: background Bash (`run_in_background`) and background agents notify it. | |
| Claude Code subagent started without `name` | Yes: it may end its turn on its own background Bash or agent and is resumed when that exits (tested 2026-10-26, 90 s job). | |
| Claude Code agent started with `name` (a teammate) | | Its own background Bash exiting does not wake it; it waits for a message. A lead started this way idled about 100 minutes (2026-10-26). |
| Headless `claude -p`, `codex exec`, or `AGENT_REVIEW_HEADLESS=1` | Not to be relied on. One probe saw `claude -p` wait for a background subagent; that is one run on one version. | Treat as never resumed. |
| Codex | Only while attached: `wait_agent` for sub-agents, `write_stdin` waits of at most 60 s for exec sessions ([workflow-runner SKILL.md](../SKILL.md); agent ownership in [coordinator-reviews.md](coordinator-reviews.md)). | A detached process. |

So: start every lead and reviewer without `name`. In a headless run, or as a named agent, wait inside the turn.

## Waiting inside the turn

Claude Code caps one foreground Bash call at 10 minutes and blocks a foreground `sleep`. Use this form, and run it again until the condition holds or the deadline passes:

```bash
timeout 590 bash -c 'until <condition>; do perl -e "select(undef,undef,undef,10)"; done'
```

For example, `<condition>` = `[ -f "$OUT/a.meta" ] && [ -f "$OUT/b.meta" ]`. The Monitor tool with an until-loop on the same condition also works while the agent stays active.

## The caller's watchdog

Calls are judged by activity, not by a clock: `run-planner.sh` stops a call only when its output stops growing for the idle limit, or at a runaway ceiling, so a working call is never cut off mid-turn. The session that calls the rethink advisor waits on that one call itself, in the background with the in-turn wait above.
