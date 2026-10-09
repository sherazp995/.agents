---
name: pr-details
description: Write a pull request title and description in Markdown, ready to paste. Use when the user asks for PR text, a PR description, "write the PR", "give me a title and description", or invokes /pr-details. Fills the repo's own PR template when one exists, and reports only what was actually run.
---

# PR details

Produce a **title** and a **description**, both in fenced Markdown so they can be
copied straight out. Nothing else. Do not open the PR unless asked.

## 1. Find the template first

```bash
find .github -iname "*pull_request*" 2>/dev/null; ls docs/PULL_REQUEST* 2>/dev/null
```

If one exists, **reproduce it exactly**: every heading, every checkbox, in order.
Tick what applies, leave the rest unticked. Never delete an unticked box and never
invent a section the template does not have. A reviewer reads the unticked boxes.

With no template, use: `## What and why`, `## Testing`, `## Additional notes`.

## 2. Read the diff before writing

```bash
git diff --stat $(git merge-base HEAD origin/<base>)...HEAD
git log --oneline $(git merge-base HEAD origin/<base>)..HEAD
```

Confirm the base branch. A stale local ref silently widens the diff and puts
someone else's merged work in your description.

## 3. Match the house style

Model the output on the user's recent PRs, e.g. cohabit-web #3729 and #3728
(`gh pr list --author @me --state all --limit 10`, then `gh pr view <n> --json body`).

**Title:** `[TICKET] <who> <does what>`, a plain sentence about the user-facing
outcome. For example: `[CI-302] Broker records the premium split and attaches CoC, PDS and FSG on CoC Sent`.

**Description section** (the template's first heading):
- The ticket link on its own line first.
- Then 10 to 15 bullets, 10 words or fewer each.
- Start with the problem in one or two bullets, then what changed.
- Say what the user sees and what the system does, not how the code does it.
- Name a column or table only when a reviewer must know it (e.g. a migration).

**Testing:** short, four or five bullets at most, grouped. No per-file lists, no
step-by-step browser narration, no record IDs or sample values.
- `bundle exec rspec` on the N related spec files: X examples, 0 failures.
- Mutation tested: removed each new guard once and saw its spec fail.
- Guards covered: a, b, c (comma list).
- Migration rolled back and re-applied cleanly (only when there is one).
- Browser checks covered: a, b, c (comma list).

If the user says to skip Testing, keep the heading and leave it empty.

**Additional Notes:** empty unless a reviewer must know something. When needed,
a short list such as "Existing issues found but not changed here:". Accepted
trade-offs go here in one line each.

**Always:**
- One sentence per line. Never wrap a sentence across two lines.
- No dash joining clauses. Use a comma, full stop, or brackets.
- No mention of Claude, AI, or an assistant, anywhere.

## 4. Verification is what you ran

Every count in Testing comes from a command run in this session. Never "it works"
or "tested locally". If something the PR needs was not run (a deploy, a backfill),
say so in Additional Notes in one line.

## Never

- Invent a number. Every figure comes from a command you ran in this session.
- Describe behaviour you did not verify.
- Pad the description to look thorough.
