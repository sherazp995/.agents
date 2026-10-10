---
name: copilot-review
description: Emulate a GitHub Copilot PR review. A thin alias that runs general-review with only its diff-only blind lens (a context-blind pass over the diff that over-flags nil versus false, method visibility, error paths, accessibility, stale comments, config parsing and test gaps), then re-proves each finding with full context. Use whenever the user says "copilot review", "review like copilot", "run the copilot reviewer", or wants a branch cleaned of the comments Copilot would file. Reports only, unless the user also asks for the findings to be fixed.
---

# Copilot review

This is an alias. Read `~/.agents/skills/general-review/SKILL.md` and run it as a single-lens run with the lens `diff-only` (its "Single-lens runs" section). The checklist lives in `general-review/references/lenses/diff-only.md`; the rule against over-dropping its findings lives in general-review section 5. Do not keep a copy of either here.

- Same target resolution, re-proof, severity and report template as general-review.
- The session that invokes this alias is the coordinator and starts the diff-only agent itself (general-review "Who reviews" step 4), then a lead with `LENS` = `diff-only` that re-proves the agent's list. No subagent starts another agent, so this works where agents cannot nest. When this alias runs inside a subagent or a workflow step that has no agent tool, use general-review's inline fallback.
- When the user also asked for fixes ("fix them", "clean the branch"), fix the kept findings after the report, one at a time, smallest change first, matching surrounding style, then run the narrow tests and the linter. Report each fix or the reason it was dropped.
- For a full review with every lens, run general-review itself.
