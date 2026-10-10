---
name: llm-council
description: Convene a 5-member mixed-model council (Claude and Codex) for a hard question about the current repository, through independent deliberation, anonymized peer review, and chairman synthesis. It picks one of two rosters from the question, an engineering council (3 Claude, 2 Codex) for code and architecture tradeoffs or a design council (3 Codex, 2 Claude) for UI/UX decisions such as layout, flow, components, copy, or accessibility. Use when the user invokes /llm-council, mentions "the LLM council", "the design council", "the engineering council", or "llm-council", or explicitly asks for several independent perspectives on a genuinely ambiguous decision. Not for questions a single agent can answer, trivial styling tweaks, or checking that something renders correctly. Token-heavy (about 11 agents). Runs in Claude Code (Workflow tool) and in Codex (the sibling workflow-runner); both give the same council and result.
allowed-tools: Workflow, Read, Grep, Glob, Bash
argument-hint: "<question to put to the council>"
---

# LLM Council

A Claude Code port of Andrej Karpathy's `llm-council` (https://github.com/karpathy/llm-council).
The council concept and its three-stage protocol are his; present this as an adaptation.

Five members, each with a distinct lens, grounded in the repository in the current working directory.

Protocol:

1. **Deliberate**: each member answers the question independently.
2. **Peer review**: one `sonnet` reviewer per member ranks every answer, anonymized as "Response A, B, C…", to curb
   self-preference bias. Only complete rankings (every label once, ranks 1..n once) count toward
   the mean-rank leaderboard.
3. **Synthesis**: an `opus` chairman writes the final answer from the answers and rankings
   (a design-lead chairman for the design council, resolving tradeoffs such as aesthetics
   against accessibility).

## The two councils

| Council | When | Members |
|---|---|---|
| `engineering` | Code, architecture, data, APIs, tooling, process, anything not UI/UX | Claude `opus` first-principles architect, Claude `sonnet` pragmatic shipping engineer, Claude `haiku` simplicity advocate, Codex red-teamer, Codex conventions steward |
| `design` | UI/UX: layout, visual hierarchy, flow, navigation, component choice, copy, accessibility | Codex visual hierarchy, Codex microcopy, Codex design system, Claude `opus` interaction and information architecture, Claude `sonnet` accessibility |

Codex members run `gpt-6-astra`. Codex gets the design council's visual seats because GPT-6 Astra
leads the visual-design leaderboards (Design Arena UI Components, Arena Image-to-WebDev) by
margins inside their error bars, while Claude leads Arena WebDev (working apps) and keeps the
functional seats.

**Choosing the council:**

- If the user names one ("design council", "engineering council"), use it.
- Otherwise pick `design` when the question is mainly about how an interface looks, reads, or
  is used, and `engineering` for everything else, including a component's code structure, state,
  or API.
- For a question that is genuinely both, pick the side the user's decision turns on, and say in
  one line which council you chose and that they can rerun with the other.

## Design council: members cannot see pixels

The members are text agents. For a design question, make sure the question gives them the
design in a readable form, or points at files:

- the component code and its styles,
- an HTML mockup file, or
- a written description of the layout and flow.

The council argues the design tradeoff. It does not confirm what actually renders; for that,
take real screenshots in a browser.

## How to run it

The same `council-workflow.js` runs on both hosts. In Claude Code, use the Workflow tool. In Codex
or another agent without it, use the sibling `workflow-runner` skill's `run-workflow.mjs`, which
gives the script the same hooks (see its SKILL.md for the one-time Codex setup). Never imitate the
council by hand.

1. Take the question from the skill arguments. If it is empty, ask for one before proceeding.
2. Choose the council as described above.
3. Invoke the workflow. The script is `council-workflow.js` inside this skill's base directory
   (shown when the skill loads). Pass absolute paths with `~` expanded.

   **Claude Code:**

   ```
   Workflow({
     scriptPath: "<this skill's base directory>/council-workflow.js",
     args: { question: "<the user's question, verbatim>", council: "engineering" | "design" }
   })
   ```

   **Codex or any other host**, from inside the repository, with the longest command timeout the host
   allows (each agent may take up to 30 minutes, and the three phases run one after another; if the
   host's limit is shorter, run it in the background and wait for it):

   ```bash
   node <skills folder>/workflow-runner/run-workflow.mjs <this skill's base directory>/council-workflow.js \
     --args '{"question": "<the question>", "council": "engineering"}'
   ```

   It prints `{ "runId": ..., "result": ... }`; `result` is the object described in step 4.
   Put the question in a JSON file and pass `--args @<file>` when it contains quotes.

   Invoking this skill is the explicit opt-in for the Workflow tool or the runner. It fans out about 11
   subagents (5 deliberate, 5 review, 1 chairman), plus the Codex CLI runs. That is intended;
   do not downscale it.

4. The workflow returns (the runner's `result`)
   `{ question, council, final, synthesisSkipped, synthesisFailed, ranked, leaderboard[], members[], reviews[], missingMembers[], droppedReviews[] }`,
   or `{ error: "missing_question" | "unknown_council" }` when the input is invalid
   (`unknown_council` also covers a missing `council`, which is required). On an `error`,
   report it and stop.

## How to present results

Start with one line naming the council that ran. Then render two parts, in this order:

1. **Final answer**: print `final` as the headline response, labelled honestly:
   - normally it is the chairman's synthesis;
   - if `synthesisSkipped` is true, fewer than two members answered, so `final` is one member's
     answer (or a failure note) with no review or synthesis;
   - if `synthesisFailed` is true, the chairman failed; `final` is the top-ranked answer when
     `ranked` is true (if the top spot is tied, the first tied answer in roster order), or the
     first answer in roster order (not a winner) when `ranked` is false.
2. **Council transcript**, collapsible, below the final answer:
   - the **leaderboard** as a small table: rank, response label, member lens, model, mean rank,
     first-place votes, votes, and a tie marker. `meanRank` is null when no review counted;
     when `ranked` is false, say the order is roster order, not a ranking;
   - each **member's answer** under its label (`A`, `B`, …) with its lens and model;
   - the **per-reviewer rankings** (reviewer, ordered labels, one-line reasons);
   - any **missing members** or **dropped reviews**, so a partial council never reads as a full one.

   Wrap the transcript in `<details><summary>Council transcript</summary> … </details>`
   so the final answer stays front and center.

## Notes

- Read and advise only: members may read files but must not edit code. Claude members,
  reviewers, and the chairman run as the read-only `Plan` agent type (no Edit or Write tools);
  Codex runs in a read-only sandbox. Bash stays available to Claude members, so the prompt
  still forbids state-changing commands. Implementing the recommendation is a separate step
  the user asks for.
- Treat the chairman's answer as a strong recommendation, not proof. Before acting on a
  specific code claim, check the cited file yourself.
- The chairman and every peer reviewer run on Claude, because the workflow needs Claude for
  the structured ranking and the synthesis. Keep that possible bias in mind when Claude
  members top the leaderboard.
- Codex members: a thin Claude relay runs `codex exec` with a read-only sandbox, approvals
  off, and the Codex user config and exec-policy allow rules ignored, then returns Codex's
  answer verbatim. The relay keeps its temporary files only while Codex runs: the prompt copy
  and log are deleted as soon as Codex returns, and the answer right after it is read. They need the `codex` CLI installed and signed in. Each run is capped by
  the 600-second Bash timeout. If a Codex run fails, times out, or returns nothing, that member
  is excluded and listed in `missingMembers`, and the council continues with the rest.
- The rosters, lenses, and models live in `COUNCILS` in `council-workflow.js`; the table above
  summarises them. Edit that file to retune members, providers (`claude` or `codex`), models,
  or each council's chairman (`chairmanModel`).
- Model and effort per stage live in `STAGE` in the same file: Claude members answer at effort
  medium, Codex relays run on haiku low, every peer reviewer is sonnet low, and the chairman is
  opus high. Cost is an estimate (about 11 agents); re-measure once Codex is installed.
- With fewer than two answers, the workflow returns the single answer (or a failure note)
  and skips review and synthesis.
