Run owner: {RUNNER}; run ID: {RUN_ID}. The parent has selected the isolated ledger namespace {L} and holds any required lock. Clean only that namespace. Never change locks, legacy root records, other runner namespaces, worktrees or databases.

Clean the PR review ledger at {L}. Delete only the records of work that is finished: merged or closed PRs, and branches that are merged or deleted. Do not post to GitHub or Slack. The only git commands allowed are the read-only ones below, run as `cd {REPO} && git …` (never `git -C`, global rule 43). Never fetch, checkout or change refs.

1. List the record keys in {L}:
   - PR keys look like `<n>`; branch keys look like `branch-<name>`.
   - Files and folders for each key: `<key>.md`, `<key>.old-*.md`, `repro/<key>/` and `repro/<key>.old-*/`.
2. Decide for each key:
   - **PR key:** run `gh pr view <n> --repo cohabitplatforms/cohabit-web --json state -q .state`.
     - MERGED or CLOSED → finished.
     - OPEN, or the command fails → keep it.
   - **Branch key:**
     - Read `branch:` and `base:` from `<key>.md`. The branch name is the key without `branch-`, with `__` turned back into `/`.
     - If `gh pr list --repo cohabitplatforms/cohabit-web --head <branch> --state all --json number -q '.[0].number'` returns a number → keep it. The main session will move it to the PR key.
     - Else, if `cd {REPO} && git ls-remote --heads origin <branch>` succeeds and prints nothing → finished only if the branch is also absent locally (`git show-ref --verify refs/heads/<branch>`). Preserve active local-only branches. A failed remote lookup is not evidence of deletion.
     - Else, if `cd {REPO} && git merge-base --is-ancestor origin/<branch> origin/<base>` succeeds (already merged) → finished.
     - Otherwise → keep it.
3. For each finished key:
   - Read `<key>.md` (or the newest `<key>.old-*.md` if there is no current one).
   - Collect every finding line that does not end in FIXED or DROPPED (for example OPEN, UNKNOWN, PARTLY).
   - Then delete all of that key's files and folders listed in step 1. Use `rm -rf` only on these exact paths inside {L}.
4. Final message, in simple English and short:
   - `Cleaned: #a (merged), branch x (deleted on origin)`, or `Nothing to clean`.
   - For each cleaned key that had unfixed findings, write: `<key> finished with these still open:` followed by its finding lines exactly as they were. This is the last record of them, so the user can open a follow-up.
   - `Kept: #x (open), branch y (not merged)`.
