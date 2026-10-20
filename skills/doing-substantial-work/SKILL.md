---
name: doing-substantial-work
description: The default way to build any feature or fix that changes more than one file, adds behaviour, refactors, or chases a bug that survived a fix. One agent, a short plan, checks that pass or fail, one review, one commit. Councils, best of two and the multi-agent build workflow run only when the user asks for them by name. Not for one-line fixes, questions, or read-only exploration.
---

# Doing substantial work

One agent does the work, in this session, and checks it with commands rather than more agents. Speed and accuracy come from small steps that are each proven by a command.

## The steps

1. **Context.** Read the project `CLAUDE.md`/`AGENTS.md` and the rule files it names. Search past chats only when the task looks like something tried before (`agents-hub search <topic>`).
2. **Plan, then wait.** A short plan, shown to the user:
   - intent in one line;
   - the files to change;
   - the check commands that prove it (the narrowest specs, rubocop or eslint on the changed files, a migration up and down);
   - risk: if it touches a schema, auth, permissions or payments, say so in one line and offer `work-council`. Do not start it unless the user says yes.

   After approval, build without check-ins unless something changes the plan.
3. **Build.** Edit the files yourself. Use one subagent only when the reads would flood the chat (a wide search goes to `Explore`). Tests follow `writing-specs`.
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
