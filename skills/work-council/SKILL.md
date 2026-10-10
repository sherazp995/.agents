---
name: work-council
description: Do a coding task end to end with independent checks at every step. Plan with pass/fail commands, get the plan critiqued (Codex, or the full llm-council in thorough mode), build it (one builder, or Claude and Codex in separate worktrees with judges picking the better result), then verify with real checks and general-review and fix until it passes. Works the same in Claude Code and Codex. Use when the user invokes /work-council, asks for "the work council", "combined work", "best of two", or wants a change built and checked by several models. Not for one-line fixes, questions, or read-only review (use general-review or llm-council for those).
argument-hint: "<task> [--thorough] [--auto]"
---

# Work council

The partner of `llm-council` and `general-review`: they advise and review, this skill does the work. Quality comes from the steps around the model, so the steps are fixed. Speed comes from cutting scope and running independent work in parallel, never from skipping a step.

**Only these skills are used, all siblings in this skills folder:** `llm-council`, `general-review`, `writing-specs`. Do not substitute other skills or custom agent types; built-in agent types (`general-purpose`, `Plan`) are fine.

## Modes

| Mode | Plan gate | Build | Cost |
|---|---|---|---|
| `fast` (default) | One read-only critique from the other model | This session, card by card | One session plus one run of the other model |
| `thorough` (`--thorough`, or "best of two") | `llm-council` engineering council | [build-workflow.js](build-workflow.js): Claude and Codex build in separate worktrees; checks, then judges, pick one | Estimate, re-measure once Codex is installed: about 15 agents, 3 Codex runs, a few minutes. Model and effort per agent are set in each script's header table: cheap relays (haiku, low), one opus high plus one sonnet medium judge, opus high tie-breaker only on a split |

Both modes pause for the user's approval after the plan. `--auto` (or "don't wait for me") skips that pause only. If the user explicitly says to skip any other step, skip it and list it in the report as "skipped at your request".

**Hosts.** This skill runs the same in Claude Code and Codex. Workflows (`llm-council/council-workflow.js`, [build-workflow.js](build-workflow.js)) run through Claude Code's Workflow tool there, and through the sibling `workflow-runner` skill's `run-workflow.mjs` in Codex or any other host; same script, same result. Never imitate a workflow by hand. **The other model** is Codex when the host is Claude, and Claude when the host is Codex. Missing or failing CLIs: continue without that input and report it as a limitation.

To run a workflow script with args:

- **Claude Code:** `Workflow({ scriptPath: "<absolute script path>", args: <args> })`. The Run ID is printed with the launch.
- **Codex or another host:** from inside the repository, with the longest command timeout the host allows (each agent may take up to 30 minutes, and phases run one after another; if the host's limit is shorter, run it in the background and wait for it), `node <skills folder>/workflow-runner/run-workflow.mjs <absolute script path> --args @<args.json>` (write args to a JSON file in `WC_TMP`). Its output is `{ "runId", "result" }`; `runId` is the Run ID. See `workflow-runner`'s SKILL.md for the one-time Codex setup.

The Codex builder runs `codex exec --sandbox workspace-write`, which a permission mode (such as auto mode) may deny. Then thorough mode yields one candidate (`decidedBy: only-candidate`). Never work around a denial; tell the user, who can approve that command or add a permission rule for it and rerun.

## 1. Load context

1. Read the repository's instruction files (`CLAUDE.md`, `AGENTS.md`, and rule files they reference).
2. Restate the task as one-line intent plus acceptance criteria. Ask only if missing intent would change the design.
3. Find the repository's real check commands (tests, lint, type check, build). Prefer narrow ones for the touched area.
4. **Thorough only:** builders start from a commit in fresh worktrees, so uncommitted and untracked files are invisible to them. If `git status --porcelain` prints anything, ask the user now, before planning, to commit or stash it, or switch to fast mode.
5. Record `BASE=$(git rev-parse HEAD)` and `git status --short`. Existing uncommitted work is the user's: never discard or overwrite it.
6. Make a run folder outside the repository with `mktemp -d` and call its path `WC_TMP`. Plans, prompts and logs go there, never in the checkout.

Shell variables may not survive between commands, so write the literal `BASE` sha and `WC_TMP` path into later commands.

## 2. Plan

Write `$WC_TMP/plan.md` from [the plan template](references/plan-template.md):

- intent in one line, and what is out of scope;
- unknowns that would change the design, each settled by a quick probe and tagged `[measured]`, `[inferred]` or `[unknown]`;
- cards of about five files each, each with **one command that passes or fails**;
- the final checks: commands that must all exit 0 when the work is done.

## 3. Plan gate

**Fast:** get one read-only critique from the other model while you re-read the plan yourself. Write the prompt to `$WC_TMP/plan-critique.prompt` (task, plan text, and: "Find what is wrong, missing, risky, or more complex than needed in this plan. Cite path:line for every claim about the code. Read-only: do not edit files.") and run from the repository root.

Host is Claude, ask Codex:

```bash
codex exec -m gpt-6-astra --sandbox read-only -c approval_policy=never --ignore-user-config --ignore-rules --ephemeral \
  -C "$PWD" -o "$WC_TMP/plan-critique.md" - < "$WC_TMP/plan-critique.prompt" > "$WC_TMP/plan-critique.log" 2>&1; echo "exit=$?"
```

If the model is rejected, rerun once with `-m gpt-5.6-sol`. Any other failure: record the exit code and continue.

Host is Codex, ask Claude through the runner's read-only `second-opinion.js` workflow (three separate commands; keep the runner command plain, with no pipe, redirect or wrapper, so Codex's allow rule matches):

```bash
node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[2], JSON.stringify({ prompt: fs.readFileSync(process.argv[1], "utf8") }))' "$WC_TMP/plan-critique.prompt" "$WC_TMP/plan-critique.args.json"
node <skills folder>/workflow-runner/run-workflow.mjs <skills folder>/workflow-runner/second-opinion.js --args @<WC_TMP>/plan-critique.args.json --out <WC_TMP>/plan-critique.json
node -e 'const r = require(process.argv[1]).result; if (!r.text) { console.error(r.error); process.exit(1) } require("fs").writeFileSync(process.argv[2], r.text)' "$WC_TMP/plan-critique.json" "$WC_TMP/plan-critique.md"
```

**Thorough:** run the engineering council on the plan: script `llm-council/council-workflow.js` in this skill's parent folder, run as described under **Hosts**, with args `{ "council": "engineering", "question": "Critique this plan for <task>. What is wrong, missing, risky, or more complex than needed? Plan:\n<plan text>" }`.

Either way, the critique is a list of candidates. Check each against the code; adopt what holds, and note what you rejected and why. Then show the user the plan (intent, cards, checks, and what the critique changed) and wait for approval, unless `--auto`.

## 4. Build

**Fast:** build card by card in this session.

- A card is done when its command passes, not when the code looks right.
- New or changed tests follow the `writing-specs` skill.
- Run narrow checks for each card; cache long output in `tmp/test-cache/` with a state-specific name.
- When a fix does nothing, check in order: the test itself, whether the new code actually ran (restart, cache, stale build), then the product.
- Two failed attempts at one idea: drop it and change approach.

**Thorough:**

1. Confirm `git rev-parse HEAD` still prints `BASE`. If HEAD moved since planning, re-check the plan against the new HEAD, record the new `BASE`, and say so.
2. Run the build workflow, `build-workflow.js` in this skill's folder, as described under **Hosts**, with args `{ "task": "<intent>", "plan": "<plan text>", "checks": ["<cmd>", ...], "baseSha": "<BASE>" }`.

3. It returns `{ winner, runnerUp, decidedBy, graft[], judges[], missing[] }`, or `{ error }` for bad input (report it and stop). Note the Run ID (`wf_...`).
   `decidedBy` is `checks` (only one candidate passed every check), `judges` (majority vote), `only-candidate`, `fallback` (no judge majority; X by roster order, not a judged winner), or `none` (no usable candidate).
4. With a winner, bring its change into the user's checkout as staged, uncommitted changes. Builders stage their work and never commit (a commit hook may forbid it), so the change is the winner worktree's staged diff. Run from the repository root:

   ```bash
   (cd '<winner.worktreePath>' && git diff --cached --binary <BASE>) | git apply --3way
   ```

   Inside the quotes, write any single quote in the path as `'\''`.

   Then check each `graft` item against the code and apply the ones that hold. With no winner, report `missing` and offer fast mode.
5. Clean up this run's worktrees with [cleanup-worktrees.sh](cleanup-worktrees.sh), run from inside the repository. It finds them from git (branches named `worktree-<Run ID>-<n>`), not from builder reports, so a builder that crashed is not missed. It touches no other worktree, and removes `.claude/worktrees` only when that leaves it empty.
   - **After a winner is applied:** `bash <this skill's folder>/cleanup-worktrees.sh <Run ID>`.
   - **With no winner:** a failed builder may hold partial work. Show the user `bash <this skill's folder>/cleanup-worktrees.sh <Run ID> --list` and run the removal only when the user agrees.

## 5. Verify

Run all three; none replaces another.

1. **Checks:** every final check command, from the repository root. Keep the output.
2. **Real product:** run the app, CLI or job on the core path of the change and keep the output. If that is impossible here, mark the change "not verified in the real product" and say why.
3. **Review:** run the `general-review` skill on the uncommitted work, with the plan's intent as the review intent. Its second-opinion lens must be the other model; a builder never reviews its own work.

## 6. Fix loop

Fix every introduced blocker, high and medium finding, re-run the affected checks, then recheck with `general-review` (its ledger rechecks only what changed). Stop after **3 review rounds**: if the verdict is still not PASS, stop and report the open findings instead of looping. These fixes happen in the flow without asking the user. Introduced lows and pre-existing findings go to the user; do not fix them unasked.

## 7. Report

Use [the report template](references/report-template.md). Lead with the outcome. Every claim names its evidence (command and result). List anything skipped, unverified, or missing (Codex down, a builder failed, judges split). Once checks and review pass, commit the change (the first commit, or `git commit --amend` onto the one unpushed commit, per rule 54); never push. Builders still only stage. Delete `$WC_TMP` at the end.

## Red flags: stop and go back a step

- Writing code with no card and no pass/fail command.
- "Works" with no command output behind it.
- PASS with no `general-review` run in this session.
- A third attempt at the same idea.
- Treating a critique, judge vote, or Codex claim as fact without checking the code.
