Run owner: {RUNNER}; run ID: {RUN_ID}. Clean this agent's records in the review ledger at {LEDGER_ROOT}. Each target has a folder `{LEDGER_ROOT}/<key>/` holding one set of files per agent. You may touch **only {RUNNER}'s files**: `{RUNNER}.md`, `{RUNNER}.old-*.md`, `repro/{RUNNER}/` and `repro/{RUNNER}.old-*/`. Never touch another agent's files, lock files, conflict files, `~/.claude/pr-review-ledger/` (read-only history), worktrees or databases.

Do not post to GitHub or Slack. The only git commands allowed are the read-only ones below, run as `cd {REPO} && git …` (never `git -C`). Never fetch, checkout or change refs. GitHub repo: {GH_REPO}. If it is `none`, skip every `gh` command and treat its result as "unknown".

1. List the key folders in {LEDGER_ROOT} that contain `{RUNNER}.md` or `{RUNNER}.old-*.md`. Ignore `.origin`.
2. Decide for each key:
   - **PR key** (`<n>`): `gh pr view <n> --repo {GH_REPO} --json state -q .state`. MERGED or CLOSED → finished. OPEN, unknown, or a failed command → keep.
   - **Branch key** (`branch-<name>`): read `base:` from `{RUNNER}.md`. The branch name is the key without `branch-`, decoded: `%2F` back to `/`, then `%25` back to `%`.
     - If `gh pr list --repo {GH_REPO} --head <branch> --state all --json number -q '.[0].number'` returns a number → keep. The main session moves it to the PR folder.
     - Else, if `git ls-remote --heads origin <branch>` succeeds and prints nothing → finished only if the branch is also absent locally (`git show-ref --verify refs/heads/<branch>` fails). A failed remote lookup is not evidence of deletion.
     - Else, if `git ls-remote origin refs/heads/<branch> refs/heads/<base>` gives both SHAs, both commits exist locally, and `git merge-base --is-ancestor <branch sha> <base sha>` succeeds → finished. A missing commit means keep.
     - Otherwise → keep.
   - **Local or staged key** (`local-<branch>`, `staged-<branch>`; decode the branch the same way): finished only if the branch no longer exists locally and `ls-remote` succeeds and shows it absent on origin. `local-detached` and `staged-detached` → keep.
   - **`files-*`, `codebase` and any other key:** always keep.
3. For each finished key:
   - Read `{RUNNER}.md` (or the newest `{RUNNER}.old-*.md`) and collect every finding line whose status is OPEN or PARTLY.
   - **List-only mode (the default until the user turns it off in this file):** do not delete anything. Report the exact paths that would be deleted.
   - Otherwise, delete under this agent's lock, re-checking first that the record was not rewritten since you read it:
     `python3 -I ~/.agents/skills/general-review/scripts/with_lock.py {LEDGER_ROOT}/<key>/{RUNNER}.lock -- bash -c 'grep -qx "run_id: <run_id you read>" {RUNNER}.md || exit 3; rm -rf <this agent's paths>'` (run from the key folder). Exit 75 or 3: skip the key and report it.
   - Leave the lock file in place (deleting it could split the lock between two files).
4. Final message, short and in simple English:
   - `Would clean (list-only): <paths>` or `Cleaned: #a (merged), branch x (deleted on origin)`, or `Nothing to clean`.
   - For each finished key with unfixed findings: `<key> finished with these still open:` then its finding lines exactly as written. This is their last record, so the user can open a follow-up.
   - `Kept: #x (open), branch y (not merged)`, and `Skipped (locked): …` if any.
