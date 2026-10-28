---
name: work-council
description: "A by-name option of doing-substantial-work where Claude and Codex work as one team: they plan together with rethink (one writes the plan, the other gives its opinion on the direction and the draft, and they agree on it), split the build into parts that each model owns, build them at the same time in the user's checkout, review each other's parts, and finish only when every check passes and both approve the whole change. Disagreement after three fix rounds goes to the user. Then it hands back to doing-substantial-work for proof and commit. Works the same in Claude Code and Codex. Use only when the user invokes /work-council, asks for \"the work council\", \"Claude and Codex together\", \"build it as a team\" or \"combined work\", or accepts doing-substantial-work's offer of it for a risky plan. Not for one-line fixes, questions, or read-only review (use general-review or llm-council for those)."
argument-hint: "<task> [--auto]"
---

# Work council

Claude and Codex work as one team, not against each other. They agree on one plan, each builds the parts it owns, each reviews the other's work, and nothing is done until both say so.

It runs only by name (`/work-council <task>`) or when the user accepts `doing-substantial-work`'s offer for a risky plan. Context, proof, review and commit belong to `doing-substantial-work`, which takes control back after section 5.

**Only these skills are used, all siblings in this skills folder:** `doing-substantial-work`, `rethink`, and `workflow-runner` when the host has no Workflow tool.

## Hosts

The build runs [build-workflow.js](build-workflow.js) through Claude Code's Workflow tool there, and through the sibling `workflow-runner` skill's `run-workflow.mjs` in Codex or any other host; same script, same result. Never imitate the workflow by hand. Missing or failing CLIs: the run stops and says so; it never hands Codex's parts to Claude.

To run it with args:

- **Claude Code:** `Workflow({ scriptPath: "<absolute script path>", args: <args> })`. The Run ID is printed with the launch.
- **Codex or another host:** from inside the repository, with the longest command timeout the host allows (if it is shorter than the run, run it in the background and wait as [host-lifecycle.md](../workflow-runner/references/host-lifecycle.md) says), `node <skills folder>/workflow-runner/run-workflow.mjs <absolute script path> --args @<args.json>` (write args to a JSON file in `WC_TMP`). Its output is `{ "runId", "result" }`.

Codex builds through a relay (AGENTS.md delegation exception 6) that runs `codex exec --sandbox workspace-write` in the checkout, and reviews read-only. A permission mode (such as auto mode) may deny the write-enabled command. Then the run ends `blocked`; never work around a denial. Tell the user, who can approve that command or add a permission rule for it and rerun.

Estimated cost: one agent per part to build, one review per part per round, a checks runner, and two sign-offs per round; Codex calls go through cheap haiku relays. Model and effort per agent are in the script's header table.

## 1. Protect the checkout

1. Both models build in the user's checkout, so it must start clean. If `git status --porcelain` prints anything, ask the user to commit or stash it, or to carry on in `doing-substantial-work` instead. Never discard or overwrite the user's work.
2. Record `BASE=$(git rev-parse HEAD)`. Every diff in the run is read against it.
3. Make a run folder outside the repository with `mktemp -d` and call its path `WC_TMP`. Prompts, args and logs go there, never in the checkout.

Shell variables may not survive between commands, so write the literal `BASE` sha and `WC_TMP` path into later commands.

## 2. Plan together

Plan with `rethink`: one model writes the plan and the other gives its opinion on the direction and on the draft, until the plan is `agreed`. A plan `doing-substantial-work` already made with `rethink` and `agreed` is used as it is.

The plan must also say who builds what. Ask for it in the rethink request: split the work into 1 to 6 parts, each with an owner (`claude` or `codex`), the files it owns (repository-relative paths to single files: no directories, globs or `..`), and a one-line brief; no file belongs to two parts. Give each model the parts that suit it, and balance the load. Shared files (schema, migrations, routes, lockfiles, locale files) go in one part. When the work does not split cleanly, it is one part: one model builds it and the other reviews it.

Show the user the plan (intent, steps, parts and owners, checks, the rethink status) and wait for approval, unless `--auto` (or "don't wait for me"). This approval replaces the one in `doing-substantial-work` step 2. A plan that is not `agreed` is built here only after the user settles each open point. For an unattended build of a plan the user already approved, use `autonomous` instead.

## 3. Build as a team

1. Confirm `git rev-parse HEAD` still prints `BASE` and the checkout is still clean. If not, stop and say so.
2. Run the workflow as described under **Hosts**, with args `{ "task": "<intent>", "plan": "<plan text>", "parts": [{ "id": "<a-z0-9->", "owner": "claude|codex", "files": ["<path>", ...], "brief": "<one line>" }, ...], "checks": ["<cmd>", ...], "baseSha": "<BASE>" }`.
   If the repository root holds `.work-council.json` with `"codexNetwork": true`, add `"codexNetwork": true` to the args, so the Codex sandbox can reach local services such as Postgres. Without it the sandbox stays offline.
3. What it does:
   - **Build:** each owner builds its parts at the same time, editing only its own files.
   - **Review:** in rounds. The other model reviews each open part's diff, and only when every review of the round is in do the fixes run, so nobody reads the checkout while a teammate edits it. Each finding goes to the part that owns its file, and a reviewer reads its author's latest notes (the build's notes in the first round). A part is reviewed again when it asked for changes or its files changed. At most 3 fix rounds.
   - **Sign-off:** every check command must pass (failures go back to the authors, at most 3 rounds). Then Claude and Codex each read the whole change, plus the last round's findings and the authors' replies; findings go to the part that owns the file, at most 3 rounds.
4. It returns `{ status, parts[], checks[], signoffs[], reason }`, or `{ error }` for bad input (report it and stop). Note the Run ID (`wf_...`).
   `status` is `agreed` (every check passed and both approved), `not_agreed` (they still disagree after 3 rounds, or a finding is in a file no part owns), `checks_failed`, or `blocked` (a build, review, fix or sign-off did not run or did not finish: Codex denied or down, a Codex answer without exit 0, or an author reporting `done: false`).

## 4. Check it yourself

Only `agreed` goes on. Run every check command in the checkout yourself: an agent's reported exit codes are not proof. If one fails, report which and stop.

For `not_agreed`, show the user both sides plainly: each open finding, who raised it, and the author's reply from its notes, and ask how to settle it. For `checks_failed` or `blocked`, report the reason and the parts' state. The partial work stays in the checkout, uncommitted; never discard it without the user's say.

## 5. Hand back

Delete `$WC_TMP`, then return to `doing-substantial-work` step 6 (Prove it), then its steps 7 and 8 (the checks already ran in section 4). Its report adds: who built which part, the review rounds per part and what changed in them, and anything missing (Codex down, a part blocked).

## Red flags: stop and go back a step

- Building with a dirty checkout, a `BASE` that no longer matches HEAD, or a plan only one model approved.
- Handing a blocked Codex part to Claude, or the other way round.
- Treating an agent's or Codex's claim as fact without checking the code.
- Discarding partial work after a run that did not end `agreed`.
