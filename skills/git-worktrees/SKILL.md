---
name: git-worktrees
description: "Use when creating, reusing or removing a git worktree. Working worktrees go next to the repo as <repo>-<task-or-branch>; throwaway ones go in a separate temp folder and are removed afterwards."
---

<!-- agents-hub:learned-skill -->

# git-worktrees

Learned from memories the user confirmed. Follow every rule below; each one
came from a correction or preference the user gave in a past session.

## Rules

### 1. Decide first: working or throwaway

- **Working:** a task or ticket branch the user will build, test, commit or push from.
- **Throwaway:** a review proof checkout, a QA base (develop) checkout, or an experiment nobody works in.

### 2. Working worktrees go next to the repo

- Path: the repo's parent folder, named `<repo-name>-<task-or-branch-slug>`.
- Example: for `~/Documents/zubair549/cohabit-web`, use `~/Documents/zubair549/cohabit-web-ci-326`.
- Command, from the repo root: `git worktree add --no-track -b <branch> ../<repo>-<slug> origin/<base>`.
- Never inside the repo (`.claude/worktrees/`, the EnterWorktree default).
- Never in a shared subfolder (`wt/`, `cohabit-web-worktrees/`) or in `/tmp`.
- Reuse the existing sibling for the same task; do not make a second one.
- Remove it once its branch is pushed and the work is done.
- If a tool picks its own location and cannot be pointed here, tell the user.

### 3. Throwaway worktrees go in a separate folder

- Use the agent's scratchpad or a temp directory.
- Remove them when the run ends.

### 4. Never let a feature branch track the shared base

- `git worktree add -b <branch> ... origin/<base>` and `git checkout -b <branch> origin/<base>` make the branch track `origin/<base>`.
- A later bare `git push` then lands on develop, staging or uat.
- Create the branch with `--no-track`, or run `git branch --unset-upstream` right after.
- Push with an explicit target: `git push -u origin <branch>` (or `origin <branch>:<branch>`).
- If a commit reaches a shared branch and is reverted there, give the feature branch a fresh commit on top of the revert. Never rebase onto the revert: git then silently drops the commit as already applied.

### 5. Base branch per repo

- `zubair549/cohabit-web`: branch from `origin/develop`.
- `cohabitplatforms/cohabit-web`: branch from `origin/staging` (memory `cohabit-base-branch-staging`).

## Why

- 2026-10-13: "Every agent is starting random worktrees. So we should follow a convention." Then: "the throwaway worktrees can be in some separate folders because I'm not currently working on them."
- Earlier, in the cohabitplatforms checkout, the user stopped a `.claude/worktrees/` setup: "/Users/hassan/Documents/cohabitplatforms/cohabit-web-*** you need this dir for the worktree."
- A bare push from a branch tracking the shared base once landed a commit on develop that had to be reverted.

_Learned from `global/worktree-location-convention-v2.md` on 2026-10-13._
_Learned from `-Users-hassan-Documents-cohabitplatforms-cohabit-web/cohabit-worktree-location.md` on 2026-10-13._
_Learned from `-Users-hassan-Documents-cohabitplatforms-cohabit-web/branch-upstream-push-trap.md` on 2026-10-13._
