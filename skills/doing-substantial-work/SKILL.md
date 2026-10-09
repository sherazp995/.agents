---
name: doing-substantial-work
description: Use when a task changes more than one file or adds behaviour, builds a new tool, refactors, or chases a bug that survived a fix; also when the user says "make it solid", "do it right", "don't cut corners", "one-shot it", or pushes a deadline on non-trivial work. Not for one-line fixes, questions, or read-only exploration.
---

# Doing substantial work

Quality comes from the process around the model, not the model alone: a plan, a pass/fail check for every piece, proof in the real product, and an independent review. **Deadlines and pressure cut scope. They never cut these steps.**

**If the user explicitly tells you to skip a step,** skip it and list it in the report as "skipped at your request". Their instruction wins; urgency or "keep it quick" is not such an instruction.

## The workflow

1. **Load context.** Project `CLAUDE.md`/`AGENTS.md`, then `agents-hub memory show` and `agents-hub search <topic>` for earlier attempts.
2. **Plan before code.** Write it (scratchpad unless the user wants it elsewhere):
   - intent in one line;
   - unknowns that would change the design, each settled by a quick probe and tagged `[measured]`, `[inferred]` or `[unknown]`;
   - cards: about five files each, each with **one command that passes or fails**.

   Put every card in the agent's task list (Claude Code: its todo or task tool) so the user sees the checklist, and tick each one only when its command passes. If the agent has no task tool, keep the checklist as `- [ ]` lines in the plan.

   Run the plan through `general-review` before coding. If the user set a deadline, skip this plan review instead: send the plan in one message and start. The end review (step 6) still runs.
3. **Card by card.** A card is done when its command passes, not when the code looks right. Tests follow `writing-specs`; run narrow and cache output (rules 41, 42). Parallel cards go to specialists per `AGENTS-DISPATCH.md`.
4. **When a fix does nothing,** check in order: the test itself, then whether the new code actually ran (restart, stale payload, cache), then the product. Fix the broken invariant, not the one symptom. Two failed tries on one idea: drop it. Context full of dead ends: write a handoff (`agents-hub handoff` or a prompt file) and continue fresh.
5. **Prove it in the real product.** Run the app, CLI or job on the core path and keep the output (`run`, `branch-visual-qa` for UI). Can't drive it? Make it drivable, or report it as unverified.
6. **Review with `general-review`** (rule 44, Codex lens included). Fix every introduced blocker, high and medium, then re-review to PASS. A specialist who helped build it is not the review.
7. **Record lessons** the moment they appear: `agents-hub memory add --type feedback|project` (Claude: its memory). A correction given twice: offer the `learn` skill.
8. **Report** answer first (rules 45 to 48). Each claim names its evidence: command and result. List anything unverified or skipped. Never say done on an unverified result, and never end on a promise you could act on now.

## Rationalizations

| Thought | Reality |
|---|---|
| "Demo in an hour; a mental self-review is enough" | Run `general-review`. Cut scope, not the review. |
| "The spec passes; driving the app is impractical" | Then the report says "not verified in the real app". |
| "A plan would slow us down" | One message with the plan costs a minute. |
| "The specialist already reviewed it" | Builders don't gate their own work. |
| "Lessons can wait" | They are gone after the session. One command now. |

## Red flags: stop and go back a step

- Writing code with no card and no pass/fail command.
- "Self-review: PASS" with no `general-review` run.
- "Works" with no command output behind it.
- A third attempt at the same hypothesis.
