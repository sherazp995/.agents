# PR batch mode

Use this mode for two or more pull requests or branches, or for any PR or branch when the user asks for batch, proof with tests, or parallel review. The main session acts as a lead engineer with a team and keeps its own context small: it never reads whole diffs, specs or agent transcripts. The only code it reads is the few lines in the spot-check (step 9).

Three levels:
- **Main session:** resolves targets, picks each target's ledger mode, writes a FOCUS list, starts one lead agent per target, spot-checks blocker and high findings, and reports.
- **Lead agent** (a fresh `general-purpose` agent, not a fork, running `pr-batch-lead.md`): starts the reviewers, runs the tests, proves every finding, and returns a record body. Only the main session writes the ledger.
- **Reviewers** (started by each lead): Codex `gpt-6-astra` as the senior engineer, plus fresh agents for `lenses/simplicity.md`, `lenses/architecture.md` and `lenses/thermonuclear.md`.

## Fixed rules

- Never post to GitHub or Slack, never send DMs, never commit or push. Results go to the terminal only.
- Do not review a PR that is merged or closed.
- Do not search Slack for PR lists. If no target is given, ask for it.
- **Always compare against the latest origin base:** fetch `origin <base>` first, use `origin/<base>` as BASE_REF, and never use or update a local base branch.
- Pin every comparison and merge to the fetched BASE_SHA and HEAD_SHA for the whole run; another session may refresh remote-tracking refs later.
- Throwaway proof specs live only in the lead's isolated worktree and the ledger's repro folder. The user's checkout is never modified.
- Reports follow `pr-batch-report.md`.

## Repo profile

A profile in `../profiles/<REPO_SLUG>.md` (relative to this file) holds what cannot be detected: the GitHub repo, where checkouts usually live, default base branches, the test environment, proof spec location, services to stub, stack hints for the lenses, and typical FOCUS risks. Read it in step 0 when it exists.

Without a profile, detect what you can (GitHub repo from `origin`, default branch from `gh repo view --json defaultBranchRef`), and give the lead `TEST_SETUP=detect`. The lead then works out the test commands from the repository itself, and falls back to proof by reading when it cannot run tests in isolation. Say in the report that no profile existed.

## Concurrency

- RUNNER, RUN_ID, REPO, REVIEW_TMP, the ledger (`LEDGER_ROOT`, one folder `D` per target with per-agent files), per-agent locks and the old-record adapter follow `ledger.md`.
- Run git as `cd <REPO> && git …`, never `git -C`.
- Work dir per target: `<REVIEW_TMP>/<KEY>-<short-sha>`.
- Generate a unique `TEST_ENV_NUMBER` per target, such as `_agent_<32 UUID hex digits>`. If the profile names a database, make sure the full name fits its length limit (63 bytes for PostgreSQL). Never reuse a database name.
- Record worktrees and databases this run creates. Cleanup removes **only those exact resources**. Never prune worktrees globally or drop databases by prefix. Pre-existing resources belong to other work, even if they share the target or head SHA.
- A running session does not see skill updates. If a concurrent older session may clean up globally, use a standalone clone (not a registered worktree) and database names outside its cleanup prefixes, and tell the lead.
- Use the models available in the host. Disclose any substitute for a required reviewer.
- Ask the user with AskUserQuestion when the host has it; otherwise ask in plain text and wait.

## Steps

0. **Find the checkout (REPO).**
   - Try `git rev-parse --show-toplevel` in the current folder. If the user named a repo and this folder's `origin` does not match it, or the profile's match check fails, ask where the checkout is. Offer the profile's usual locations that exist and pass the check; the user can type another path.
   - Use the main checkout's top-level path as REPO for every git, gh and agent step. Run `gh` with `--repo <GH_REPO>` so it works from any folder.
1. **Ledger:** `mkdir -p LEDGER_ROOT` and check `.origin` (`ledger.md`, "Where records live"). Cleanup runs at the end (step 12), not now.
2. **Resolve each target.**
   - **A number or PR URL:** `gh pr view <n> --repo <GH_REPO> --json state,baseRefName,headRefName,headRefOid,title`.
   - **A branch name:** `gh pr list --repo <GH_REPO> --head <branch> --state all --json number,state --limit 1`.
     - If a PR exists, treat the target as that PR (and move any `branch-` record, see `ledger.md`).
     - Otherwise it is a **branch target**. Base: `--base`, else the `base:` line of an existing record, else ask, offering the profile's base branches (first one marked Recommended) or the repo's default branch. Head: `origin/<branch>` if pushed, else the local branch marked "local only, not pushed". Title: the subject of its last commit.
3. **One fetch, before any agent starts** (agents never fetch): `cd <REPO> && git fetch origin <every base> <every pushed head branch of a branch target> <pull/<n>/head for every PR>`. A PR's head comes from `pull/<n>/head`, which also works for PRs opened from forks; its head branch name may not exist on origin. Then BASE_REF = `origin/<base>`, BASE_SHA = `git rev-parse origin/<base>`, HEAD_SHA = the fetched head or the PR's `headRefOid`.
4. **Decide per target:**
   - PR is MERGED or CLOSED: "already merged/closed, not reviewed".
   - Note READ_RUN_ID for the key (no lock yet; `ledger.md`, "Locking").
   - **Local commits:** apply step 3 of "Resolve the head" in SKILL.md section 1 (a local branch that differs from HEAD_SHA, whether ahead or diverged, means asking which to review).
   - Then, with the final HEAD_SHA: `git merge-base --is-ancestor <HEAD_SHA> <BASE_SHA>` succeeds: "already merged into <base>, not reviewed".
   - Pick review, recheck or "no changes" (`ledger.md`, "Picking the review mode"). For "no changes", list the OPEN items and start no agent.
   - Create the target's work dir and write `{WORKDIR}/earlier.md` as defined under EARLIER in `ledger.md`. This is the only earlier-findings input the lead gets.
   - For each recheck, if `git cat-file -e <PREV_STATE>^{commit}` fails, try `git fetch origin <PREV_STATE>` once. Set FORCE_PUSHED to `yes` when the commit is unavailable or `git merge-base --is-ancestor <PREV_STATE> <HEAD_SHA>` fails, else `no`. If the commit is still unavailable, set PREV_STATE to `n/a (previous head unavailable)`.
   - If any target or base fetch failed, report it and stop for that target; do not review a stale head.
5. **Write a FOCUS list per target, like a lead engineer would.** Look only at `gh pr view <n> --json title,body,files` (file names, not the diff), or `git diff --stat <BASE_SHA>...<HEAD_SHA>` for a branch. Write 3 to 6 short bullets naming the risks that matter for this change. Use the profile's typical risks as a starting point when they fit. In recheck mode, add the OPEN and PARTLY findings from the earlier record (mapped through the adapter for old records).
6. **Launch the lead agents in one message, all in the background,** one per target. The prompt is `pr-batch-lead.md` with every placeholder filled:
   - TARGET (`PR #<n>` or `branch <name> (no PR yet)`), PR (number or `none`), TITLE, BRANCH, HEAD_SHA, BASE, BASE_REF, BASE_SHA, MODE, PREV_STATE, FORCE_PUSHED, REPO, GH_REPO, WORKDIR, SKILL_DIR (this skill's root)
   - EARLIER = `{WORKDIR}/earlier.md`; REPRO = the earlier proof spec folder(s) named in it, or `none`; FINAL_REPRO = `D/repro/<RUNNER>/`
   - RUNNER, RUN_ID, TEST_ENV_NUMBER
   - TEST_SETUP, PROOF_DIR, STUBS and STACK_HINTS from the profile (or `detect`, the test framework's usual folder, "every external service", and `none`)
   - FOCUS = the bullets from step 5
   - Fill the profile values first, then every other placeholder: the profile's TEST_SETUP text itself contains `{WORKDIR}` and `{TEST_ENV_NUMBER}`. After filling, only the lens placeholders the lead fills (`{WT}`, `{DIFF}`, `{NEW_DIFF}`, `{PURPOSE}`) may remain.
7. **Tell the user in 3 to 5 lines:** RUNNER and RUN_ID, which targets run in which mode against which `origin/<base>` SHA, and which were skipped, not recorded, and why. While waiting, give a one-line update when a lead reports or when asked. Never guess results.
8. Wait for the leads.
9. **Spot-check before relaying.**
   - For each blocker or high finding, and each finding that claims a regression or "caused by this PR", read only the cited lines: `cd <REPO> && git show <HEAD_SHA>:<file> | sed -n '<line-10>,<line+10>p'`.
   - If the code does not support the claim, or a dropped finding looks real, ask the lead one question with SendMessage before relaying.
   - Check that every earlier OPEN finding got a status.
10. **Write the records**, one target at a time:
    - If a lead returned no `{WORKDIR}/record.md` (it failed, was stopped, or ran out of context), write nothing for that target and report it "incomplete, not recorded".
    - Step 9 corrections come from the lead: it amends its own `record.md` after your question. You never change a status, severity or line yourself; if you still disagree, add a `coordinator_note: <finding id> — <reason>` line.
    - Publish it with `scripts/publish_record.py` (`ledger.md`, "Locking"), passing `--repro {WORKDIR}/repro` when it has files and the branch options when a branch record moves to the PR folder.
11. **Relay** each lead's report as it is, plus one line for anything you corrected in step 9, then the "Status of all targets" table from `pr-batch-report.md`. Mention merged PRs whose record still had open items.
12. **Cleanup and final check:** run the cleanup agent (`ledger.md`, "Cleanup") and relay its short list. Confirm only this run's recorded worktrees and databases were removed and no lock this run took is still held (lock files themselves stay; never delete them). List any conflict files written. End with the final line from `ledger.md`, one per target.
