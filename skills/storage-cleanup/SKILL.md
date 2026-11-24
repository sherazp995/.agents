---
name: storage-cleanup
description: "Use when the disk is full or nearly full, at the end of every finished task (the done check sends you here before DONE-CHECK: PASS), or when the user asks agents to clean up after their work. Deletes only what this session created: temp files freely, deliverables after a Slack backup, worktrees once pushed. Never destructive."
---

<!-- agents-hub:learned-skill -->

# storage-cleanup

Learned from memories the user confirmed. Follow every rule below; each one
came from a correction or preference the user gave in a past session.

Clean up only what your own session created. You need no approval for these
steps, and nothing here may destroy work.

## Two modes

- **End-of-task mode:** the done check sends you here when a task will end
  with `DONE-CHECK: PASS`. Run steps 2 to 5 only, skip anything already
  clean, and report in one line just above the `DONE-CHECK:` line (for
  example "Cleanup: deleted 3 temp folders, sent the QA video to Slack, kept
  worktree X (unpushed)", or "Cleanup: nothing to clean"). Never clean up
  when ending with OPEN: the open work still needs its files. In an
  autonomous run delete temp files only and keep the run directory and its
  deliverables. In a Relay team member session leave deliverables to the
  lead, since team members may not run relay commands.
- **Full mode:** the disk is full or nearly full, or the user asks. Run every
  step below.

## Steps

1. **Measure.** Run `df -h /`, and `sysctl vm.swapusage` on macOS. Check them
   also when tools fail oddly (ENOSPC, crashed reviewers).
2. **List your own paths.** Tie each path to this session: its scratchpad,
   its review run folders (by run id), its clones, logs, test databases, dead
   locks of its own runs, and the worktrees it added. Leave anything you cannot
   tie to your own session.
3. **Temp files:** delete them. They need no backup.
4. **Deliverables** (video-qa videos, visual-qa reports, any file the user may
   want): send each to Slack first, unless it is already there. In a Relay
   thread use `relay live say --channel <id> --thread <ts> --text "<what it is>"
   --file <path>` (copy the channel and thread from the say line in your
   messages); otherwise `relay notify --file <path> "<what it is>"` sends it by
   DM. Each file may be up to 100 MB. Delete it only after the upload
   succeeded.
5. **Worktrees you added:** remove one only when all three hold:
   - clean: no uncommitted or untracked changes (rebuildable ignored files
     such as `node_modules` are fine);
   - pushed: after `git fetch --prune` its commits are on the remote, pushed
     directly or merged into a branch that is pushed
     (`git rev-list HEAD --not --remotes` prints nothing), or its HEAD is the
     head of a merged PR (`gh pr list --state merged --head <branch> --json
     headRefOid` shows that commit), which covers squash merges;
   - idle: no server runs from it (`lsof -a -d cwd` and `ps` for that path).

   Remove it from the main checkout: `cd <main> && git worktree remove <path>`.
   The branch stays. Keep the main checkout.
6. **Report** in one short list: what was deleted, what was sent to Slack, what
   was kept and why, and free space before and after.

## Never

- Touch another session's files, worktrees with unpushed commits, or branches.
- Run `git reset`, `git clean`, `git branch -D`, or `rm` outside your own paths.
- Stop a server just to tidy, unless the user named that worktree; then stop
  its servers first (cohabit: `tunnels.sh down --keep-shared` from that
  worktree), then `git worktree remove --force`.
- Count `du` of `/private/var/folders/*/X/com.google.Chrome.code_sign_clone` as
  reclaimable: those are APFS clones, and deleting them frees almost nothing.

## Before heavy work

Run at most two review runs at once and queue the rest; check `df -h /` and
swap first. Four parallel dual reviews once pushed swap to 10 GB and filled
the disk.

## Why

Hassan asked on 2026-11-24, after a full disk killed running reviews, that
agents clean up after themselves without asking, never destructively, with
Slack backups of deliverables.

_Learned from `global/cleanup-own-tmp-and-worktrees-v2.md` on 2026-11-24._

_Learned from `global/worktree-delete-rule.md` on 2026-11-24._

_Learned from `-Users-hassan-Documents-cohabitplatforms-cohabit-web/review-runs-max-two-parallel.md` on 2026-11-24._
