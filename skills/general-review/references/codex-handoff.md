# Codex second opinion

Every general review gets an independent review from Codex on `gpt-6-astra`. Start it once the scope is frozen, run it in the background, and keep reviewing while it runs.

**When the host is Codex,** the second opinion must come from the other model, Claude. The host is the RUNNER that runs SKILL.md as coordinator or review lead; a second-opinion reviewer started from this file is never the host and never runs this step. Use the same prompt below and ask Claude through the sibling `workflow-runner` skill's `second-opinion.js` workflow, which runs one read-only Claude agent. On this machine a Codex allow rule (`~/.codex/rules/default.rules`) runs the runner outside the sandbox, where Claude can read its login. Run these as three separate commands, from inside the repository, with absolute paths:

```bash
node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[2], JSON.stringify({ prompt: fs.readFileSync(process.argv[1], "utf8") }))' "$REVIEW_TMP/codex-review-<short-tag>.prompt" "$REVIEW_TMP/codex-review-<short-tag>.args.json"
node <skills folder>/workflow-runner/run-workflow.mjs <skills folder>/workflow-runner/second-opinion.js --args @<REVIEW_TMP>/codex-review-<short-tag>.args.json --out <REVIEW_TMP>/codex-review-<short-tag>.json
node -e 'const r = require(process.argv[1]).result; if (!r.text) { console.error(r.error); process.exit(1) } require("fs").writeFileSync(process.argv[2], r.text)' "$REVIEW_TMP/codex-review-<short-tag>.json" "$REVIEW_TMP/codex-review-<short-tag>.log"
```

Keep the runner command exactly in that form: no `timeout`, subshell, pipe, redirect or `&` around it, so the allow rule matches. Give it the longest timeout the host allows and stop waiting after 30 minutes (then treat it as a timeout). In PR batch mode with a Codex host, run the same commands from `{WORKDIR}/wt` (prompt `{WORKDIR}/codex.prompt.md`, output `{WORKDIR}/codex-review.md`) as the senior-engineer reviewer.

If the runner fails, or the result has an `error`, record the missing second opinion as a limitation. Without the allow rule, Codex has to run the runner as an approved escalated command.

Everything else in this file (candidates only, re-proof, recording the command and exit status) applies unchanged; record the model as Claude.

When an authorized orchestration tool can dispatch an independent `gpt-6-astra` reviewer directly, that is an alternative to the CLI below, not an additional mandatory duplicate. Give it the same read-only handoff and record its model, scope, and result. For large coordinated reviews it may own a distinct workflow initially, followed by a focused challenge of cross-partition findings and repairs. The lead still reconciles coverage and independently re-proves its findings. A CLI initialization failure does not require another identical attempt when this alternative is available.

## Command

This is the only place the Codex command is defined; PR batch leads use the batch variant below. Fill in `<short-tag>` (commit short SHA or a description, new per code state) and replace `<prompt below>` with the completed prompt. Keep the heredoc delimiter quoted so the prompt stays literal. Codex files go in `REVIEW_TMP` (see `ledger.md`), never in the reviewed checkout, so they cannot change the ledger STATE.

**Single review** (read-only, run from inside the repository; outside Git use a temporary directory and add `--skip-git-repo-check`):

```bash
mkdir -p "$REVIEW_TMP"
cat > "$REVIEW_TMP/codex-review-<short-tag>.prompt" <<'CODEX_REVIEW_PROMPT'
<prompt below>
CODEX_REVIEW_PROMPT
timeout 1800 codex exec -m gpt-6-astra --sandbox read-only --ephemeral --color never -c 'model_reasoning_effort="high"' -c 'mcp_servers={}' - \
  < "$REVIEW_TMP/codex-review-<short-tag>.prompt" \
  > "$REVIEW_TMP/codex-review-<short-tag>.log" 2>&1
```

**PR batch** (inside the lead's throwaway merged worktree, writable so Codex can run tests there; the prompt is the lead's `codex.prompt.md`):

```bash
cd {WORKDIR}/wt && { [ -f {WORKDIR}/ruby-env.sh ] && source {WORKDIR}/ruby-env.sh; true; } && timeout 1800 codex exec -C {WORKDIR}/wt -m gpt-6-astra -s workspace-write --ephemeral --color never \
  -c 'model_reasoning_effort="high"' -c 'mcp_servers={}' -c 'shell_environment_policy.inherit="all"' \
  -o {WORKDIR}/codex-review.md - < {WORKDIR}/codex.prompt.md > {WORKDIR}/codex.log 2>&1
```

If `timeout` is not installed, use `gtimeout`; if neither exists, run without it and stop waiting after 30 minutes.

**Fallback, both variants:** if the model is rejected, rerun once with `-m gpt-5.6-sol` and say so in the report. In every other failure (Codex missing, an error, a timeout, empty output), or when the fallback model also fails, do not retry: record the command, exit status and log path as a limitation and continue. In PR batch mode the lead then starts one fresh `general-purpose` agent with the same prompt as the senior-engineer reviewer, and the report says so.

Record the exit status of every run.

## Prompt

```text
Review this change like a senior engineer under the Unified Review Protocol (~/.agents/AGENTS.md rule 44). Run every phase and emit the report template from ~/.agents/skills/general-review/SKILL.md section 6, which is rule 44's template plus the root-cause, fix and verify fields asked for below.
TARGET: <repository or file roots>; mode <branch/PR | staged-only | combined working tree | current-state>; in-scope paths <paths>; baseline <P0 revision or supplied baseline, or none>; target <P0 head revision, index/working-tree snapshot, or selected current files with recorded hashes>.
Use the scope recorded in P0 for every diff, source read, caller search, line count, blame and check. Read ~/.agents/skills/general-review/references/review-checklist.md section 2 for the mode-specific readers. For branch/PR reviews use the recorded merge base and head; for staged-only reviews use the recorded baseline and index, excluding unstaged changes; for combined working-tree reviews use the recorded baseline (normally HEAD), staged and unstaged changes, and relevant untracked files. For current-state assessments without a change baseline, inspect the selected files, classify findings as pre-existing, and report Verdict: N/A without PASS or LGTM. If the target changes during review, reconcile the delta before reporting.
INTENT: <what the change is for, acceptance criteria, and anything explicitly out of scope>.
Apply four lenses and merge them into one list: (1) senior engineer: correctness, regressions and blast radius (search every removed or renamed symbol, route, template and script), security, data, concurrency, performance, compatibility, tests; (2) structural: read ~/.agents/skills/general-review/references/structural-lens.md and apply its referenced standards using its exclusions and severity mapping; (3) simplicity and architecture: is this the simplest correct change in the right layer, what did it leave dead, did it delete anything still live; (4) project conventions from AGENTS.md and project instruction files.
For EVERY finding cite file:line in the recorded target state, quote the code, and PROVE it with the code, a command you ran, or a cited source. No proof, no finding. Give every finding a concrete fix (file, method, existing scope or helper to reuse) and a verify step (the focused spec or command and the cases it must cover, including the failing case and neighbours that must keep working). Tag severity (blocker|high|medium|low) and origin (introduced|pre-existing, via the actual baseline comparison and git blame where available; without a change baseline, use pre-existing). Keep pre-existing findings in their own section and do not block on them.
For every finding, name its root cause (the design choice or missing invariant that allows it, not the line), group findings with the same cause into families, and search the whole change for every other instance of each family's pattern, reporting each one as verified or unverified. For each family give the per-site patch and the structural fix with trade-offs.
For cross-layer changes or repeated review/fix cycles, follow ~/.agents/skills/general-review/references/review-closure.md: report workflow and boundary coverage, the owning invariant for each family, valid neighboring cases the repair must preserve, and exact remaining gaps. Keep existing P0/P1/P2 priorities unless new evidence justifies changing them; protocol gate terminology does not by itself establish urgency. In a coordinated review, report to the lead without spawning another review recursively. You are the second-opinion reviewer: do not run the second-opinion step in codex-handoff.md, and do not start any other model, agent or review.
Read-only: do not edit files, run the test suite, start servers, or make network writes.
```

## Using the result

Treat every Codex finding as a candidate. Re-prove it yourself before it enters the merged list (SKILL.md section 5), and log each one you discard with a reason. If Codex is missing, errors, or times out, record that in the verification log and continue with the other lenses.
