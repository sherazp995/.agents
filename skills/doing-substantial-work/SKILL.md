---
name: doing-substantial-work
description: The default workflow for building any feature or fix, and the single entry point that escalates risky work (schema, auth, payments, unclear design) to work-council. Use when a task changes more than one file or adds behaviour, builds a new tool, refactors, or chases a bug that survived a fix; also when the user says "make it solid", "do it right", "don't cut corners", "one-shot it", or pushes a deadline on non-trivial work. Not for one-line fixes, questions, or read-only exploration.
---

# Doing substantial work

Quality comes from the process around the model, not the model alone: a plan, a pass/fail check for every piece, proof in the real product, and an independent review. **Deadlines and pressure cut scope. They never cut these steps.**

**If the user explicitly tells you to skip a step,** skip it and list it in the report as "skipped at your request". Their instruction wins; urgency or "keep it quick" is not such an instruction.

## Who does what: the session coordinates, subagents build

The chat session keeps the plan, the checklist and short results; subagents do the heavy work (Claude Code: the Agent tool; pick the specialist from `AGENTS-DISPATCH.md`, else `general-purpose`).

**Pick the cheapest route that keeps quality.** Every agent pays 30k to 90k tokens of startup context before it works, so match the route to the size:

| Work | Route |
|---|---|
| A few known edits, about 1 to 3 files | Inline in the session, then the step 6 review and the step 8 commit |
| One medium task whose reads would clutter the chat | One subagent |
| Three or more cards | The build workflow below, in dependency waves |

Independent cards finish faster in waves than one at a time. Review once at the end of a build, not after every wave.

- **Search and probes:** `Explore`; keep only its conclusions.
- **Steps 3 to 6 run as one workflow:** [build-workflow.js](build-workflow.js) in this skill's directory. Only a short summary returns to the chat.
  - **Build:** a builder agent works each card; a separate agent reruns the card's command (the builder never grades itself), with one retry. A builder that reports `not_done` (missing or blocked card work) leaves its card `incomplete`; decisions and caveats go in `notes` and keep it `passed`. Cards run in dependency waves: every card whose `after` cards passed builds at once; the whole wave builds before its commands are rechecked one at a time, so no recheck sees another builder's half-finished edits. A card waiting on a failed card is skipped. Before the proof every passed card's command runs once more, so a card broken by a later card shows as `regressed`. A dependency cycle is rejected before any agent starts.
  - **Prove:** after every card passes, a proof agent runs the real product.
  - **Review and fix:** a fresh lead runs `general-review` in single mode, read-only, with the diff-only lens as a sibling agent. A fixer fixes the introduced blocker, high and medium findings, every card command is rechecked, and the next round reviews the fix. Rounds follow the review tier: small (3 files or fewer) 2 rounds, one fix and a recheck of the fix diff; normal and risky 3 rounds. A lead that reports `INCOMPLETE` never counts as done. Pass `risky: true` when the plan names an escalation category.
  - **Cost per stage:** builder `card.model` or the session's model; checker, snapshot and diff shell agents haiku, low effort; proof sonnet, medium; review lead the session's model, high; diff-only lens sonnet, low; fixer the session's model. The review tier (`tier`, or `risky: true`) sets the rounds: small 2, normal and risky 3.

  ```
  Workflow({ scriptPath: "<this skill's directory>/build-workflow.js",
    args: { repo: "<absolute repo path>", plan: "<plan text>", intent: "<the user's requirements, optional>",
      cards: [{ id: "c1", title: "...", files: ["..."], command: "<pass/fail command>", after: ["<card ids it needs, optional>"],
        agentType: "<specialist, optional>", model: "<optional, e.g. sonnet for mechanical cards>" }],
      proof: { instructions: "<core path to run and what to capture; or follow the video-qa / branch-visual-qa runner>" },
      review: true } })
  ```

  Cards in the same wave must not share a file: give a card `after` on any card that edits its files. Set `sequential: true` only when every card depends on the one before it. Pass `base: "<commit>"` to review everything since that commit, for example when resuming work that is already in the tree. Set `review: false` only when the user asked to skip the review. The result is `{ status, cards[], skipped[], proof, review }`; tick each card whose status is `passed`. `done` is computed, never read from the verdict text: every card passed, the proof passed (including its rerun after a fix round that changed files), and the review left no introduced blocker, high or medium finding with every lens its tier requires in `lenses_run`. `review` holds `passed`, `tier`, the verdict, each round, the findings still open, `lenses_run`, a `note` when it stopped early, and `files`, the net change since the snapshot (a rename lists both paths). On `done` the session commits (step 8). Treat `needs-attention` as step 4, and report open findings to the user. Codex and other hosts run the same script through `workflow-runner`.
- **Stays in the session:** decisions, questions to the user, and escalation to `work-council`.


## Escalate risky work to work-council

This skill is the one entry point for building. Decide at step 2, once the plan exists, and write the decision in the plan as `Escalation: none` or `Escalation: work-council, because <reason>`.

Escalate when the change:

- alters a database schema, runs a migration or backfills data;
- touches authentication, authorization, sessions or permissions;
- touches payments, billing or money amounts;
- still has an `[unknown]` that changes the design, or two plausible designs after probing.

To escalate, hand the plan and its final check commands to the `work-council` skill. It runs the plan gate critique and the best-of-two build in place of steps 3 and 4 here, brings the winner into the checkout, then hands back: steps 5 to 8 (proof, review, lessons, commit and report) still run here. If `codex` is not on PATH, work-council cannot build a second candidate: do not escalate, carry on here, and report "escalation skipped: Codex not installed". When the user asks for the work council by name, escalate regardless of the categories above.

## The workflow

1. **Load context.** Project `CLAUDE.md`/`AGENTS.md`, then `agents-hub memory show` and `agents-hub search <topic>` for earlier attempts.
2. **Plan before code.** Write it (scratchpad unless the user wants it elsewhere):
   - intent in one line: restate what the user asked for, and ask about anything that would change the design;
   - when more than one approach is plausible, name 2 or 3 with their tradeoffs and recommend one;
   - unknowns that would change the design, each settled by a quick probe and tagged `[measured]`, `[inferred]` or `[unknown]`;
   - cards: about five files each, each with **one command that passes or fails**.

   Put every card in the agent's task list (Claude Code: its todo or task tool) so the user sees the checklist, and tick each one only when its command passes. If the agent has no task tool, keep the checklist as `- [ ]` lines in the plan.

   No `general-review` pass on the plan: the user's approval is the gate. Only when the plan names an escalation category (the risky tier) does one cheap plan critic (a sonnet agent, low effort) read it first and list design gaps; fold its points in before showing the plan. The end review (step 6) still runs.

   **The user approves the plan.** Show it and wait. After approval, steps 3 to 6 run without check-ins, fixing review findings in the flow, unless something changes the plan.

   When the plan says `Escalation: work-council`, skip the plan critic and this pause: work-council's plan gate critiques the plan and holds the one approval pause (which `--auto` skips). If escalation then does not happen (Codex not installed, or the user declines work-council's clean-checkout request), change the plan to `Escalation: none`, then run the critic and this pause here.
3. **Card by card.** A card is done when its command passes, not when the code looks right. Tests follow `writing-specs`; run narrow and cache output (rules 41, 42). Parallel cards go to specialists per `AGENTS-DISPATCH.md`.
4. **When a fix does nothing,** reproduce the failure first and read the full error. Check in order: the test itself, then whether the new code actually ran (restart, stale payload, cache), then the product. Trace the failing value back to where it first goes wrong, and compare with a path that works. Test one hypothesis at a time with the smallest change. Fix the broken invariant, not the one symptom. Two failed tries on one idea: drop it. Context full of dead ends: write a handoff (`agents-hub handoff` or a prompt file) and continue fresh.
5. **Prove it in the real product.** After a work-council build (winner and grafts applied), first run every final check command from the repository root on the checkout and keep the output; fix any failure before the proof, and rerun the affected checks after review fixes in step 6. Run the app, CLI or job on the core path and keep the output (`run`, `branch-visual-qa` for UI). Can't drive it? Make it drivable, or report it as unverified.
6. **Review with `general-review`** (rule 44) at the tier its "Review tiers" table sets: small runs no Codex or structural lens and 2 rounds; normal and risky add them (Codex when installed) and allow up to 3 rounds. The workflow's review loop does this; working inline, start the review yourself and pass that tier. Fix every introduced blocker, high and medium, then re-review within the tier's rounds; still not PASS, report the open findings. A specialist who helped build it is not the review.
7. **Record lessons** the moment they appear: `agents-hub memory add --type feedback|project` (Claude: its memory). A correction given twice: offer the `learn` skill.
8. **Commit, then report.** When the workflow returns `done`, or the inline route passes its step 6 review, the session stages only this work's files, `git add -A -- <files>` (scoped, so deletions are staged too) (the workflow's `review.files`, or on the inline route the files it edited), then commits: `git commit -m "<one line>"` (rule 48). Never an unscoped `git add -A`, `git add .` or `git commit -a`: the checkout can hold other uncommitted work. If git-guard denies it because the branch already has an unpushed commit (rule 54), rerun it with `--amend` as the deny message says, but only when that commit (the deny names its subject) is part of this work; otherwise do not amend and report that the branch already holds unrelated work. Never push unless the user says so.

   **Report** answer first (rules 45 to 48). Each claim names its evidence: command and result. List anything unverified or skipped. Never say done on an unverified result, and never end on a promise you could act on now.
