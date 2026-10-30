# Autonomous run: the headless session

You build plans the user already approved, with nobody watching. Your prompt names the run directory (also `$AGENTS_AUTONOMOUS_RUN`), your group, its repo and its tasks in order. Each task is one plan file (`state.json` → `tasks.<task>.plan`). Work through the tasks one after another, then report. Nobody answers questions during the run: whatever would need the user stops that task, and the run goes on with the next one.

`RS` below means `python3 ~/.agents/skills/autonomous/run-state.py`, and `$RUN` the run directory. Write the command out in full each time, or define `RS` as a shell function; a variable such as `RS="python3 ..."` does not split into words in zsh.

## Never

- No `interview-me`, no planning, no `rethink`, no new or rewritten steps. The approved plan is the whole scope.
- No push, no gh writes, no PRs, no comments, no Slack or other posts except the one final report below. The no-remote-writes hook blocks these; never work around a block, record what would have been sent instead.
- No question to the user and no waiting for one. A decision the plan does not settle stops the task, with the question written in the task report.
- No edits in the user's checkout of the repo, and no edits in another task's worktree.
- Never end the turn while an agent or command you started still runs: a headless session is never resumed ([host-lifecycle.md](../workflow-runner/references/host-lifecycle.md)). You are a top-level session, so you may start the agents the skills below start (review lenses, QA runners, the step-check lens, the done-check checker), and you wait for each inside the turn.

## Run state

Every task moves through its stages with run-state, and only the stage `next` names can start or finish:

```bash
RS next $RUN <task>              # prints the stage to run, `done`, or `stopped: <reason>`
RS start $RUN <task> <stage>
# ... do the stage ...
RS finish $RUN <task> <stage> [--worktree PATH] [--result TEXT] [--skipped REASON]
RS stop $RUN <task> "<reason>"   # the task stops; go on with the next task
```

Loop on `next` until it prints `done` or `stopped: ...`. A finished stage counts only for the tree it finished on. When a repair changes the worktree, `next` sends you back to the first stage that ran on an older tree: rerun it as a recheck of the same work (the build stage then reruns every check command, the review stage runs general-review's recheck), not from scratch. After a crash, `launch.sh --resume` starts a new session: `next` skips what finished and reruns a stage that was left running.

## Stages, in order

1. **approval.** Done at launch. `next` checks the plan's stamp again each time; a plan edited after its approval stops the task by itself.
2. **worktree.** A working worktree next to the repo, as `git-worktrees` says: from the repo root, `git worktree add --no-track -b autonomous/<task> ../<repo folder>-<task> <base>`, where `<base>` is the base the plan names, else the repo's current `HEAD`. Reuse that sibling when it already exists for this task (a resumed run). Make sure `tmp/` is ignored there (add it to `.git/info/exclude` if not; never to `.gitignore`), so QA output never counts as a change. If the plan depends on uncommitted work in the user's checkout that the worktree lacks, stop with that reason. Then `RS finish $RUN <task> worktree --worktree <path>`. Every later stage works in this worktree.
3. **build.** doing-substantial-work steps 3 to 5, in the worktree: step 1's context first (project instructions, `CONSTRAINTS.md`), general-review's rule files and the stack skill, the plan's steps in order with their step baselines and step checks, its parallel parts when it lists them, each step ticked in the plan file with its log line. Step 4: run every check command in the plan's `## Checks` and keep each command with its exit code for the task report. Before `RS finish ... build`, `git status --porcelain --untracked-files=all` must list only the plan's own files: add check output (caches, coverage, build folders) to `.git/info/exclude`, never delete-and-rerun, so the stage's tree hash stays valid. Step 5's "ask the user" becomes a stop: after two failed tries on the same problem, `RS stop` with what you tried and what you saw.
4. **review.** `general-review` on the task diff (the worktree against the base it started from, uncommitted work included), with you as its coordinator. Apply the disposition policy below; after a repair, run its recheck before you finish. `RS finish ... review --result "<verdict>"`.
5. **qa-visual.** `branch-visual-qa` on the worktree against its base, reusing the review stage's result as its review lane (`next` guarantees the tree has not changed since). Build the report with `--embed` so `report-embedded.html` exists. Findings follow the disposition policy; after a repair, rerun the flows it touched.
6. **qa-video.** `video-qa` for the claim in the plan's confirmed intent, with the same versions. STILL BROKEN or INCOMPLETE is a finding under the policy. Keep the absolute paths of `<id>-before.mp4` and `<id>-after.mp4`.
7. **done-check.** Run done-check's checker once by hand for this task: one fresh subagent with the instructions `check_instructions` in `~/.agents/hooks/bin/done-check` builds (the plan's request and confirmed intent, the task diff, the plan's check commands, the task's incidents), plus the disposition policy. Fix under the policy, then `RS finish ... done-check --result "DONE-CHECK: PASS"`. Anything still open stops the task with what is open.
8. **commit.** One local commit in the worktree: stage only this task's files (`git add -- <files>`), a one-line message (rule 48), and follow git-guard when it denies. Never push. Then `RS finish $RUN <task> commit`.

**QA skip versus QA unavailable.** QA is skipped only when the plan changes nothing a user sees (no page, flow, output or message changes): `RS finish ... qa-visual --skipped "<why>"`, the same for qa-video, and the task report says why. QA that should run but cannot (a server will not start, no browser, fixtures missing) is "QA unavailable": `RS stop $RUN <task> "QA unavailable: <why>"`. That task is not done.

## Disposition policy (every repair stage: step checks, review, QA, done-check)

Severity and origin as general-review section 4 defines them.

- An introduced blocker, high or medium inside the plan's scope: fix it, within rule 44's three rounds (a round is: the reviewer reports, you fix, the reviewer rechecks). Still open after the third round: stop the task with the open findings.
- An introduced blocker, high or medium whose fix needs work outside the plan's scope: stop the task with the reason.
- Introduced lows, and every pre-existing or out-of-scope finding: never fixed. Record each in the task report.

Each mistake you make along the way gets its lesson saved as rule 58 in `~/.agents/AGENTS-RULES.md` says; list what you saved or changed under "Learned".

## Task report: `$RUN/tasks/<task>.md`

Start it when the task starts and keep it current, so a crash still leaves what happened. Finish it when the task ends, done or stopped. No `#` heading (the run report adds one per task):

- **Status:** done, or stopped at `<stage>`: the reason (and the question the plan did not settle, if that is why).
- **Commit:** sha, subject, branch and worktree path, or none.
- **Checks:** each check command with its exit code.
- **Review:** verdict, rounds, what was fixed.
- **QA:** the `index.html` and `report-embedded.html` paths, the video paths and verdict; or "QA skipped: why" or "QA unavailable: why".
- **Recorded findings:** each finding not fixed: severity, origin, `file:line`, one line.
- **Follow-ups:** in a here run, each change the user asked for mid-run, not built.
- **Learned:** each lesson saved (memory name) and each rule, skill or test changed by rule 58.

## End of your group

After your last task, run `RS group-done $RUN <group>`.

- `wait`: another session is still working and will send the report. End the turn with a one-line summary of your group.
- `last`: you send the run's report. Run `RS report $RUN`, which writes `$RUN/report.md` from every task's report (all groups). Then send it once:
  - Started from Slack (`RS show $RUN` has `slack` set): one `relay live say --channel <channel> --thread <thread> --text "<summary>" --file <file>`. `live say` takes one file: with only `report.md` to send, attach it; with QA files as well, put `report.md`, each task's `report-embedded.html` and its videos in one zip (`zip -j -0 $RUN/report.zip ...`) and attach that. One message; never a second post.
  - Started from the terminal: one `relay notify --file $RUN/report.md "<summary>"`.

  The summary is one or two sentences in plain words: how many tasks are done and committed, which stopped and why in a few words, where the report is. End the turn with the same summary.

## Here: the run happens in the user's own chat

When your prompt says the run is "in the user's own chat" (`launch.sh --here`), you are that chat, not a headless session. The launcher recorded this chat as the run's owner, so no-remote-writes and done-check apply the autonomous rules to this chat until the run ends. Everything above holds, with these exceptions only:

- Before the first stage, make sure nothing will stop for approval: Claude Code in auto or bypass-permissions mode, Codex with approvals off and a sandbox that lets you write the sibling worktree. If not, say so in one line, start no stage, and tell the user how to switch. Once a stage starts, still no question to the user and no waiting for one: a decision the plan does not settle stops the task as above.
- The user may write while the run goes on. Answer in one or two lines (progress from `RS show $RUN`, what you are on, anything they ask), then carry on with the stage you were in. A requested change to a plan is not built: record it under "Follow-ups" in that task's report and say so.
- The groups run one after another in this chat, in the order the launcher printed them. `RS group-done $RUN <group>` prints `next` while another group has work: read that group's prompt file and go on, without ending the turn. `last` sends the report as above.
- If the chat is summarized mid-run, re-read `$RUN/state.json` and the task reports, then go on with `RS next`. If the chat ends, `launch.sh --resume <run id>` from a new chat makes that chat the owner (refused while this one is still open) and prints the prompts again.
