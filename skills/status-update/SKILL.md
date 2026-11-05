---
name: status-update
description: >-
  Write a status update on PRs and tasks in the house format, as Slack friendly Markdown the
  user can paste straight into Slack: bold section headings ("Reviewed PRs:", "Finalized and
  merged PRs:", "Opened PRs:", "Updated PRs:", "WIP branches:", "Tasks:"), one bullet per item
  with the PR title linked to the PR, and past-tense sub-bullets saying what was done. Reviewed
  PRs are other people's PRs the user reviewed, on GitHub or in local Claude/Codex review
  sessions. Use whenever the user asks for a status update, a standup update, "what did I do",
  "write up the PRs", "summarise this work for the team", or invokes /status-update. Also use
  before posting progress to Slack, a ticket, or a colleague. If the current project has its
  own status-update skill, use that one instead.
---

# Status update

## Format

Slack friendly Markdown, ready to paste into Slack as is. The reply is the update and
nothing else: no preamble, no summary paragraph, no closing note, no code fence around it.

One bold heading per section, then one bullet per item. The item's title is a Markdown link
to the PR or branch. Each item's body lines are sub-bullets under it, indented two spaces.
Sections go in this order, and an empty section is left out:

```
**Reviewed PRs:**
- [<pr title> #<number>](<pr link>)

**Finalized and merged PRs:**
- [<pr title>](<pr link>)
  - <past tense line>
  - <another past tense line>

**Opened PRs:**
- [<pr title>](<pr link>) (draft)
  - <past tense line>

**Updated PRs:**
- [<pr title>](<pr link>)
  - <past tense line>

**WIP branches:**
- [<branch name>](<branch link>)
  - <past tense line>

**Tasks:**
- <task title, no link>
  - <past tense line>
```

Sections:

- `Reviewed PRs:` lists other people's PRs the user reviewed in this period, on GitHub or in
  a local Claude or Codex review session. One bullet per PR: the title and `#<number>`, both
  inside the link text. No sub-bullets, no approved/commented split. Each PR appears once.
- The user's own PRs never go in `Reviewed PRs:`, even when the user ran local reviews on them
  or a teammate approved them.
- `Finalized and merged PRs:` for PRs merged in this period. This replaces Opened or Updated,
  even if the PR was also opened or changed in the same period.
- `Opened PRs:` for PRs raised in this period.
- `Updated PRs:` for PRs that already existed and got new commits or changes.
- Add ` (draft)` after the link when the PR is a draft.
- `WIP branches:` for pushed branches with work in this period but no PR yet. The link is the
  branch on GitHub: `https://github.com/<owner>/<repo>/tree/<branch>`. Skip branches that were
  never pushed.
- `Tasks:` for anything that is not a PR or branch: the task name, no link.

Links are always `[text](url)` with the full `https://` URL. Never paste a bare URL, never put
the link in square brackets after the title, and never use Slack's `<url|text>` syntax.

Body lines describe what the change does for the person using the app, e.g. "The form
now checks that both passwords match while you type." Leave out housekeeping such as
merging develop into the branch or "Merged into develop"; the heading already says it.
If a PR had only housekeeping in the period, describe what the PR does overall.

**Example:**
```
**Reviewed PRs:**
- [Broker renewals list sorts by expiry date #3812](https://github.com/cohabitplatforms/cohabit-web/pull/3812)
- [Strata dashboard shows the company logo #3815](https://github.com/cohabitplatforms/cohabit-web/pull/3815)

**Finalized and merged PRs:**
- [Fix production errors on the broker new business JSON URL and /users/edit](https://github.com/cohabitplatforms/cohabit-web/pull/3790)
  - Error pages now show as normal web pages instead of crashing.
  - The resend confirmation page now loads.

**Opened PRs:**
- [Expert invitation form blocks mismatched passwords before submitting](https://github.com/cohabitplatforms/cohabit-web/pull/3811)
  - The expert invitation form now checks that both passwords match while you type.
  - The browser now blocks the submit and shows "Passwords don't match" when they differ.
  - Before this, the form was sent and the server rejected it.

**Updated PRs:**
- [Broker cannot create a second open new business opportunity for the same building](https://github.com/cohabitplatforms/cohabit-web/pull/3805) (draft)
  - Each New Business row now shows the building address under the plan number, so rows with the same plan number can be told apart.
  - The Filters panel now closes when a modal opens, so it no longer covers the modal and blocks its clicks.
  - Renamed the submit button in the new opportunity modal from "Add building" to "Add opportunity".

**WIP branches:**
- [fix/expert-company-profile-no-company](https://github.com/cohabitplatforms/cohabit-web/tree/fix/expert-company-profile-no-company)
  - Expert admins with no company now see a clear message instead of an error page.
  - Experts created by staff in the backend are now linked to the Cohabit company automatically.
```

Body lines:

- Past tense, one thing per line. "Added", "Fixed", "Traced", "Confirmed".
- Each body line is a sub-bullet (`  - `) under its item.
- One complete sentence per line. Never split a sentence across two lines to make it shorter.
- No word cap. A line runs as long as the sentence needs, and stops there.

## Plain words

The reader is skimming on a phone. Write the line so they get it the first time.

- One idea per line. If a line has a "so" or an "and" holding two ideas together, split it.
- Say what a person sees, not how the code is shaped. "Sign-in was always rejected" beats
  "the login was refused by construction".
- Drop the jargon. Say "the Google account link", not "the identity link row". Say
  "escaped user text in the form", not "escaped the view interpolations".
- Name a file or function only when the reader needs it to find the code. Otherwise say
  what it does.
- No clever phrasing. "Base and alias never fight over it" is cute and unclear. Say which
  account keeps the link and why that matters.
- Keep an acronym only if the team says it out loud. XSS is fine. Resolver is not.

**Don't:**
```
Found that Google only ever asserts the real mailbox, so a requested +alias address could never match and the login was refused by construction.
Added baseEmail and providerMayOpen to lib/db/src/email.ts so a requested address is accepted when it is the verified one or a +alias of it.
Kept the identity link row on the base account, so base and alias never fight over it.
Escaped all six view interpolations, which closed a reflected XSS in the login and signup forms.
```

**Do:**
```
Google always signs you in as your real email, never a +alias.
So asking to sign in as an alias was always rejected.
Added a check that accepts the requested email if it is the real one or a +alias of it.
Kept the Google link on the main account, so signing in as an alias no longer moves it.
Escaped the user text in the login and signup forms, which fixed an XSS bug.
```

## Voice

Rules 45 and 47 from `~/.agents/AGENTS-RULES.md`, restated with this skill's examples. That file is the source of truth
for how these lines read.

### 47. Talk like a normal junior developer: short messages, answer first
Lead with the answer, especially for yes/no and "do we need to do anything here". Then stop. Long replies with conditionals, background and caveats read as unresolved even when the answer is settled, and the user has to hunt for the decision.

Cut background that wasn't asked for. If something is optional or a maybe-later, say "nothing to do" and leave it, rather than laying out both branches and making the user choose. Detail belongs where it's wanted: when the user asks why, or in a PR description or ticket. Not in a commit message, see rule 48. Findings and review verdicts still get reported, just briefly.

**Don't:** bury "no action needed" under two paragraphs explaining what would happen in each of two possible outcomes.
**Do:** "No, nothing to do. The fix is verified. That other thing was a maybe-later note, ignore it."

### 45. Never use a dash to join clauses in prose
Do not connect or separate parts of a sentence with a hyphen or dash (`-`, `–`, `—`). Use a comma, period, colon, semicolon, or parentheses instead. This applies to all prose written for the user: chat replies, reports, PR descriptions, commit messages, and code comments.

**Don't:** "The fix works — I verified it in the browser."
**Do:** "The fix works. I verified it in the browser."

**Don't:** "Restyled the composer, list above, composer below."
**Do:** "Restyled the composer so the list sits above it."

(Hyphens inside a single compound word, e.g. `chat-style`, `left-align`, are fine. The rule bans the dash used as sentence punctuation, not intra-word hyphens.)

### Rule 46 does not apply here
Rule 46 asks for one short point per bullet. That does not apply to a status update, on the
user's explicit instruction: one complete sentence per line, never split to hit a word count.

## Gathering the facts

Never guess a title, a link, or a state. Read them.

- `gh pr view <n> --repo <owner/repo> --json number,title,url,state,isDraft,createdAt,updatedAt,mergedAt`
  (`isDraft` adds the (draft) mark, `mergedAt` in the period picks Finalized and merged).
- WIP branches: `git fetch`, then `git log --remotes --author=<user> --since=<start> --format='%h %D %s'`
  and keep the remote branches with no PR (`gh pr list --head <branch> --state all`).
- `gh pr diff <n> --repo <owner/repo>` for what actually changed.
- `gh pr checks <n> --repo <owner/repo>` when CI state matters.
- `git log --oneline --author=<user> <since>..HEAD` for work that never became a PR.
- GitHub reviews: list candidates with
  `gh search prs --reviewed-by=@me --updated='>=<start date>' --json number,title,url,repository,author --limit 100`
  and drop the ones the user authored. `@me` is the active `gh` account, so switch to the
  project's account first (`gh auth status`). Then, for each, read the user's own reviews:
  `gh api repos/<owner/repo>/pulls/<n>/reviews --jq '.[] | select(.user.login=="<login>") | {state, submitted_at}'`.
  Keep the PR only if one of those reviews was submitted in the period.
- Local reviews: most reviews run in Claude and Codex sessions on this machine and never reach
  GitHub. Find them in the review ledgers written in the period:
  `find ~/.claude/pr-review-ledger ~/.agents/review-ledger ~/.claude/review-ledger -name '*.md' -newermt '<start, local time>' -not -path '*/repro/*'`.
  The PR number is the file name (`3801.md`) or its folder (`3799/claude.md`). A `branch-<name>.md`
  file is a branch with `__` for `/`: look up its PR with `gh pr list --head <branch> --state all`,
  and skip it if there is none. Check the review sessions too, since a run can end before it writes
  a ledger: `agents-hub recent --all-scopes --limit 100`, keeping sessions in the period whose title
  says review or whose folder is a review worktree (`/private/tmp/pr-review/.../<number>-<sha>/wt`
  gives the PR number; a `cohabit-web-<name>` worktree gives the branch).
- Read each candidate's author with `gh pr view <n> --repo <owner/repo> --json title,url,author` and keep
  only PRs the user did not author.

If `gh` fails with "Could not resolve to a Repository", the wrong account is active. Check
`gh auth status` and `gh auth switch --user <login>`.

Blockers go on their own sub-bullet under the item they belong to, in the same past-tense voice,
or as a plain sentence after the last section if it applies to everything.
