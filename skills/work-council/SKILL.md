---
name: work-council
description: A by-name option of doing-substantial-work for risky plans (the `deep` risk list in rethink's "Tiers" section). Takes the plan and its check commands, gets the plan critiqued by the llm-council engineering council, then builds it best of two (Claude and Codex in separate worktrees, checks, then judges pick one), brings the winner into the checkout and hands back to doing-substantial-work for proof, review and commit. Works the same in Claude Code and Codex. Use only when the user invokes /work-council, asks for "the work council", "combined work" or "best of two", or accepts doing-substantial-work's offer of it for a risky plan. Not for one-line fixes, questions, or read-only review (use general-review or llm-council for those).
argument-hint: "<task> [--auto]"
---

# Work council

It runs only by name (`/work-council <task>`, "best of two") or when the user accepts `doing-substantial-work`'s offer for a risky plan. The plan is made in `doing-substantial-work` step 2, and this skill takes it from there.

This skill does only two things for a plan: the plan gate critique and the best-of-two build. Everything else (context, plan, proof, review, commit, report) belongs to `doing-substantial-work`, which takes control back after section 5 here and runs its steps 6 to 8.

**Only these skills are used, all siblings in this skills folder:** `doing-substantial-work`, `llm-council`, and `workflow-runner` when the host has no Workflow tool.

**Input:** the plan text from `doing-substantial-work` and its final check commands (each must exit 0 when the work is done).

## Hosts

This skill runs the same in Claude Code and Codex. Workflows (`llm-council/council-workflow.js`, [build-workflow.js](build-workflow.js)) run through Claude Code's Workflow tool there, and through the sibling `workflow-runner` skill's `run-workflow.mjs` in Codex or any other host; same script, same result. Never imitate a workflow by hand. Missing or failing CLIs: continue without that input and report it as a limitation.

To run a workflow script with args:

- **Claude Code:** `Workflow({ scriptPath: "<absolute script path>", args: <args> })`. The Run ID is printed with the launch.
- **Codex or another host:** from inside the repository, with the longest command timeout the host allows (each agent may take up to 30 minutes, and phases run one after another; if the host's limit is shorter, run it in the background and wait for it), `node <skills folder>/workflow-runner/run-workflow.mjs <absolute script path> --args @<args.json>` (write args to a JSON file in `WC_TMP`). Its output is `{ "runId", "result" }`; `runId` is the Run ID. See `workflow-runner`'s SKILL.md for the one-time Codex setup.

The Codex builder (AGENTS.md delegation exception 6; waits follow [host-lifecycle.md](../workflow-runner/references/host-lifecycle.md)) runs `codex exec --sandbox workspace-write`, which a permission mode (such as auto mode) may deny. Then the build yields one candidate, which wins (`decidedBy: only-candidate`) only if it passed every check. Never work around a denial; tell the user, who can approve that command or add a permission rule for it and rerun.

Estimated cost: about 15 agents, 3 Codex runs, a few minutes. Model and effort per agent are set in each script's header table: cheap relays (haiku, low), one opus high plus one sonnet medium judge, opus high tie-breaker only on a split.

## 1. Protect the checkout

1. Builders start from a commit in fresh worktrees, so uncommitted and untracked files are invisible to them. If `git status --porcelain` prints anything, ask the user to commit or stash it before the build, or to carry on in `doing-substantial-work` instead.
2. Record `BASE=$(git rev-parse HEAD)`. Existing uncommitted work is the user's: never discard or overwrite it.
3. Make a run folder outside the repository with `mktemp -d` and call its path `WC_TMP`. Prompts, args and logs go there, never in the checkout.

Shell variables may not survive between commands, so write the literal `BASE` sha and `WC_TMP` path into later commands.

## 2. Plan gate

Run the engineering council on the plan: script `llm-council/council-workflow.js` in this skill's parent folder, run as described under **Hosts**, with args `{ "council": "engineering", "question": "Critique this plan for <task>. What is wrong, missing, risky, or more complex than needed? Plan:\n<plan text>" }`.

The critique is a list of candidates. Check each against the code; adopt what holds, and note what you rejected and why. If the adopted changes alter the steps (not just wording), send the revised plan through `rethink`'s approval-only start (`{START}` = `approval-only`, lead.md pass 4) so both models approve the plan the user will see. Then show the user the plan (intent, steps, checks, and what the critique changed) and wait for approval, unless `--auto` (or "don't wait for me"). This approval replaces the one in `doing-substantial-work` step 2 for this plan.

## 3. Build best of two

1. Confirm `git rev-parse HEAD` still prints `BASE`. If HEAD moved since planning, re-check the plan against the new HEAD, record the new `BASE`, and say so.
2. Run the build workflow, `build-workflow.js` in this skill's folder, as described under **Hosts**, with args `{ "task": "<intent>", "plan": "<plan text>", "checks": ["<cmd>", ...], "baseSha": "<BASE>" }`.
   If the repository root holds `.work-council.json` with `"codexNetwork": true`, add `"codexNetwork": true` to the args, so the Codex sandbox can reach local services such as Postgres. Read it from the checkout: it is untracked (listed in `.git/info/exclude`), so the builders' worktrees do not have it. Without it the sandbox stays offline.
3. It returns `{ winner, runnerUp, decidedBy, graft[], judges[], missing[] }`, or `{ error }` for bad input (report it and stop). Note the Run ID (`wf_...`).
   Only a candidate that passed every check can win; a usable one that failed is listed in `missing` with reason `failed checks` and its `worktreePath`. `decidedBy` is `checks` (one of two usable candidates passed), `judges` (both passed; majority vote), `only-candidate` (the one usable candidate passed), `fallback` (both passed, no judge majority; X by roster order, not a judged winner), or `none` (no candidate passed every check).

## 4. Bring the winner in

With a winner, bring its change into the user's checkout as staged, uncommitted changes. Builders stage their work and never commit (a commit hook may forbid it), so the change is the winner worktree's staged diff. Run from the repository root:

```bash
(cd '<winner.worktreePath>' && git diff --cached --binary <BASE>) | git apply --3way
```

Inside the quotes, write any single quote in the path as `'\''`.

Then check each `graft` item against the code and apply the ones that hold. Then run every check command in the checkout yourself: a builder's reported exit codes are not proof for the applied change. If any check fails, keep the worktrees, report which check failed, and stop. With no winner, report `missing` and offer to build the plan in `doing-substantial-work` instead.

## 5. Clean up and hand back

Clean up this run's worktrees with [cleanup-worktrees.sh](cleanup-worktrees.sh), run from inside the repository. It finds them from git (branches named `worktree-<Run ID>-<n>`), not from builder reports, so a builder that crashed is not missed. It touches no other worktree, and removes `.claude/worktrees` only when that leaves it empty.

- **After a winner is applied and every check passed in the checkout:** `bash <this skill's folder>/cleanup-worktrees.sh <Run ID>`.
- **With no winner:** a failed builder may hold partial work. Show the user `bash <this skill's folder>/cleanup-worktrees.sh <Run ID> --list` and run the removal only when the user agrees.

Delete `$WC_TMP`, then return to `doing-substantial-work` step 6 (Prove it), then its steps 7 and 8 (the checks already ran in section 4). Its report adds: plan critique adopted and rejected (one-line reason each), the build winner (name Claude or Codex only here, after judging), `decidedBy`, grafts applied, and anything missing (Codex down, a builder failed, judges split).

## Red flags: stop and go back a step

- Building with a dirty checkout or a `BASE` that no longer matches HEAD.
- Treating a critique, judge vote, or Codex claim as fact without checking the code.
- Removing worktrees of a run with no winner before the user agrees.
