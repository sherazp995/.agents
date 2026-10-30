---
name: writing-plans
description: The one format for every implementation plan, written so the user or a junior developer can read it top to bottom and understand what changes, why, and what they must decide. Plain-language summary first, decisions for the user near the top, text-box flowcharts of how the flow works today and how it will work after the change, a Today/After table, a checklist of steps, tests in plain words, and technical proof (file:line, advisor opinions, commands) in an appendix. Use whenever a plan is written or rewritten: doing-substantial-work step 2, rethink drafts, planner subagents, plan mode, or when the user says a plan is unclear or hard to read.
---

# Writing plans

A plan is read by people before it is read by agents. The user, or a junior developer who has never seen the ticket, must be able to answer three questions from the first screen: what is wrong or missing, what will be different afterwards, and what do I need to decide. Proof for reviewers and builders goes lower down, in the appendix.

Write every plan to its plan file (`~/.agents/tmp/plans/`, or plan mode's own plans folder) and show the user its summary, decisions and path, never a plan only in chat. The `plan-guard` hook delivers this skill the first time a session writes a plan and sends back missing or out-of-order sections.

This skill sets the shape only. How a plan is made (interview, advisor opinions, approval, the plan file path) stays with `doing-substantial-work`, `rethink` and `interview-me`.

## The sections, in order

Copy [references/template.md](references/template.md). A filled example is in [references/example.md](references/example.md).

1. **Title and status lines.** `# <ticket>: <what changes, in plain words>`, then the ticket link, branch, plan file path, and a `Status:` line: `Waiting for your decisions`, `Waiting for approval`, `Approved <date>`, `Building`, `Done`. A plan made with `rethink` adds an `Advisor status:` line with its result (`agreed`, `open points` or `advisor unavailable`).
2. **`## In short`.** One paragraph, at most five sentences: what is broken or missing today, what we will do, who notices the difference. No file names, no class names.
3. **`## Decisions for you`.** Each open question as a short heading, then the options, our recommendation and what the build does if the plan is approved without a choice. `None` when there are none. Questions go here, never only in the appendix.
4. **`## How it works today`** and **`## How it will work`.** Text-box flowcharts (below). One chart per flow the ticket touches.
5. **`## What changes`.** A table with one row per behaviour: `| Area | Today | After | Why |`. Write what a user sees or what the system does, not what the code does.
6. **`## Confirmed intent`.** The six `interview-me` restate lines (Outcome, User, Why now, Success, Constraint, Out of scope), or one line saying the intent was fully stated.
7. **`## Steps`.** A checklist. Each step: one plain sentence, then `Files:` and `Done when:` lines. Steps are ordered so each one can be checked on its own. `Done when:` states the behaviour itself, never "the specs below": the approval stamp covers only Confirmed intent, Steps and Checks.
8. **`## Tests`.** One line per test in plain words ("an admin with no buildings of their own sees the company average"), with the spec file at the end of the line.
9. **`## Checks`.** The exact commands that prove the work, in a code block.
10. **`## Risks and not doing`.** Two short lists: what could go wrong and how we guard it; what is deliberately out of scope.
11. **`## Appendix`.** Everything the builder or reviewer needs as proof: `### Root cause` with `file:line`, `### Overlap with open PRs`, `### Request (verbatim)` with the ticket text and screenshots, and any separate ticket suggestions.
12. **Sections other skills own**, when they apply: `## Advisor opinions` and `## Review pre-check` (rethink), then `## Log` last.

Keep the headings `## Confirmed intent`, `## Steps`, `## Checks` and `## Log` exactly as written: other tools read those sections by name.

## Text-box flowcharts

Plain characters only, so a chart looks the same in the chat, a terminal, an editor and GitHub. Put each chart in a ```text block.

```text
( Start or end )          [ A step the user or system takes ]
< A question? >           --yes-->   arrows, labelled when they branch
```

- Draw the flow as the user experiences it: pages, buttons, what they see. Use the screen's own words ("Not enough data", "Filters"), not method names. When there is no user-facing flow (a job, an import, a refactor), draw the data flow the same way.
- Draw today's flow and the planned flow as two charts with the same starting box, so the reader can compare them line by line.
- Tag each box that differs. In the after chart: `NEW:` or `CHANGED:` at the start of the box text. In the today chart: `BUG:` on the box that goes wrong, `REMOVED:` on a box that will go away.
- Keep charts narrow (about 72 characters) and short (about 12 boxes). Split a longer flow into several charts, each with a one-line caption.
- Skip the charts only for a change with no flow at all (a copy fix, a config value). Say so in one line under the heading.

Example:

```text
TODAY
( Strata admin opens Dashboard )
              |
              v
< Has buildings of their own? >--no-->[ BUG: "Not enough data" ]
              | yes
              v
[ Health score from own buildings only ]

AFTER
( Strata admin opens Dashboard )
              |
              v
[ CHANGED: Health score from every company building ]
              |
              v
[ Average, highest and lowest shown ]
```

## Writing rules

- Plain words. Explain a term the first time it appears ("BIR, the building insurance request"). Use the names the user sees in the app.
- No `file:line`, class or method names above `## Steps`. Inside Steps, file paths only. Line numbers and code detail live in the appendix.
- Short sentences, one point per bullet, no dashes in prose (rule 45).
- Every claim in the appendix carries its proof: `path:line`, a command and its output, or a ticket quote.
- Recommendations are stated, not hedged: "We recommend X because Y."
- Nothing is called agreed, approved or verified unless it was.

## Showing the plan in chat

Show, in this order: the status line, `In short`, `Decisions for you`, both flowcharts, the `What changes` table, the steps one line each, and the plan file's full path. The rest stays in the file. When the plan is only a rewrite of an earlier one, say what changed in one line first.
