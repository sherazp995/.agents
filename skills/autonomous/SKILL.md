---
name: autonomous
description: "Build plans the user already approved, unattended (for example overnight), from the terminal or a Slack thread through relay: each plan in its own worktree, built and checked per doing-substantial-work, reviewed with general-review, QA'd with branch-visual-qa and video-qa, end-checked and committed locally, then one report where the run was started. Fixes only findings the build introduced inside the plan's scope and records the rest. Use only when the user says \"autonomous\", runs /autonomous <plan paths>, or asks to build the approved plans unattended. Never plans, pushes, opens PRs or writes to GitHub; not for unapproved plans or planning."
---

# Autonomous

Builds approved plans with nobody watching and reports in the morning. A plan counts as approved only when it carries the stamp doing-substantial-work writes at its approval gate and that stamp still matches (`plan-approval.py verify`). The run happens in detached headless sessions, so it does not depend on the chat that started it (relay ends a Slack turn after an hour).

## Start it (the starting chat does only this)

1. Run the launcher and return. No interview, no plan, no waiting.
   - Terminal: `~/.agents/skills/autonomous/launch.sh <plan paths...>`.
   - Slack thread (a relay task): the same, plus `--slack-channel <channel> --slack-thread <thread ts>` of that thread, as relay gives them for `relay live say`. The final report then goes to that thread.
   - "autonomous" or `/autonomous` with no paths: `launch.sh` with no paths takes every plan under `~/.agents/tmp/plans` that verifies and still has an unticked step, and prints each plan it skipped with the reason.
2. Reply with the run id it printed, plus each plan it printed as stopped or skipped and why, in one short message. In Slack, answer in the thread as relay says.

Resume after a crash or a reboot: `launch.sh --resume <run id>`. It restarts only the groups with unfinished tasks and no live session; finished stages are skipped.

Status at any time: `python3 ~/.agents/skills/autonomous/run-state.py show ~/.agents/tmp/autonomous/<run id>`, or that folder's `report.md` once the run ends.

## What a run does

The launcher verifies every plan (one that fails is recorded as stopped with the reason, and the others still run), groups the plans by their `Repo:` line, and starts one headless session per repo, all at once. Plans in one repo run in order inside their session, so two sessions never share a checkout. Each session follows [run-prompt.md](run-prompt.md):

- Per task, in order: approval, worktree (next to the repo, per `git-worktrees`), build (doing-substantial-work steps 3 to 5, where step 5's "ask the user" becomes a stop with the reason), review (`general-review` on the task diff), qa-visual (`branch-visual-qa`, reusing that review), qa-video (`video-qa`), done-check, and one local commit in the worktree.
- One disposition policy for every repair stage: fix introduced blockers, highs and mediums inside the plan's scope within rule 44's three rounds; stop the task when one needs out-of-scope work; record lows and every pre-existing or out-of-scope finding.
- QA is skipped only when the plan changes nothing a user sees. QA that cannot run is "QA unavailable", and that task is not done.
- Stage results are tied to the tree they ran on (`run-state.py`), so a repair after review or QA reruns the checks and rechecks after it.
- A stuck task stops with its reason; the next task goes on.
- Never: interview-me, planning, push, gh writes, PRs.

The report: per task its status, commit, checks with exit codes, review result, QA report and video paths, recorded findings and the "Learned" list. From Slack it is one `relay live say` in the starting thread with the files attached; from the terminal, `report.md` plus one `relay notify`.

## Approval stamp

doing-substantial-work step 2 runs, at the approval gate and inside the repo the plan builds:

```bash
python3 ~/.agents/skills/autonomous/plan-approval.py sign <plan> --words "<the user's approving words>"
```

It writes `Approved: <date> <words>`, `Repo: <git toplevel>` and `Approved-sha256: <hash>` above the plan's first `##` section. The hash covers `## Confirmed intent`, `## Steps` and `## Checks`, with checkbox marks normalized: ticking steps keeps it valid, editing a step or check voids it, and a voided plan needs the user's yes and a new `sign`. `plan-approval.py verify <plan>` exits 0 when it still matches, else 1 with the reason.

## Guard

The headless session runs with `--permission-mode bypassPermissions` (Claude) or `--dangerously-bypass-approvals-and-sandbox` (Codex, used only when claude is not installed), so it never stalls on a prompt. `hooks/bin/no-remote-writes` is its guard: a PreToolUse hook, run with `--fail-closed`, active only when `AGENTS_AUTONOMOUS_RUN` is set. It blocks git push, gh writes, write requests to remote hosts, publishing, ssh and remote copies, posting MCP tools and Artifact publishing, and allows read-only gh, local git, `relay notify` and `relay live say` to the run's own thread. Scripts that make their own HTTP calls are not caught; the run prompt forbids them.

## Files

`~/.agents/tmp/autonomous/<run id>/`: `state.json` (tasks, stages, tree hashes, stop reasons, groups, the Slack thread), `plans/` (each plan as launched), `tasks/<task>.md` (each task's report), `report.md`, and per group `group-<n>.prompt.txt`, `.log`, `.out`, `.err` (the session's output) and, for Claude, `claude-settings.json` with the hook.
