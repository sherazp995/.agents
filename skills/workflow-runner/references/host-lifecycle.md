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
| Claude Code agent started with `name` (a teammate) | | Its own background Bash exiting does not wake it; it waits for a message. A rethink lead started this way idled about 100 minutes (2026-10-26). |
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

Each call has a hard limit (for example `run-planner.sh`), but nothing inside a lead enforces the limit on the whole run. The caller does: when it starts a rethink lead it also starts [`~/.agents/skills/rethink/watch-run.sh`](../../rethink/watch-run.sh) in the background on the run folder. The watchdog exits when the done file appears, when no file in the folder changes for the stall time, or at the deadline, and prints which. On a stall, the caller sends the lead one message. At the deadline, the caller reads the run folder and reports the status the last reviewed version earned, or "incomplete" with the reason.
