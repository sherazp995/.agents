---
name: status-update
description: >-
  Write a status update on PRs and tasks in the house format: one "Opened PR:"/"Updated PR:"/
  "Finalized and merged PR:"/"WIP branch:"/task heading per item (draft PRs marked), followed by past-tense lines saying what was done. Use whenever the
  user asks for a status update, a standup update, "what did I do", "write up the PRs",
  "summarise this work for the team", or invokes /status-update. Also use before posting
  progress to Slack, a ticket, or a colleague. If the current project has its own
  status-update skill, use that one instead.
---

# Status update

## Format

One block per PR or task. A blank line between blocks. Nothing else: no preamble, no
summary paragraph, no closing note.

```
Opened PR: <pr title> [pr link]
<past tense line about what was done>
<another past tense line>

Updated draft PR: <pr title> [pr link]
<past tense line>
<another past tense line>

Finalized and merged PR: <pr title> [pr link]
<past tense line>

WIP branch: <branch name> [branch link]
<past tense line>
<another past tense line>

<task title, no link>
<past tense line>
<another past tense line>
```

Headings:

- `Opened PR:` for a PR raised in this period.
- `Updated PR:` for a PR that already existed and got new commits or changes.
- Add `draft` before `PR` when the PR is a draft: `Opened draft PR:`, `Updated draft PR:`.
- `Finalized and merged PR:` for a PR merged in this period. This replaces Opened or
  Updated, even if it was also opened or changed in the same period.
- `WIP branch: <branch name> [branch link]` for a pushed branch with work in this period but no PR yet.
  The link is the branch on GitHub: `https://github.com/<owner>/<repo>/tree/<branch>`.
  Skip branches that were never pushed.
- For anything that is not a PR or branch, just the task name on the heading line, no
  prefix, no link.

Body lines describe what the change does for the person using the app, e.g. "The form
now checks that both passwords match while you type." Leave out housekeeping such as
merging develop into the branch or "Merged into develop"; the heading already says it.
If a PR had only housekeeping in the period, describe what the PR does overall.

**Example:**
```
Opened PR: Expert invitation form blocks mismatched passwords before submitting
The expert invitation form now checks that both passwords match while you type.
The browser now blocks the submit and shows "Passwords don't match" when they differ.
Before this, the form was sent and the server rejected it.

Updated draft PR: Broker cannot create a second open new business opportunity for the same building
Each New Business row now shows the building address under the plan number, so rows with the same plan number can be told apart.
The Filters panel now closes when a modal opens, so it no longer covers the modal and blocks its clicks.
Renamed the submit button in the new opportunity modal from "Add building" to "Add opportunity".

WIP branch: fix/expert-company-profile-no-company [https://github.com/cohabitplatforms/cohabit-web/tree/fix/expert-company-profile-no-company]
Expert admins with no company now see a clear message instead of an error page.
Experts created by staff in the backend are now linked to the Cohabit company automatically.

Finalized and merged PR: Fix production errors on the broker new business JSON URL and /users/edit
Error pages now show as normal web pages instead of crashing.
The resend confirmation page now loads.
```

Body lines:

- Past tense, one thing per line. "Added", "Fixed", "Traced", "Confirmed".
- Plain lines, not bullets. No leading `-` or `*`.
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

Rules 45 and 47, copied verbatim from `~/.claude/CLAUDE.md`. They are the source of truth
for how these lines read. Follow them exactly.

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
Rule 46 caps bullet-point reports at 10 words per bullet. A status update is exempt, on the
user's explicit instruction: one complete sentence per line, never split to hit a word count.

## Gathering the facts

Never guess a title, a link, or a state. Read them.

- `gh pr view <n> --repo <owner/repo> --json number,title,url,state,isDraft,createdAt,updatedAt,mergedAt`
  (`isDraft` picks the draft heading, `mergedAt` in the period picks Finalized and merged).
- WIP branches: `git fetch`, then `git log --remotes --author=<user> --since=<start> --format='%h %D %s'`
  and keep the remote branches with no PR (`gh pr list --head <branch> --state all`).
- `gh pr diff <n> --repo <owner/repo>` for what actually changed.
- `gh pr checks <n> --repo <owner/repo>` when CI state matters.
- `git log --oneline --author=<user> <since>..HEAD` for work that never became a PR.

If `gh` fails with "Could not resolve to a Repository", the wrong account is active. Check
`gh auth status` and `gh auth switch --user <login>`.

Blockers go on their own line under the block they belong to, in the same past-tense voice,
or as a plain sentence after the last block if it applies to everything.
