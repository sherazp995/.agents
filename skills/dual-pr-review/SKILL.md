---
name: dual-pr-review
description: Review the current branch with two fresh, context-free sessions at once, one Claude and one Codex, each sent only the plain review request (for cohabit-web, "cohabit pr review of current branch with develop"), then report both verdicts side by side. Use when the user asks for a "dual review", "both reviewers", "fresh Claude and Codex review", "review it without context", or invokes /dual-pr-review [base]. Report only; it never edits, commits or pushes.
---

# Dual PR review

Two independent reviewers who know nothing about the conversation that built the change. Each runs in its own new session, started in the background from this one, and uses its own review skill exactly as if the user had typed the request into a new terminal.

## 1. Pin the target

- Checkout: the repository root of the current branch (`git rev-parse --show-toplevel`). Inside a worktree, use the worktree.
- Base: the argument, else `develop`.
- Record the branch and `HEAD`. If the tree has uncommitted changes, say so: both reviewers will see them.
- If a review of this branch is already running (a lock in `~/.claude/pr-review-ledger/<repo>/agents/{claude,codex}.lock/run_id`), stop and tell the user instead of starting a second one.
- Do not change the checkout while the reviews run: no edits, commits, rebases or pushes until both have finished.

## 2. Pick the prompt

Send both sessions the same short request and nothing else. No intent, no plan, no earlier findings:

- cohabit-web (`origin` contains `cohabitplatforms/cohabit-web`): `cohabit pr review of current branch with <base>`
- any other repository: `general review of current branch against <base>`

## 3. Launch

Make a run folder outside the repository, `${TMPDIR:-/tmp}/dual-pr-review/<YYYYMMDD-HHMMSS>`, then run in the background (Claude Code: Bash with `run_in_background: true`; it notifies on exit):

```bash
bash ~/.agents/skills/dual-pr-review/scripts/launch.sh <checkout> <run folder> "<prompt>"
```

It starts `claude -p` (auto permission mode) and `codex exec` (gpt-6-astra, `--approve-for-me`, network on, stdin closed) in the checkout at the same time and waits for both. Tell the user both have started, with the run folder, and end the turn; do not poll.

## 4. Collect

When the launcher exits, read from the run folder: `claude.md` and `codex.md` (each session's final message), `*.exit`, and the tails of `claude.err` and `codex.log` if an exit code is not 0. Each review also writes its ledger record (cohabit: `~/.claude/pr-review-ledger/cohabit-web/agents/{claude,codex}/<PR number or branch>.md`) and may name a fuller report; read those for the findings.

A session that exited non-zero, or ended without a verdict, is reported as "did not finish" with the reason from its log. Never fill its side in yourself.

## 5. Report

Answer first: both verdicts, then one merged list.

- One line per verdict: reviewer, head SHA reviewed, verdict.
- Findings merged by root cause, each tagged with who raised it (`[claude]`, `[codex]`, `[both]`), severity and `file:line`.
- Before listing a finding, read the cited lines yourself. Mark any the code does not support as "not confirmed" instead of dropping it silently.
- Say where the two reviewers disagree.
- Do not fix anything. Offer fixes as a question; the user decides (see the user's "review stays in scope" rule).

End with the run folder path and both ledger paths.
