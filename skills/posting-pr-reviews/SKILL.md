---
name: posting-pr-reviews
description: Post review findings on a GitHub PR as inline comments, one per finding on its line, in one API call under one approval card. Use whenever review findings go to a PR ("post the review", "post as a review on the PR", "add the findings as comments", "request changes on the PR"), after cohabit_pr_review, general-review, a Relay team review or any other review. Never post findings as one summary comment or a review body list.
---

# Posting PR reviews

Hassan's rule: **every finding is an inline comment on the line it is about.** A review never carries the findings as one body comment. The review body is empty or one short line.

## Before posting

1. Account: ask Hassan which GitHub account to post the review from, listing the logged-in accounts (`gh auth status`). Skip the question only when his request already names the account ("with Hassan's gh profile"). If the chosen account isn't the active one, run `gh auth switch --user <account>` as its own command, post, then switch back to `HassanAkbar` and confirm with `gh auth status`.
2. The PR is open for review: `gh api repos/<o>/<r>/pulls/<n> --jq '{draft, author: .user.login, head: .head.sha, requested: [.requested_reviewers[].login]}'`. A draft, or a PR where HassanAkbar isn't requested, stays in the thread: say why and ask.
3. Read what is already on the PR: `gh api repos/<o>/<r>/pulls/<n>/comments` and `gh pr view <n> --comments`. Drop a finding someone already raised.
4. Keep only findings that matter (High, Medium, real Lows). Nits stay in the chat report.
5. Pin the head sha you reviewed. If the PR head moved since the review, say so and recheck before posting.

## Anchor each finding to a diff line

GitHub accepts inline comments only on lines inside the PR diff (added, removed or context lines of a hunk).

- Get the hunks: `gh api repos/<o>/<r>/pulls/<n>/files --paginate --jq '.[] | {filename, patch}'`.
- A finding on a changed or context line: anchor it there (`side: RIGHT` for the new file, `LEFT` for a removed line). For a range, add `start_line`.
- A finding on a file or line outside the diff (a missed sibling endpoint, say): anchor it on the changed line it relates to most closely, and name the real place in the text ("Same lookup is still unscoped in `app/api/api/v1/inspections.rb:31`"). If no changed line relates, do not post it: tell Hassan in the thread.
- A missing spec: anchor it on the guard the spec should cover.

## Writing each comment

- One finding per comment. Lead with what goes wrong, as a concrete scenario, then the suggested fix, often as a question ("Could this use `Inspection.visible_to(current_user)`?").
- A few short sentences. Plain words, no severity labels needed, no dashes in prose.
- Never name the reviewers or tools (Claude, Codex, Daniel, Probe, general review). It is Hassan's review.
- A small exact fix can be a GitHub suggestion block.

## Posting: one call, one card

Write the payload to a file, then post it with REST in a single command (each remote write waits for its own Slack approval card, so one call means one card):

```json
{
  "commit_id": "<pinned head sha>",
  "event": "REQUEST_CHANGES",
  "body": "",
  "comments": [
    { "path": "app/api/api/v1/comments.rb", "line": 42, "side": "RIGHT", "body": "..." },
    { "path": "app/models/meeting.rb", "start_line": 127, "line": 129, "side": "RIGHT", "body": "..." }
  ]
}
```

```sh
gh api -X POST repos/<o>/<r>/pulls/<n>/reviews --input /tmp/<run>/review.json
```

- `event`: `REQUEST_CHANGES` when a High or Medium stands, `COMMENT` for Lows only, `APPROVE` only when Hassan says so.
- `body`: leave it empty. If GitHub refuses an empty body for that event, use one line such as "Requesting changes, see the inline comments." Never list findings there.
- Before the post command, show Hassan the exact comment list that will go up: one line per inline comment with its `file:line`, and the total. The count must match the payload. Never preview a grouped summary (such as "missing specs") that becomes several comments.
- The command runs alone, with nothing chained (Relay approval rule). After approval, run it verbatim.
- A 422 "line must be part of the diff" means an anchor is wrong: fix the anchor, do not move the finding into the body.

## After posting

- Verify: `gh api repos/<o>/<r>/pulls/<n>/reviews --jq '.[-1] | {user: .user.login, state}'` and `gh api repos/<o>/<r>/pulls/<n>/comments --jq '[.[] | select(.pull_request_review_id == <id>) | {path, line}]'`. Every finding shows as an inline comment.
- Report in one line: posted, its state, the PR link. Mention any finding that was kept in the thread instead.

## Replies to someone else's review comments

Different job: reply under each inline thread, never with a review body. See the memories `pr-replies-inline-only-no-review-body` and `gh-graphql-replies-land-pending`.
