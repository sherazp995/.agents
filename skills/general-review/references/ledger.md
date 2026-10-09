# Review ledger

Every general review, in both modes, keeps one ledger record per target. A later review of the same target reads it, rechecks what changed, and gives every earlier finding a status. Read this file in P0, before any write.

The ledger is a cache from (target, state) to findings. It relies on four rules: a stable KEY per target, a STATE the review itself cannot change, exactly one writer per record (the run holding that record's lock), and old records read through a fixed adapter.

## Run identity and temp space

- `RUNNER`: the **host running this skill**, not a reviewer model: `codex`, `claude`, or another known host's lowercase slug. If unavailable, `unknown`; never guess.
- `RUN_ID`: `<runner>-<UTC timestamp>-<random UUID>`. Announce both and pass them unchanged to every child agent. A Codex reviewer launched by Claude still belongs to the Claude run.
- `REPO`: the repository's top-level path (`git rev-parse --show-toplevel`). Run git as `cd <REPO> && git …`, never `git -C` (global rule 43).
- `REVIEW_TMP`: `<scratchpad>/general-review/<RUN_ID>` when the host provides a scratchpad, else `${TMPDIR:-/tmp}/general-review/<RUN_ID>`. Codex prompts, logs and other review artifacts go here, never into the reviewed checkout.

## Where records live

- `REPO_SLUG`: the repository name from `git remote get-url origin` (last path part, no `.git`, leading dots removed so the folder is not hidden). Without an origin, the top-level directory name, same rule. Outside Git, `no-repo`. The old-ledger adapter is passed the name with its dots kept.
- `LEDGER_ROOT=~/.agents/review-ledger/<REPO_SLUG>`, shared by every agent on this machine. Create it with `mkdir -p` (this one-time setup is allowed during the review). On creation, write the origin URL to `LEDGER_ROOT/.origin`. If `.origin` exists with a different URL, use `~/.agents/review-ledger/<owner>__<REPO_SLUG>` instead (same rules). `review-ledger/` is listed in `~/.agents/.gitignore`; add it there if it is missing.
- One folder per target: `D=LEDGER_ROOT/<KEY>/`. Each agent (RUNNER) has its **own** files in it, side by side with the others':

| Path in `D` | What | Who writes it |
| --- | --- | --- |
| `<RUNNER>.md` | this agent's current record | only this RUNNER |
| `<RUNNER>.lock` | this agent's lock file (an OS lock is held on it only while writing; the file itself may stay) | only this RUNNER |
| `<RUNNER>.old-<YYYY-MM-DD>-<short state>.md` | this agent's archived records | only this RUNNER |
| `<RUNNER>.conflict-<RUN_ID>.md` | a record that lost a write race; kept for the user | only this RUNNER |
| `repro/<RUNNER>/`, `repro/<RUNNER>.old-<…>/` | this agent's proof specs | only this RUNNER |

  Other agents' files in `D` (for example `codex.md` when RUNNER is `claude`) are **read-only siblings**: read them to know the other agent's state, never write, move, lock or clean them.
- Old history, read-only: `~/.claude/pr-review-ledger/<REPO_SLUG>/` (records from the older `cohabit_pr_review` skill). Never write, rename, clean or lock anything there.

## Keys

| Target | KEY |
| --- | --- |
| Pull request | `<PR number>` |
| Branch with no PR | `branch-<name with / replaced by __>` |
| Uncommitted work | `local-<current branch, / replaced by __>` (or `local-detached`) |
| Staged changes only | `staged-<current branch, / replaced by __>` (or `staged-detached`) |
| Selected files | `files-<first 12 hex of sha256 of the selection as given: the repo-relative paths, folders or globs, sorted, one per line>` (adding a file inside a selected folder keeps the key and changes STATE) |
| Whole codebase | `codebase` |

A branch target that now has a PR uses the PR key. If this agent has no `<n>/<RUNNER>.md` but has `branch-<name>/<RUNNER>.md`, that branch record is its earlier record (see "Picking the review mode"), and it moves to the PR folder at write time ("Locking").

When a `local-` review runs on a branch that also has a `branch-` or PR record (or the reverse), say in one line: "record for <other key> exists: N open findings (<path>)". The records stay separate; uncommitted edits are not part of a branch or PR review.

## STATE

| Target | STATE |
| --- | --- |
| PR or branch | head SHA |
| Uncommitted work | `<HEAD SHA>+<first 12 hex of sha256(MANIFEST)>` |
| Staged changes only | `<HEAD SHA>+<first 12 hex of sha256(INDEX MANIFEST)>` |
| Selected files | first 12 hex of sha256(MANIFEST over the selected paths) |
| Whole codebase | HEAD SHA, plus `+<manifest hash>` when the tree is dirty |

**MANIFEST** (deterministic, and unaffected by the review):
1. `cd <REPO>`; list `git diff --name-only HEAD` plus `git ls-files -o --exclude-standard` (for selected files: just those paths).
2. Drop anything under `tmp/`, `log/`, `coverage/` and `.nyc_output/`, and anything under `REVIEW_TMP`. (Gitignored files are already excluded.)
3. Sort the paths bytewise (`LC_ALL=C sort -u`).
4. One line per path: `<path>\t<git hash-object <path>>`, or `<path>\tdeleted` if it no longer exists. Never use `hash-object -w`.

**INDEX MANIFEST** (staged targets): `git diff --cached --name-only` sorted bytewise, one line per path: `<path>\t<blob from git ls-files -s <path>>`, or `<path>\tdeleted`. It changes when hunks are staged or unstaged, and not when only the working tree changes.

Compute STATE once in P0, before running any check, and store that value and its manifest in the record; never recompute it at the end, because the review's own test runs may write files. On the next run, comparing the two manifests gives the changed files, which is the recheck delta for uncommitted work.

## Locking (only at write time)

Nothing in `D` is written during the review. In P0, remember `READ_RUN_ID`: the `run_id:` of `D/<RUNNER>.md` if it exists, else `none`. Locks are per agent, so Claude and Codex never block each other; a lock only guards against two runs of the **same** agent.

At the end, publish with one command; never hand-write these steps:

```bash
python3 -I ~/.agents/skills/general-review/scripts/publish_record.py \
  --dir D --runner <RUNNER> --run-id <RUN_ID> --read-run-id <READ_RUN_ID> --body <record.md> \
  [--repro <proof spec dir>] [--full] [--branch-dir <LEDGER_ROOT>/branch-<name> --read-run-id-branch <READ_RUN_ID_BRANCH>]
```

It holds this agent's OS lock (branch folder first, then `D`), checks that nobody wrote since READ_RUN_ID, archives on `--full`, moves a branch record into `D` as an `.old-` archive (with its proof specs), stages new proof specs and archives the old ones before the record goes live, and publishes atomically. A `--repro` path that is not a folder is rejected before anything is written. Archives are named `<RUNNER>.old-<YYYY-MM-DD>-<short state>-<run id tail>.md`, so they never overwrite each other. The kernel releases the lock if the process dies, so there is no stale-lock handling.

- Exit 0: recorded.
- Exit 2: the body breaks the record format: a line that is not a header, manifest line or `#<id> [severity] … — STATUS` finding; a status outside the list; a missing `run_id:`, `state:`, `kind:` or `verdict:`; or CHANGES REQUIRED/BLOCKED with no finding lines. Nothing was written; the lead fixes record.md ("NOT FIXED" is written OPEN) and you publish again.
- Exit 3 (someone wrote meanwhile) or 75 (another run of this agent is writing): the body is kept as `D/<RUNNER>.conflict-<RUN_ID>.md`; report "not recorded as current" and the path.
- Any other exit: report it; the body is still in the review temp folder.

Conflict files are kept for the user to merge by hand; cleanup ignores them. Other ledger edits (cleanup) use `scripts/with_lock.py <lock file> -- <command>`, which holds the same lock for the command and exits 75 when busy.

## Picking the review mode

Decide per target once KEY and STATE are known, from **this agent's own** records. Nothing is renamed or archived until write time.

1. **`--full` (or "full review"):** MODE=review. At write time, archive any `D/<RUNNER>.md` and its repro folder to the `.old-` names first.
2. **`D/<RUNNER>.md` exists:** reuse it as "no changes since the last review on <date>" only when **all** hold:
   - its `state:` equals the current STATE;
   - its `kind:` equals the current target kind, and its `base:` and `base_sha:` equal the current baseline (the base branch and SHA for a PR or branch, the baseline revision for uncommitted work or files, `none` for a current-state assessment);
   - its `verdict:` is not INCOMPLETE;
   - its `mode:` is at least as strong as the request (`batch` covers a single-review request; `single` does not cover a request for batch or proof with tests);
   - no sibling record in `D` at the same STATE has an OPEN or PARTLY finding that this record has no `#<other>:<id>` status line for (otherwise recheck, so the new sibling findings get this agent's status).

   Then list its OPEN and PARTLY findings, show the sibling summary (below), and stop; no reviewers run, nothing is written. Otherwise MODE=recheck with `PREV_STATE` = its state, and say why (new commits, base moved, incomplete last run, or stronger mode asked).
3. **PR key with no own record, but `branch-<head branch>/<RUNNER>.md` exists:** that record is the earlier record. Note its `run_id` as READ_RUN_ID_BRANCH. MODE=recheck with `PREV_STATE` = its state; every one of its findings gets a status.
4. **No own record, but `D/<RUNNER>.old-*` exists:** MODE=review using the newest own `.old-` record as earlier findings. Do not read the old ledger.
5. **No own records in `D` at all:** first look for a record from this skill's earlier layout, `~/.claude/review-ledger/<REPO_SLUG with dots kept>/<KEY>.md` (read-only; leave it in place). If it exists, it is the earlier record: MODE=recheck with `PREV_STATE` = its state, and the first new record adds `imported_from: <its path>`. Otherwise run the adapter (below). Exit 0: MODE=recheck with `PREV_STATE` = its state (an imported record never produces "no changes"). Exit 4: review if asked, but do not record. Exit 3: continue.
6. **Nothing:** MODE=review.

**Sibling records.** Read every other agent's `D/<other>.md` (read-only). Report one line each: "<other> record (<date>, state <short>, <same | different> head): N open, verdict V". When a sibling is at the same STATE, the reviewer also gives each of its OPEN and PARTLY findings this agent's own status; the record keeps those as `#<other>:<id> … — <status> (checked by <RUNNER>)` lines, and the report lists where the two agents disagree.

**EARLIER** (handed to the reviewer as `REVIEW_TMP/<KEY>/earlier.md`, or `{WORKDIR}/earlier.md` in batch): the own source record path(s), `state:`, `base_sha:`, every `repro:` path, `imported_from:`/`source_runner:` when imported, and every own finding line exactly as recorded, open and closed, including status details. For old history it is the adapter script's full output. Then a section `other agents (read-only):` with each sibling record's path, state, verdict and its finding lines. `none` when there is nothing.

When an old-ledger record is newer (`date:`) than this agent's record for the same key, say so in one line; the old skill is still in use during the side-by-side month.

For a PR or branch recheck:
- Say "force-pushed" when `git merge-base --is-ancestor <PREV_STATE> <HEAD>` fails.
- If `git cat-file -e <PREV_STATE>^{commit}` fails, try `git fetch origin <PREV_STATE>` once (PR batch does this in its step 4). If it still fails, set the delta to "n/a (previous head unavailable)", review the full diff, and still give every earlier finding a status.

In recheck mode the review covers the whole frozen scope, starts from the delta, and gives every earlier finding a status from the record statuses below, each with a one-line proof. "Not fixed" is recorded as OPEN.

## Old-record adapter (read-only)

Old `cohabit_pr_review` records are read in place, never copied or moved, by a script that knows their line formats:

```bash
python3 -I ~/.agents/skills/general-review/scripts/old_ledger.py --slug <REPO_SLUG> --key <KEY> [--branch <head branch>]
```

Pass `--branch` for a PR key so a record kept under the branch name is found. Exit 3 means no old record. Exit 4 means some or all old records belong to a runner holding the old skill's lock (the output says `complete: no`, names the lock folder and its age, and still lists what it could read): review if asked, but do not record, so the locked runner's history is not cut off. If no old-skill run is active, show the user the lock path and ask them to remove it; never remove it yourself. The output is the earlier-findings list to use: `imported_from:`, `source_runner:`, `state:`, `base_sha:`, a `recomputed_verdict:`, the old verdicts for reference, and one line per finding as `#O-<runner>-<n> [severity] text — STATUS`, plus `(question)` marks, status details, `repro:` paths, notes and history. An "open findings outside the current record" section lists open lines from older records that no newer record continues, and lines rescued from dropped copies; each gets a status in the recheck. Older-head lines do not count toward the recomputed verdict; rescued lines at the current head do.

What it does, so you can check it:
- Looks under the old ledger's root, `agents/*/` and `runs/*/`, and skips a runner that holds the old skill's lock (then exits 4). When a record is an `inherited_from:` copy of another candidate, keeps the newer of the two (by `date:`, then `run_id` time); the other is listed as history, and findings the kept records of the same copy chain lack are listed as `…-dropped` lines when the deciding copy is open: the copy at the current head if there is one, else the newest copy (once per finding per chain, with every source's `repro:` path). Findings are matched only within one chain (records joined by `inherited_from:`), never across unrelated records, and unknown statuses are warned about in every loaded record. A dropped copy at the current head counts toward the recomputed verdict like a current finding; older-head lines do not.
- An older-head record counts as continued only through explicit lineage: an `inherited_from:` link in a newest-head record or in one of its `.old-` archives. Everything else is listed under open findings outside the current record. Exception for noise: when a legacy record's finding numbers all reappear in the current record, its open low and medium lines are folded into one `#O-group-<head>-<n> [highest member severity] … — OPEN` line, followed by one indented `member:` line per folded finding with its full text, severity and status; blocker and high lines are always listed one by one. The number match is only a hint, not proof: the reviewer compares each member with the current record, records any member whose topic differs as its own finding line (with its own status), and then gives the group N/A ("continued as <current ids>") for the remaining members. If no member is continued, every member gets its own line and the group line is N/A ("split out"). `member:` lines are context only and never go into the record.
- Takes the head as the first 40-hex SHA, picks the newest head (by `date:`, then `run_id` time), and merges **every** record with that head. Older heads are listed as history.
- Severity: CRITICAL→blocker, HIGH, MEDIUM, LOW kept, NIT→low; a missing tag → low; any tag containing "question", or `(question)` in the line, marks an open question that never gates. A tag containing "dropped" means DROPPED.
- Status: the text after the last separator (` — `, ` : ` or `: `) must **start** with a status word; the explanation only refines it. NOT FIXED→OPEN, DECLINED→ACCEPTED, OPEN or PARTLY with "accepted" right after `(`, `;` or `,` → ACCEPTED (so "not yet accepted" stays open), `OPEN (PARTLY…)`→PARTLY, N/A stays N/A. Anything else (for example `REOPENED (was FIXED)`) → UNKNOWN, with a WARNING. Markdown headings are not findings.
- Origin: introduced (the old skill reported only problems the change introduced). The verdict is recomputed with SKILL.md section 6; the old verdict is never mapped.

If the output has any WARNING about unknown statuses, show those lines to the user and ask before trusting the verdict. If the script cannot run, say so and do a fresh review instead of parsing old records by hand.

The writer of the first new record adds the `imported_from:` and `source_runner:` lines from the output.

## Record format

Written once, at the end of the review, to `D/<RUNNER>.md` by the steps in "Locking". Readers and cleanup ignore `*.tmp-*`, `*.conflict-*` and `*.lock` files. The lead always writes the body (`REVIEW_TMP/<KEY>/record.md`, or `{WORKDIR}/record.md` in batch) and amends it itself after a coordinator question; the coordinator writes it to `D/<RUNNER>.md` unchanged, adding only `coordinator_note:` lines; `imported_from:` and `source_runner:` come from the lead, copied from EARLIER.

```text
skill: general-review
runner: <RUNNER>
run_id: <RUN_ID>
mode: single | batch
target: <PR #n | branch name | uncommitted on <branch> | staged on <branch> | files <paths> | codebase>
key: <KEY>
base: <base branch or baseline, or none>
base_sha: <sha or none>
head: <head sha or none>
state: <STATE>
date: <YYYY-MM-DD>
kind: <pr | branch | uncommitted | staged | files | codebase>
verdict: <PASS | CHANGES REQUIRED | BLOCKED | N/A | INCOMPLETE>
imported_from: <path>          (only on the first record after an import)
source_runner: <runner>        (same)

#I-1 [high] path/file.rb:42 — one-line problem — OPEN
#I-2 [low] path/other.ts:7 — one-line problem — OPEN (parked for user)
#O-claude-4 [low] path/z.rb:9 — one-line problem — ACCEPTED (imported)
#codex:I-2 [medium] path/w.rb:5 — one-line problem — FIXED (checked by claude)
#P-1 [medium] path/x.py:10 — one-line problem — OPEN (pre-existing)
#I-3 [medium] path/y.rb:3 — one-line problem — FIXED (<date>)

manifest:                      (uncommitted, staged and files targets)
<path>\t<blob or deleted>

repro: <D/repro/RUNNER/ or none>
```

- Statuses: `OPEN`, `PARTLY`, `FIXED`, `N/A` (code removed or no longer reachable), `ACCEPTED` (the user decided not to fix it), `DROPPED` (a re-proof showed it was not real). OPEN and PARTLY are the only open statuses. Keep closed lines so the history stays in one place. A status outside this list is an error: stop and ask the user.
- Keep finding IDs stable across rechecks. Every finding goes in the record, including pre-existing ones the report shortened.
- A review that ends `Review incomplete` still writes its record with `verdict: INCOMPLETE`, so the next run rechecks rather than trusting it.

## Cleanup (at the end)

After this run's records are written and its locks released, start a `general-purpose` agent with `model: haiku` running `references/ledger-cleanup.md`, with `{LEDGER_ROOT}`, `{REPO}`, `{GH_REPO}` (`owner/name` from origin, or `none`), `{RUNNER}` and `{RUN_ID}` filled in. Wait for it and relay its short list. If the host has no agent tool, follow that file yourself.

## Final line

End the review with `Runner: <host> | Run: <RUN_ID> | Ledger: <record path, or "not recorded: <reason>">`.
