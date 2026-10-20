---
name: doing-substantial-work
description: The default way to build any feature or fix that changes more than one file, adds behaviour, refactors, or chases a bug that survived a fix. One lead agent (with 2-6 parallel parts when the files split cleanly), a short plan, checks that pass or fail, one review, one commit. Councils, best of two and the multi-agent build workflow run only when the user asks for them by name. Not for one-line fixes, questions, or read-only exploration.
---

# Doing substantial work

One lead agent owns the work, in this session, and checks it with commands rather than more agents. When the build splits into parts with no shared files, the lead may run them as parallel subagents in the same working tree (step 3). Speed and accuracy come from small steps that are each proven by a command.

## The steps

1. **Context.** Read the project `CLAUDE.md`/`AGENTS.md` and the rule files it names. Search past chats only when the task looks like something tried before (`agents-hub search <topic>`).
2. **Plan, then wait.** A short plan, shown to the user:
   - intent in one line;
   - the files to change;
   - the check commands that prove it (the narrowest specs, rubocop or eslint on the changed files, a migration up and down);
   - parallel parts, only when the build splits into 2-6 parts that share no file: each part and the files it owns, plus the shared work the lead does itself;
   - risk: if it touches a schema, auth, permissions or payments, say so in one line and offer `work-council`. Do not start it unless the user says yes.

   After approval, build without check-ins unless something changes the plan.

   **Plan file.** When the build has more than three steps, save the plan after approval to `~/.agents/tmp/plans/<checkout folder>-<branch with / as ->-<task in 2-4 words>.md` (git-ignored, never committed; never reuse another task's file) and show its full path in the plan the user approves, so the path survives a chat summary. It holds the request verbatim, the approved plan as a checklist, the check commands, and a short log. Keep it current: tick a step when its check passes, log each decision the user makes and each failed try with the reason it failed. After the chat is summarized, re-read the file at that path before the next step; it, not the summary, is the plan.
3. **Build.** Edit the files yourself. Use one subagent only when the reads would flood the chat (a wide search goes to `Explore`), or for the approved parallel parts below. Load the stack skill that matches the code (`rails-engineering`, `frontend-engineering`, `backend-engineering`, `rust-engineering`, `devops-sre`). Tests follow `writing-specs`.

   **Parallel parts.** Only when the approved plan splits the build into 2-6 parts and no file belongs to two parts. Anything less clear-cut is built by the lead alone.
   - Shared files are never split: `db/schema.rb`, migrations, `config/routes.rb`, locale files, `Gemfile`/`Gemfile.lock`, `package.json`/`yarn.lock`, shared base classes. The lead does that shared work first (or last, if it depends on the parts).
   - Start the parts at the same time as subagents in this working tree (Claude Code: the Agent tool, general-purpose; Codex: subagents, or one part after another when it has none). Each gets its slice of the plan, the files it owns, the relevant rule files, the stack skill to load (`rails-engineering`, `frontend-engineering`, ...), and these rules: edit only your own files; never run git commands; run only your part's narrowest specs or a syntax check, never the full suite; if blocked, report back instead of starting more agents; return the files changed, commands with exit codes, and anything unverified.
   - The test database is shared in one working tree: if part specs collide, the lead runs them after the parts finish.
   - The lead reviews each part's diff (`git diff -- <its files>`) and sends fixes back to the subagent that wrote it (Claude Code: SendMessage). The two-failed-tries rule applies to each part. Then step 4 runs every check on the whole change, and steps 7-8 review and commit once, as usual.
   - Plan file: record the parts, their owners and their status.
4. **Check.** Run every check command from the plan. A step is done when its command passes, not when the code looks right.
5. **When stuck.** Reproduce the failure and read the full error. Test one idea at a time. **Two failed tries on the same problem: stop, tell the user what you tried and what you saw, and ask.** Never loop, never start more agents to get unstuck.
6. **Prove it** when the change is visible: run the page, job or command once on the main path and keep the output. If you cannot drive it, say it is unverified.
7. **Review once.** Read your own full diff against the plan: scope, dead code, missed callers, tests. Run `general-review` only when the user asks for a review or before a PR is opened.
8. **Commit and report.** Stage only this work's files (`git add -- <files>`), one line commit (rule 48), amend when git-guard says so. Never push unless told. Report answer first: what changed, which commands passed, anything unverified or skipped.

## Heavier tools, by name only

Run these only when the user names them (or names the outcome, like "best of two" or "council"):

- `work-council`: plan critique and a Claude vs Codex build.
- `llm-council`: several independent opinions on a hard question.
- [build-workflow.js](build-workflow.js): multi-card build in waves with independent rechecks, for large plans the user wants run as a workflow.
- `dual-pr-review`, `cohabit_pr_review`, `branch-visual-qa`, `video-qa`.
