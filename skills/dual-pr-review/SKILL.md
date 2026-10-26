---
name: dual-pr-review
description: Review the current branch with two fresh, context-free sessions at once, one Claude and one Codex, each sent only the plain review request (for cohabit-web, "cohabit pr review of current branch with staging"), then report both verdicts side by side. Use when the user asks for a "dual review", "both reviewers", "fresh Claude and Codex review", "review it without context", or invokes /dual-pr-review [base]. Report only; it never edits, commits or pushes.
---

# Dual PR review

Two independent reviewers who know nothing about the conversation that built the change. Each runs in its own new session, started in the background from this one, and uses its own review skill exactly as if the user had typed the request into a new terminal.

## 1. Pin the target

- Checkout: the repository root of the current branch (`git rev-parse --show-toplevel`). Inside a worktree, use the worktree.
- Base: the explicit argument first, then the target PR base or current project instructions and memory, then `develop`. Resolve it once and send the same base to both reviewers; do not let an old example override current project guidance.
- Record the branch and `HEAD`. If the tree has uncommitted changes, say so: both reviewers will see them.
- cohabit-web only: set BRANCH_KEY to `branch-<branch name with / replaced by __>`. Find this branch's KEY, the PR number from `gh pr list --repo cohabitplatforms/cohabit-web --head <branch> --state all --limit 1 --json number -q '.[0].number'`, else BRANCH_KEY. Check both `~/.claude/pr-review-ledger/cohabit-web/agents/{claude,codex}/<KEY>.lock/` and `~/.claude/pr-review-ledger/cohabit-web/agents/{claude,codex}/<BRANCH_KEY>.lock/` (once when the keys match). If any checked lock directory exists, stop and tell the user its path and the run ID from its `run_id` file; if that file is not yet available, say so and still stop. Never remove an existing lock. Locks of unrelated targets, cleanup locks, and the old per-runner `agents/{claude,codex}.lock/` do not block this target. general-review holds its ledger lock only while it writes, so other repos have no running-review marker to check.
- Do not change the checkout while the reviews run: no edits, commits, rebases or pushes until both have finished.

## 2. Pick the prompt

Send both sessions the same short request and nothing else. No intent, no plan, no earlier findings:

- cohabit-web (`origin` contains `cohabitplatforms/cohabit-web`): `cohabit pr review of current branch with <base>`
- any other repository: `general review of current branch against <base>`

## 3. Launch

Make a unique run folder outside the repository, `${TMPDIR:-/tmp}/dual-pr-review/<YYYYMMDD-HHMMSS>`. Run the launcher using the host-specific lifecycle below:

```bash
bash ~/.agents/skills/dual-pr-review/scripts/launch.sh <checkout> <run folder> "<prompt>"
```

It starts `claude -p` (auto permission mode) and `codex exec` (gpt-6-astra, `--approve-for-me`, network on, stdin closed) in the checkout at the same time and waits for both. It stops both and exits 124 after `DUAL_PR_REVIEW_TIMEOUT` seconds (default 7200), and marks a reviewer incomplete when its report has no whole-line verdict. Wait rules for every host: [host-lifecycle.md](../workflow-runner/references/host-lifecycle.md).

- **Claude Code:** use Bash with `run_in_background: true`. Tell the user the run folder and yield for its task notification; collect the results when it arrives. Do not poll.
- **Codex:** run the launcher as the foreground command of `exec_command`, with a short `yield_time_ms`. Do not detach it with `nohup`, `disown`, or a trailing shell `&`. The launcher already runs its two children concurrently. Retain the returned `session_id` and collect it with `write_stdin`, using waits of at most 60 seconds and concise progress updates. If the outer `functions.exec` yields a cell ID, first finish that call with `functions.wait`; a cell ID is not a process session ID. Use the host's required escalation when CLI credentials or the target worktree are outside the sandbox. Keep the turn active through collection and the final report; a terminal session alone does not promise a notification or a future assistant turn.
- **Other hosts:** use their managed task mechanism only when it provides completion delivery. Otherwise stay attached and collect the process result before returning.

A launcher PID or empty report file proves only an attempted launch. Report running status from a live tracked session; report completion only from each reviewer's exit status and nonempty final report with a verdict. The launcher's exit code is not a substitute for both `*.exit` files. On interruption or resumed work, inspect the existing run and its children before restarting. A missing session without terminal artifacts, a missing exit status, or a missing verdict is incomplete, never PASS. Do not launch duplicate reviews or remove another run's locks.

If the user also requests a separate review, track it separately and collect it too. Do not replace either requested review with the other. A status question is an update, not cancellation of the remaining work.

## 4. Collect

When the launcher exits, read from the run folder: `claude.md` and `codex.md` (each session's final message), `*.exit`, and the tails of `claude.err` and `codex.log` if an exit code is not 0. Each review also writes its ledger record (cohabit: `~/.claude/pr-review-ledger/cohabit-web/agents/{claude,codex}/<PR number or branch>.md`) and may name a fuller report; read those for the findings.

The launcher sets `AGENT_REVIEW_HEADLESS=1` for both sessions and writes `<reviewer>.incomplete` when a report has no verdict line (a session that ended while its agents still ran). A session that exited non-zero, or ended without a verdict, is reported as "did not finish" with the reason from its log. Never fill its side in yourself.

## 5. Report

Answer first: both verdicts, then one merged list.

- One line per verdict: reviewer, head SHA reviewed, verdict.
- Findings merged by root cause, each tagged with who raised it (`[claude]`, `[codex]`, `[both]`), severity and `file:line`.
- Before listing a finding, read the cited lines yourself. Mark any the code does not support as "not confirmed" instead of dropping it silently.
- Say where the two reviewers disagree.
- Do not fix anything. Offer fixes as a question; the user decides (see the user's "review stays in scope" rule).

End with the run folder path and both ledger paths.
