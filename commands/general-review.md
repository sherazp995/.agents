---
description: Review changes, a PR, or a codebase and report verified findings only
argument-hint: "[PR, branch, files, or codebase]"
---

Read and follow `~/.agents/skills/general-review/SKILL.md`.

Review the target named below. If no target is supplied, review current staged and unstaged changes plus relevant untracked files. If the working tree is clean, review the current branch against its actual base. If neither provides a reviewable change, ask for the target rather than silently auditing the whole repository.

Report evidence-backed findings only. Do not apply fixes, modify source, commit, or publish review comments.

$ARGUMENTS
