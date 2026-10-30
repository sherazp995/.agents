---
name: doing-substantial-work
description: The default way to build any feature or fix that changes more than one file, adds behaviour, refactors, or chases a bug that survived a fix. One lead agent (2-6 parallel parts by default when the files split cleanly), a plan by one author that the user approves (rethink, with the other model's opinions, only for the risk list or on request), general-review rules applied while building, checks that pass or fail, one end check, one commit. Councils (llm-council, the work-council team build), autonomous runs and the multi-agent build workflow run only when the user asks for them by name. Not for one-line fixes, questions, or read-only exploration.
---

# Doing substantial work

One lead agent owns the work, in this session, and checks it with commands rather than more agents. When the build splits into parts with no shared files, the lead may run them as parallel subagents in the same working tree (step 3). Speed and accuracy come from small steps that are each proven by a command.

## The steps

1. **Context.** Read the project `CLAUDE.md`/`AGENTS.md`, the rule files it names, and `CONSTRAINTS.md` when the repo has one (`constraint-driven`). Search past chats only when the task looks like something tried before (`agents-hub search <topic>`). For a bug, load `debugging` and reproduce it before planning the fix.
2. **Interview, then plan, then wait.** Run `interview-me` first (its short form by default: the six-line restate and an explicit yes; skip it in one line when the request already states all six). Then write the plan yourself, or with `rethink` when it hits the risk list or the user asks (see below), in the `writing-plans` format, to its plan file (below) before you show it: the `plan-guard` hook delivers `writing-plans` there and sends back missing or out-of-order sections. Show the user its In short, its decisions and the file's path, as that skill says. It covers:
   - the confirmed intent (the `interview-me` restate, or one line when it was skipped);
   - the files to change;
   - the check commands that prove it (the narrowest specs, rubocop or eslint on the changed files, a migration up and down);
   - parallel parts: look for them in every plan. Parts that share no file and need nothing from each other's output are listed with the files each owns, plus the shared work the lead does itself; 2-6 of them are built in parallel (step 3);
   - risk: if it hits `rethink`'s "Risk list", say so in one line, plan it with `rethink`, and offer `work-council`. Do not start `work-council` unless the user says yes.

   After approval, build without check-ins unless something changes the plan.

   **When to use `rethink`.** A routine plan is written by you (one author) and approved by the user. Use `rethink` only when the plan hits its "Risk list", or when the user asks for it ("rethink", "think it through", Claude and Codex plans). Run it as that skill says (you write the plan, the other model gives its opinion on the direction and on the draft). The plan file carries its `## Advisor opinions`, the status, the `## Review pre-check` section, and the decisions the user settled. If the status is not `agreed`, show it and the open points plainly with both sides; the user decides each, and never call that plan agreed by both models. If the user's decisions change the steps, the changed steps may get one more draft opinion as `rethink` says.

   **Plan file.** Every build has one. Write the plan to it before asking for approval, at `~/.agents/tmp/plans/<checkout folder>-<branch with / as ->-<task in 2-4 words>.md` (git-ignored, never committed; never reuse another task's file) and show its full path in the plan the user approves, so the path survives a chat summary. Laid out as `writing-plans` says, it holds the request verbatim (in its appendix), the sections `## Confirmed intent`, `## Steps` (the approved plan as a checklist) and `## Checks` (the check commands), and a `## Log`. At the approval gate run `python3 ~/.agents/skills/autonomous/plan-approval.py sign <plan file> --words "<the user's approving words>"`: it stamps the plan with the approval, its repo and a hash of those three sections, which `autonomous` checks before it builds the plan unattended (ticking steps keeps the stamp valid; editing a step or check voids it, so a changed plan needs the user's yes and a new `sign`). Keep it current: tick a step when its check passes, log each decision the user makes and each failed try with the reason it failed. After the chat is summarized, re-read the file at that path before the next step; it, not the summary, is the plan.
3. **Build.** Before writing code, load general-review's rules alongside the stack skill: `~/.agents/skills/general-review/references/review-checklist.md`, `references/structural-standards.md`, and SKILL.md sections "2. Understand the approach" and "Root causes and sibling sweep". Build to the plan's `## Review pre-check`.

   **Step baseline.** Before a step edits anything, copy the files it will touch (those that exist) to `<scratch>/step-<N>-before/`, keeping their paths. The step diff is then `git diff --no-index <scratch>/step-<N>-before/<path> <path>` per touched file, with `/dev/null` on the missing side for a new or deleted file. It covers staged, unstaged and untracked work and leaves out earlier steps' edits. Save it to `<scratch>/step-<N>.diff`.

   **Step check (after each plan step, before the next):** for a routine plan, run the step's check command and log its result; that is the whole step check. For a plan made with `rethink`, also run every item below.
   - Re-run the step's sibling sweep searches (`rg`, or Grep with the same pattern); every instance is covered or recorded as out of scope with a reason.
   - Every contract the step changes is updated on both sides (callers, declarations, docs that state it).
   - The step's regression tests exist and pass (the failing case plus its neighbours). A step with no behaviour to test (docs, pure rename) records `N/A: <reason>` and its syntax or doc check instead.
   - Read the step diff against structural standards 3 (no file pushed over 1000 lines without a very strong, stated reason) and 9 (no new code debt as the project's own debt record defines it), and the simplicity lens (nothing left dead, nothing live deleted). Apply the standards with their own qualifications; do not widen them.
   - For a step that changes more than one non-test file or a public contract, also run the diff-only lens on the step diff. Claude Code: one fresh agent (Agent tool, `general-purpose`, model sonnet, effort low, never a fork) with `~/.agents/skills/general-review/references/lenses/diff-only.md`, `{DIFF}` = `<scratch>/step-<N>.diff`, `{OUT}` = `n/a`. Codex: a fresh sub-agent with an empty context on its default model. If no agent can be started, record `diff-only lens: not run (<reason>)`; the final review covers it.
   - Classify each verified item (from your own checks or the lens) by severity and origin, as general-review section 4 does. Fix introduced blockers, highs and mediums now. Record introduced lows and pre-existing items in the plan file's findings ledger; they are not fixed in this build unless the user says so. The ledger goes to the final review as its earlier findings.
   - Log in the plan file: the step, the check results, and what was fixed or recorded.
   - Parallel parts: each part takes its own step baselines and runs every check except the lens; the lead runs the lens on each part's step diffs.

   Edit the files yourself. Use one subagent only when the reads would flood the chat (a wide search goes to `Explore`), or for the approved parallel parts below. Load the stack skill that matches the code (`rails-engineering`, `frontend-engineering`, `backend-engineering`, `rust-engineering`, `devops-sre`). Tests follow `writing-specs`.

   **Parallel parts.** The default whenever the approved plan splits the build into 2-6 parts and no file belongs to two parts, so the work finishes faster. Anything less clear-cut is built by the lead alone.
   - Shared files are never split: `db/schema.rb`, migrations, `config/routes.rb`, locale files, `Gemfile`/`Gemfile.lock`, `package.json`/`yarn.lock`, shared base classes. The lead does that shared work first (or last, if it depends on the parts).
   - Start the parts at the same time as subagents in this working tree, and wait for every part to return before step 4 ([host-lifecycle.md](../workflow-runner/references/host-lifecycle.md)) (Claude Code: the Agent tool, general-purpose; Codex: subagents, or one part after another when it has none). Each gets its slice of the plan and of its `## Review pre-check`, the files it owns, the relevant rule files, general-review's rule files listed above, the step check (without the diff-only lens), the stack skill to load (`rails-engineering`, `frontend-engineering`, ...), and these rules: edit only your own files; never run git commands that change anything (read-only `git log`, `show`, `diff`, `blame` are fine); run only your part's narrowest specs or a syntax check, never the full suite; if blocked, report back instead of starting more agents; return the files changed, commands with exit codes, and anything unverified.
   - The test database is shared in one working tree: if part specs collide, the lead runs them after the parts finish.
   - The lead reviews each part's diff (`git diff -- <its files>`) and sends fixes back to the subagent that wrote it (Claude Code: SendMessage). The two-failed-tries rule applies to each part. Then step 4 runs every check on the whole change, and steps 7-8 review and commit once, as usual.
   - Plan file: record the parts, their owners and their status.
4. **Check.** Run every check command from the plan. A step is done when its command passes, not when the code looks right.
5. **When stuck.** Reproduce the failure and read the full error. Test one idea at a time. **Two failed tries on the same problem: stop, tell the user what you tried and what you saw, and ask.** Never loop, never start more agents to get unstuck.
6. **Prove it** when the change is visible: run the page, job or command once on the main path and keep the output. If you cannot drive it, say it is unverified.
7. **End check.** `done-check` is the one end check: when the turn commits or says it is done, the hook has a fresh checker confirm completion and correctness. Where the hook is not installed, run its checker prompt (`~/.agents/hooks/bin/done-check`, `check_instructions`) once by hand. Run `general-review` only when the user asks for a review or before a PR is opened, with rule 44's round limit.
8. **Commit and report.** Stage only this work's files (`git add -- <files>`), one line commit (rule 48), amend when git-guard says so. Never push unless told. Report answer first: what changed, which commands passed, anything unverified or skipped.

## Heavier tools, by name only

Run these only when the user names them (or names the outcome, like "Claude and Codex together" or "council"):

- `work-council`: Claude and Codex as one team: one plan shaped by both, a split build, cross-review, joint sign-off.
- `llm-council`: several independent opinions on a hard question.
- `autonomous`: builds plans the user already approved, unattended, from the terminal or a Slack thread, then reviews, QAs and commits each one locally.
- [build-workflow.js](build-workflow.js) (stale: it predates `rethink` and the current steps, and is not maintained): multi-card build in waves with independent rechecks, for large plans the user wants run as a workflow.
- `dual-pr-review`, `cohabit_pr_review`, `branch-visual-qa`, `video-qa`.
