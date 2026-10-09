---
name: cohabit_pr_review
description: >-
  Review or recheck cohabit-web PRs and branches against the latest origin base.
  Uses independent reviewers, test-backed findings, and a review ledger.
  Identifies the host agent and isolates concurrent runs. Accepts PR numbers,
  branch names, an optional base branch, and full-review requests.
---

# cohabit PR review

Keep your own context small. Never read whole diffs, specs or agent transcripts. The only code you read is the few lines in the spot-check (step 8).
Three levels, like a senior lead with a team:
- **You, the main session:** decide the mode from the ledger, write a FOCUS list per target, start one lead agent per target, spot-check HIGH findings, and report.
- **Lead agent** (a fresh `general-purpose` agent, not a fork, running `agent-prompt.md`): starts the reviewers, runs the tests, proves every finding with a test, writes the ledger.
- **Reviewers** (started by each lead): Codex gpt-6-astra (senior engineer), and fresh agents for `lens-simplicity.md`, `lens-architecture.md` and `lens-thermonuclear.md`.

## Fixed rules
- Never post to GitHub or Slack, never send DMs, never commit or push. Results go to the terminal only.
- Do not review a PR that is merged or closed.
- Do not search Slack for PR lists. If no target is given, ask for it.
- **Always compare against the latest origin base:**
  - fetch `origin <base>` first;
  - use `origin/<base>` as BASE_REF;
  - never use or update a local base branch.
- Every report follows `style.md`.

## Runner identity and concurrent runs

Before cleanup or any write, identify the **host running this skill**, not a reviewer model: `codex`, `claude`, or another known host's lowercase slug. If unavailable, use `unknown`; never guess. Set `RUNNER` to this slug and `RUN_ID` to `<runner>-<UTC timestamp>-<random UUID>`. Announce the runner and run ID, and pass both unchanged to all children. A Codex reviewer launched by Claude still belongs to the Claude run.

- Keep shared skill instructions in their existing canonical directory. Resolve supporting files relative to this `SKILL.md`.
- Set `LEDGER_ROOT=~/.claude/pr-review-ledger/cohabit-web`. Legacy records directly under it are read-only history. Never migrate, overwrite or clean another runner's records.
- Set the normal ledger namespace to `LEDGER_ROOT/agents/<RUNNER>`. Create the `agents` parent directory if needed. Before starting cleanup, acquire its sibling lock atomically with `mkdir LEDGER_ROOT/agents/<RUNNER>.lock`; record this run's ID inside it. Hold it until all child agents finish and cleanup completes. Only remove a lock acquired by this run. Never steal or remove an existing lock, even if it appears stale.
- If the lock already exists, continue using `L=LEDGER_ROOT/runs/<RUN_ID>` instead of the normal namespace. Read prior records from the normal namespace only as history, and announce the separate output location. Never retry shared writes without acquiring the lock. Other lock errors are setup failures, not proof another run owns it.
- Otherwise set `L=LEDGER_ROOT/agents/<RUNNER>`. Cleanup and ledger mutations are restricted to this run's selected `L`. If a current record is absent, a prior record from this runner or the legacy root may be copied into `L` for a recheck. Copy matching proof specs too and rewrite the copied record's `repro:` path to this run's destination; never rename or delete the source. If a source is being updated, skip importing it and do a fresh review. Label inherited records with their source path and recorded runner, or `unknown` for legacy records.
- Use `<scratchpad>/pr-review/<RUN_ID>/<KEY>-<short-sha>` for each target's work directory. Generate a unique `TEST_ENV_NUMBER` per target, such as `_agent_<32 UUID hex digits>`, and ensure the complete database name fits PostgreSQL's 63-byte limit. Never reuse a PR-only or branch-only database name.
- Updating this skill does not update instructions already loaded by a running session. If a known concurrent legacy session may perform global cleanup, use a standalone clone (not a registered worktree) and database names outside its cleanup prefixes. Alternatively, proceed with worktrees only when that session is known to restrict cleanup to its own resources. Pass this isolation choice to the lead; it overrides the default worktree setup.
- Record worktrees and database names created by this run. Cleanup may remove **only these exact resources**. Never globally prune worktrees or drop databases by prefix. Pre-existing resources belong to other work, even if they share the target or head SHA.
- Pin comparisons and merges to the fetched BASE_SHA and HEAD_SHA throughout the run; another session may refresh remote-tracking refs afterward.
- Put `runner:`, `run_id:` and the output paths in each ledger and final report. Reviewer model names are separate attribution, not the run owner. Use models available in the host; disclose substitutions for required reviewers.

## Paths
- Repo `REPO`: resolve it in step 0. Never hard-code it.
- Skill dir: the directory containing this `SKILL.md` (`agent-prompt.md`, `lens-*.md`, `cleanup-prompt.md`, `style.md`).
- Ledger dir `L`: selected and locked as described above. KEY is the PR number, or `branch-<branch name with / replaced by __>` for a branch with no PR.
  - `L/<KEY>.md`: the current record (target, base, last reviewed head SHA, findings with status).
  - `L/repro/<KEY>/`: the current proof specs.
  - `L/<KEY>.old-<YYYY-MM-DD>-<sha>.md` and `L/repro/<KEY>.old-<YYYY-MM-DD>-<sha>/`: earlier records, kept for history.
- Work dir: `<scratchpad>/pr-review/<RUN_ID>/<KEY>-<short-sha>`.

## Steps
0. **Find the cohabit-web checkout (REPO).**
   - A folder counts as cohabit-web when `git -C <dir> remote get-url origin` contains `cohabitplatforms/cohabit-web`.
   - Try `git rev-parse --show-toplevel` in the current folder first. If that is cohabit-web, use it.
   - Otherwise, ask the user with AskUserQuestion: "This folder is not inside cohabit-web. Where is your cohabit-web checkout?"
     - Offer as options any of `~/cohabitplatforms/cohabit-web`, `~/cohabit-web` and `~/code/cohabit-web` that exist and pass the check. The user can type another path with "Other".
     - Check the answer the same way. If it fails, say why and ask again.
   - Use the top-level path of the main checkout as REPO for every git, gh and agent step. Run `gh` commands with `--repo cohabitplatforms/cohabit-web`, so they work from any folder.
1. **Cleanup agent:** after selecting `L` and acquiring its lock (or selecting an isolated fallback), start it in the background. Use a fresh `general-purpose` agent with `model: haiku`, running `cleanup-prompt.md` with `{L}`, `{REPO}`, `{RUNNER}` and `{RUN_ID}` filled in. Do not wait for it.
2. **Resolve each target.**
   - **A number or PR URL:** run `gh pr view <n> --json state,baseRefName,headRefName,headRefOid,title`.
   - **A branch name:** run `gh pr list --head <branch> --state all --json number,state --limit 1`.
     - If a PR exists, treat the target as that PR. If `L/branch-<name>.md` exists and `L/<n>.md` does not, rename the record and its repro folder to the PR number. Then continue as a PR.
     - If no PR exists, this is a **branch target**:
       - Base: `--base`, else the `base:` line of an existing `L/branch-<name>.md`, else **ask the user** with AskUserQuestion. Offer `staging` (Recommended), `develop`, `master`.
       - Head: `origin/<branch>` if it exists on origin (fetch it in step 3). Otherwise use the local branch and mark it "local only, not pushed".
       - Title: the subject of the branch's last commit.
3. **One fetch, before any review agent starts** (agents never fetch):
   `git -C <repo> fetch origin <every base> <every pushed head branch>`.
   Then set:
   - BASE_REF = `origin/<base>`
   - BASE_SHA = `git rev-parse origin/<base>`
   - HEAD_SHA = the fetched head, or the PR's headRefOid
4. **Decide per target:**
   - **PR is MERGED or CLOSED:** "already merged/closed, not reviewed". The cleanup agent reports its open findings.
   - **Branch is already fully contained in `origin/<base>`** (`git merge-base --is-ancestor <HEAD_SHA> <BASE_SHA>`): "already merged into <base>, not reviewed".
   - **`--full` and `L/<KEY>.md` exists:** archive first, then do a full review.
     - Rename `L/<KEY>.md` to `L/<KEY>.old-<today>-<its head sha>.md`.
     - Rename `L/repro/<KEY>/` to `L/repro/<KEY>.old-<today>-<sha>/`.
     - Then use MODE=review.
   - **No `L/<KEY>.md`:** MODE=review.
   - **`L/<KEY>.md` head == HEAD_SHA:** "no new commits". List the OPEN items from the ledger. No agent.
   - **Otherwise:** MODE=recheck, PREV_SHA = the ledger head. Say "force-pushed" if PREV_SHA is not an ancestor of HEAD_SHA.
5. **Write a FOCUS list per target, like a lead engineer would.**
   - Look only at `gh pr view <n> --json title,body,files` (file names, not the diff), or `git diff --stat <BASE_SHA>...<HEAD_SHA>` for a branch.
   - Write 3-6 short bullets naming the risks that matter for this change. For example:
     - payments → double charge, webhooks, CSRF, retries;
     - access scoping → IDOR on ids in params, cross-company leaks, users in several companies;
     - forms/JS → values carried over from a previous selection, older browsers;
     - type or state changes → orphaned or deleted history, notifications.
   - In recheck mode, add the OPEN findings from the ledger.
6. **Launch the lead agents in one message, all in the background.** One lead agent per target. Each lead starts its own four reviewers (Codex gpt-6-astra, simplicity, architecture, thermonuclear), runs the tests and proves every finding. The prompt is `agent-prompt.md` with these placeholders filled:
   - TARGET: `PR #<n>` or `branch <name> (no PR yet)`
   - PR: the number, or `none`
   - TITLE, BRANCH, HEAD_SHA, BASE, BASE_REF, BASE_SHA, MODE, PREV_SHA, REPO, WORKDIR
   - LEDGER = `L/<KEY>.md`, REPRO = `L/repro/<KEY>/`
   - RUNNER, RUN_ID, and the unique per-target TEST_ENV_NUMBER from the concurrency rules
   - FOCUS = the bullets from step 5
7. Tell the user in 3-5 lines: RUNNER and RUN_ID, which targets run, in which mode, against which `origin/<base>` SHA, and which were skipped and why. While waiting, give a one-line update when a lead reports or when asked. Never guess results.
8. **Spot-check before relaying,** like a lead engineer.
   - For each CRITICAL or HIGH finding, and for each finding that says "regression" or "caused by this PR", read only the cited lines: `git -C <repo> show <HEAD_SHA>:<file> | sed -n '<line-10>,<line+10>p'`.
   - If the code does not support the claim, or a dropped finding looks real, send the lead one question with SendMessage before relaying.
   - Check that every earlier OPEN finding in the ledger got a status.
9. Relay each lead's report as it is (it already follows the style), plus one line for anything you corrected in step 8. Relay the cleanup agent's short list.
10. After the last report, add the "Status of all PRs" table from `style.md`. Branch targets get the row label `branch <name>`. Mention merged PRs whose ledger still had open items.
11. **Final check:** confirm only this run's recorded worktrees and databases have been removed. Leave all pre-existing and other-run resources untouched. Wait for cleanup and all children to finish, then release only this run's acquired namespace lock. Include RUNNER, RUN_ID and ledger/report paths in the final response.
