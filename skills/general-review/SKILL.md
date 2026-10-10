---
name: general-review
description: Review code changes, pull requests, branches, selected files, or an entire codebase in any repository and report one merged list of evidence-backed findings without applying fixes. Every review combines a senior-engineer pass, the thermo-nuclear structural lens, a simplicity and architecture lens, a Copilot-style diff-only blind pass, and an independent Codex (gpt-6-astra) review, and keeps a per-target review ledger so later runs recheck only what changed. It is the one review skill: copilot-review and thermo-nuclear-code-quality-review (/thermonuke) run one of its lenses on its own, and branch-visual-qa uses it as its review lane. Use when the user invokes general-review, asks to review or recheck one or more PRs or branches (by number, URL, or name, optionally with a base branch or a full-review request), asks to review a change like a senior engineer, or requests a general code review without naming another review skill. An explicit cohabit_pr_review request still runs that skill. Explicit code-review or security-review requests take precedence.
---

# General review

Review the requested scope, verify suspected defects, and report findings. This review phase ends at the report. During it, do not edit the reviewed checkout, apply fixes to it, create commits, publish comments, or open tickets. Suggested fixes are recommendations only. Two things are not edits of the reviewed code: PR batch mode proves findings and proposed fixes in throwaway worktrees that are removed afterwards, and every review writes only its temp folder, the test cache (rule 41), its own ledger record (creating the ledger folder and its `.origin` file on first use), and in PR batch mode its throwaway worktrees and private test databases, which it removes afterwards. Ledger cleanup deletes only this agent's records of finished work, and lists them instead while list-only mode is on.

A standalone review request does not authorize remediation. When an already-authorized implementation task calls this skill for self-review, return the findings to that task; the calling task then re-proves findings, resolves introduced blockers, fixes introduced high and medium findings, and re-reviews under rule 44. Ending this review phase does not end or revoke that implementation task. Introduced lows and pre-existing findings remain subject to the user's decision.

Use the shared `~/.agents/AGENTS.md` and applicable project instructions. Do not copy or modify global configuration. Adapt checks to the detected stack; do not assume Rails, JavaScript, or any particular framework.

Before reviewing code, read [the mandatory review checklist](references/review-checklist.md) in full. Execute its steps in order within the P0 through P6 phases below. Every review must account for every step and dimension. Scale investigation depth and report length to actual risk using the checklist's compact reporting option; do not silently skip checks because the diff is small. A checkpoint may be not applicable only with a concrete reason. No process guarantees finding every defect; report the evidence and coverage honestly.

For changes spanning multiple workflows or layers, or a user reporting repeated review/fix cycles, also read [bounded review and root-cause closure](references/review-closure.md). It adds workflow ownership, boundary checks, a consolidated repair handoff, and explicit completion criteria. Keep one frozen scope and one finding ledger throughout; do not turn each repaired symptom into a fresh unbounded audit.

## Modes and ledger

Pick the mode before P0:

| Mode | When | How |
| --- | --- | --- |
| Single review | Uncommitted work, selected files, a whole codebase, or one PR or branch. | One fresh lead agent runs sections 1 to 6 ([single lead](references/single-lead.md)); this session coordinates (see "Who reviews"). Findings are proven by reading code and running read-only checks. |
| PR batch | Two or more PRs or branches, or any PR or branch request with "batch", "prove with tests", "in parallel", or a repo profile in `profiles/` that the user asks to use. | [PR batch mode](references/pr-batch.md): one lead agent per target proves each finding with a throwaway test in an isolated worktree. Its leads use this file's severity, origin, root-cause and verdict rules. |

When the mode is unclear for a single PR or branch, use single review and mention that PR batch mode can prove findings with tests.

**Repo profiles.** A profile in `profiles/<REPO_SLUG>.md` holds what this skill cannot detect for one repository: its default base branches, test setup, proof spec folder, services to stub, stack hints and typical risks. Both modes read it in P0 when the repository's `origin` passes the profile's match check. A profile never changes the severity, origin or verdict rules. Without one, detect what you can and say so.

## Who reviews

The review is always done by an agent that did not write or discuss the change. The session that invokes this skill is the **coordinator**; it never judges the code itself. This holds for standalone requests and for self-review inside an implementation task (rule 44).

Coordinator steps for a single review (PR batch has its own in [PR batch mode](references/pr-batch.md)):

1. **Identity and scope.** Set RUNNER, RUN_ID, REPO and REVIEW_TMP ([ledger](references/ledger.md)). Freeze the target: its kind, base and head (fetch first for a PR or branch, as in section 1), or the manifest and STATE for uncommitted work or files. Write the manifest to `REVIEW_TMP/<KEY>/manifest.txt`.
2. **Ledger lookup.** Note READ_RUN_ID and pick review, recheck or "no changes". For "no changes", report it and stop; no lead starts. Otherwise write `REVIEW_TMP/<KEY>/earlier.md` as defined under EARLIER in the ledger file.
3. **Intent, requirements only.** Write the user's request in their words, the PR title and description, the ticket and acceptance criteria, and any plan requirements the user approved. Leave out this session's own explanations of how the code works or why it is correct, and its claims about what is fixed: the lead must judge those fresh.
4. **Start the lead.** One fresh `general-purpose` agent, not a fork (a fork inherits this conversation), with `references/single-lead.md` and every placeholder filled (`EARLIER_DIR` = `REVIEW_TMP/<KEY>`, `EARLIER` = its `earlier.md`, `INTENT` = the text from step 3, `LENS` = `all`, or the one lens of a single-lens run). Wait for it.
5. **Spot-check.** For each blocker or high finding, read only the cited lines. If the code does not support a claim, or a dropped finding looks real, ask the lead one question with SendMessage before relaying.
6. **Record and relay.** Corrections come only from the lead, which amends its own `REVIEW_TMP/<KEY>/record.md` after your step 5 question; you never change a status, severity or line. If you still disagree, add a `coordinator_note: <finding id> — <reason>` line and say so in the relay. Publish the record with `scripts/publish_record.py` (ledger "Locking"), run cleanup, then relay the lead's report as it is, one line per correction, and the final line. A lead that returns no record.md is reported "incomplete, not recorded".

**Fallback:** when the host has no agent tool, or the user explicitly asks for an inline review, run sections 1 to 6 in this session and start the report with "Not independent: reviewed by the session that requested it."

**Both modes keep a ledger.** Read [the review ledger](references/ledger.md) in P0, before any write. It sets the runner identity and run ID, the per-repo ledger location and lock, the record key for each kind of target, and whether this run is a first review, a recheck of new changes, or "no changes since the last review". `--full` or "full review" archives the record and starts fresh.

## Review lenses

Every review runs these five lenses over the same frozen scope, then merges them into one list (section 5). A small diff still runs all five, reported compactly.

| Lens | What it covers | Who runs it, model and effort | Source |
| --- | --- | --- | --- |
| Senior engineer | Correctness, regressions and blast radius, security, data, concurrency, performance, compatibility, tests. | Single: the lead (session model, effort high). Batch: Codex `gpt-6-astra`, reasoning high. | [Review checklist](references/review-checklist.md) steps 1 to 11. |
| Structural (thermo-nuclear) | Code-judo simplifications, spaghetti growth, files crossing 1000 lines, thin wrappers, casts and optionality, logic in the wrong layer. | Single: the lead. Batch: a fresh agent, sonnet, effort high. | [Structural lens](references/structural-lens.md), standards in [structural standards](references/structural-standards.md). |
| Simplicity and architecture | Whether this is the simplest correct change, in the right layer, reusing existing facilities; dead code the change leaves behind; over-deletion of live code. | Single: the lead. Batch: two fresh agents, sonnet, effort medium. | Section 2 and checklist steps 3 and 12; batch prompts in `references/lenses/`. |
| Diff-only blind pass | What GitHub Copilot posts on a PR: nil versus false, method visibility, error paths, layer consistency, accessibility, stale comments, config parsing, test gaps, hygiene. | Always a separate fresh agent that receives only the diff: sonnet, effort low. | [Diff-only lens](references/lenses/diff-only.md). |
| Codex second opinion | An independent review by the other model, run read-only and in parallel: Codex on `gpt-6-astra` when Claude hosts the review, Claude when Codex hosts it. | `gpt-6-astra`, reasoning high (Claude on the session model when Codex hosts). | [Codex handoff](references/codex-handoff.md). |

Pass the model and effort to each agent call when the host's agent tool accepts them; otherwise record the default used in the verification log. The diff-only agent gets the lens prompt with `{DIFF}` set to a file holding the frozen diff, and nothing else: no intent, no conversation, no other paths.

Start the Codex review and the diff-only agent as soon as the scope is frozen (end of P0) so they run while you review. Their findings are candidates, never results, until re-proven in P4.

### Single-lens runs

Two aliases run one lens on its own with the same scope, re-proof, severity, origin and report rules. The coordinator runs "Who reviews" steps 1, 3 and 4 only (no ledger lookup or record), and tells the lead which lens to run. For the diff-only lens the lead starts the diff-only agent and re-proves its list with full context; for the structural lens the lead applies it itself.

- `copilot-review`: only the diff-only blind pass, then the re-proof in section 5. When the user also asked for fixes, the session that invoked the alias then fixes the kept findings one at a time, smallest change first, and runs the narrow tests and linter. Without that request it reports only.
- `thermo-nuclear-code-quality-review` and `/thermonuke`: only the structural lens, reported in the section 6 template.

A single-lens run is not a full general review: its report starts with "Single-lens run: <lens>", omits the other lenses' coverage, and it writes no ledger record, so a later full review of the same state is not skipped as "no changes". It never issues PASS or LGTM; its verdict line reads `Verdict: <lens> only, <N> findings kept`.

## 1. Load context and establish scope (P0)

Read the task, acceptance criteria, and intended behavior before critiquing implementation. Infer clear intent from available context; ask for missing intent when it materially prevents a valid review. Record assumptions explicitly.

Determine the review target:

- Uncommitted work: inspect staged and unstaged diffs and relevant untracked files. Keep unrelated work outside scope. A review of staged changes only is its own kind (`staged`), with its own ledger key and state.
- Pull request or branch: identify the actual base branch and compare from the merge base using triple-dot diffs. Resolve the head with the steps below, then read the target with `git show <HEAD_SHA>:<path>`; never switch or update the user's checkout. Do not assume the base is `main` or that a local reference is current. Read the PR description when available.
- Selected files: establish whether the user wants a change review or an assessment of current code.
- Whole codebase: map architecture, entry points, trust boundaries, persistence, and important user flows. Review one flow at a time, prioritizing high-impact paths. Disclose coverage instead of implying exhaustive review.

**Resolve the head** (PR and branch targets, in both modes, before the ledger lookup):
1. Fetch: `git fetch origin <base> <head branch>` (or `pull/<n>/head` for a PR from a fork). If the fetch fails, say so and stop: no change verdict on a stale head.
2. BASE_SHA = `origin/<base>`; HEAD_SHA = the fetched head (for a PR, its `headRefOid`).
3. If a local branch with the head branch's name exists, differs from HEAD_SHA, and is **not** an ancestor of it (`git merge-base --is-ancestor <local> <HEAD_SHA>` fails: local is ahead, amended, squashed or rebased), ask the user which to review, showing both SHAs and whether local is ahead or diverged. A local branch that is merely behind needs no question. If they pick local, use its SHA as HEAD_SHA and label the target "local only, not pushed". Ask with AskUserQuestion when the host has it, otherwise in plain text.

The coordinator has already frozen KEY, STATE and MODE and written the earlier findings ("Who reviews"). In recheck mode, load those earlier findings into this review's finding list with their IDs; they must each get a status in P4.

Run Git inside the repository, without `git -C`. Read full touched files, relevant project conventions, and surrounding patterns. Use `rg` for targeted searches. Outside Git, use the provided diff or change description to establish origin. If change origin cannot be established, request the baseline before issuing a change verdict; useful current-state inspection may continue.

## 2. Understand the approach (P1)

Restate the intent and approach in one sentence. Decide whether the change belongs in this layer and solves the requested problem. Judge against that intent, not an imagined redesign. Check whether existing facilities already solve the problem.

Simplicity and architecture lens: ask whether a smaller change reaches the same outcome, whether each new piece lives in the layer that already owns the concept, and whether the change leaves code it made dead (methods, routes, policies, templates, scripts, styles, jobs) or deletes code that is still live. Recommend a simplification only when it preserves required behavior and stays inside the change's scope; note wider cleanup as pre-existing.

## 3. Review every dimension (P2)

Use steps 3 through 12 of [the mandatory review checklist](references/review-checklist.md) as the single source for dimension checks and regression tracing. Consider every dimension; mark genuinely irrelevant dimensions as not applicable with a reason. Do not invent findings to fill categories.

Apply the [structural lens](references/structural-lens.md) to every changed file as part of step 12. Its findings use the same severity and origin rules as every other finding; prefer a few high-conviction structural comments over cosmetic notes.

## 4. Classify findings (P3)

Assign both severity and origin to each finding:

| Severity | Meaning |
| --- | --- |
| blocker | Correctness failure, data loss, security hole, broken contract, missing hard requirement, or demonstrated regression. |
| high | Probable bug on a real path, race, hot-path N+1, or missing coverage for meaningful new logic. |
| medium | Concrete maintainability harm, structural weakness, or non-critical coverage gap. |
| low | Optional improvement; report only when useful, without padding style nits. |

Security findings default to at least high unless evidence establishes lower impact.

Keep a review gate separate from delivery urgency. When findings already have P0/P1/P2 priorities, preserve them unless new evidence justifies a change. Do not silently translate the protocol's word `high` into P1, or present a normal-priority issue as urgent merely because the gate requires a fix. State the triggering conditions and user impact when assigning or changing priority.

For change reviews, distinguish introduced from pre-existing issues. Use the diff and `git blame -w -M -C -C` on relevant lines, compared with the branch point; use `--ignore-rev` for known bulk formatting commits when useful. Uncommitted changed lines belong to the change. An old defective line made newly reachable by this change is an introduced regression. Trace the path to prove causation rather than relying solely on blame.

For a whole-codebase or current-file assessment without a proposed change, classify findings as pre-existing and state that no change verdict applies. Do not label an entire repository introduced.

## 5. Verify before reporting (P4)

Each finding needs an exact location, a short code quote, evidence, a concrete triggering condition, impact, a fix, and a way to verify that fix. Verify that surrounding guards or callers do not already handle the concern. A regression claim requires a traced caller or a failing test. Unsupported suspicion is an open question or limitation, not a finding.

Write the fix and verify steps so someone else can act on them without rereading the review:

- **fix:** the concrete change. Name the file and method, and the existing scope, helper, or pattern to reuse. Say what must stay unchanged when intent requires it (e.g. "keep administrative schedules flexible"). Not "handle this case" or "add validation".
- **verify:** how to prove the fix works. Name the focused spec or command to add or run and the cases it must cover: the failing case from the finding, the neighbouring cases that must keep working, and any edge case the fix could break (e.g. "a three-year legacy agreement at $12,000 a year shows $36,000; single-year and explicitly split schedules, including years with different prices, stay correct"). Not "run the tests".

Re-check each candidate independently against its evidence. Discard false positives, confirmations disguised as issues, and recommendations that defeat the stated intent. Consolidate duplicate symptoms of one root cause.

Merge the five lenses into one list:

1. Collect candidates from every lens, including every Codex and diff-only finding.
2. Re-prove each Codex and diff-only finding yourself against the reviewed revision (read the code, trace the caller, or run a command). Agreement requires verification; Codex saying so is not evidence.
3. Merge findings that share a root cause into one entry, keeping the strongest evidence and the highest justified severity.
4. Tag each surviving finding with the lenses that raised it, e.g. `[senior, codex]`, `[structural]` or `[diff-only]`.
5. Record every discarded candidate in the verification log with its lens and a one-line reason.

The diff-only lens over-flags on purpose; do not over-drop it. Drop a diff-only candidate only when it is provably wrong or its fix would defeat the intent. "Matches the file's existing convention" or "not reachable from the current UI" is not a reason to drop a cheap, correct hardening (visibility, nil versus false, accessibility, comment accuracy); keep it, usually as low.

### Root causes and sibling sweep

Every verified finding gets a root cause before the report is written. Findings are symptoms; the report must name what produces them, so one fix round can close the whole family instead of one instance per review.

1. **Name the cause.** For each finding, state the design choice or missing invariant that makes the defect possible, not the line that shows it. Typical causes: a copy of data with no single owner or sync point; state an editor or cache copies from its source and never refreshes; a rule enforced in one layer or entry point but not its siblings; the same check duplicated in several places; callbacks whose timing or order decides correctness.
2. **Group into families.** Findings with the same cause form one family. A cause with a single finding is still a family of one.
3. **Sweep for siblings.** For each family, search the whole reviewed scope and its callers (`rg` for the pattern, every writer of the copied data, every entry point to the rule) and check each instance. Report every instance, including ones no reviewer raised, each marked verified or unverified.
4. **Give fix options.** For each family: the per-site patch and the structural fix (one owner, one sync point, one shared helper or pattern), with trade-offs, and a recommendation. When the choice changes behavior or design, mark it for the user's decision.
5. **On a re-review of fixes,** say for each earlier family whether the fix closed the cause or only the reported instance, and list the siblings that remain.

Before recommending a family repair, test its proposed rule against neighboring valid behavior and the other findings. Record the invariant, its owning layer, all affected entry points, and the regression cases that would distinguish a root repair from a local patch. A shared helper alone does not establish closure. Consolidate the review before handing it to an implementation task; do not issue serial partial fix requests while sibling investigation is still feasible and unfinished.

Findings stay in their severity sections; each one carries its family tag, e.g. `[family: F-1]`.

If Codex or the diff-only agent is unavailable or fails, continue with the other lenses and record the missing second opinion as a limitation; do not issue PASS while claiming a Codex review that did not run.

In recheck mode, re-prove every earlier ledger finding against the current state and give it a status: FIXED, NOT FIXED (recorded as OPEN), PARTLY, N/A, or ACCEPTED (an earlier user decision, kept unless the user reopens it), each with a one-line proof. A NOT FIXED or PARTLY finding stays in its severity section with its original ID.

Run the smallest relevant existing checks when they materially improve confidence. Inspect cached results under `tmp/test-cache/` before rerunning unchanged commands, and cache new test/build output with a state-specific filename. Preserve command exit status. Do not run a full suite by default. Do not mutate source or add tests in the user's checkout during this reporting-only review; state any verification gaps. (PR batch mode writes throwaway proof specs only in an isolated worktree and the ledger's repro folder.) Avoid checks that mutate external systems or production data.

## 6. Report and stop (P5 and P6)

Before issuing a final change-review verdict, reconcile mandatory investigation coverage. Finish available, permitted inspection of required files, changed contracts, and review dimensions. Use `Review incomplete` when that feasible investigation remains unfinished, or when missing intent, baseline, or target source prevents establishing a reviewable scope. In an interim report, include verified findings and outstanding coverage without a final `Verdict:` line, PASS, or LGTM. Missing access or context is a review limitation, not an invented code blocker.

Once the scope is established and feasible inspection is complete, a suspicion requiring source changes, new tests, destructive steps, or unavailable systems to resolve is an open question, not unfinished review work. Record its affected path, potential impact, evidence already checked, verification constraint, and what would resolve it; then issue the verdict from confirmed findings. Keep the path marked unverified. Do not downgrade a defect already proven by source or caller tracing merely because execution is unavailable. Do not repeat the same review solely to resolve an unchanged external constraint; reassess when code, evidence, or access changes.

The verification log must also record the sibling sweep for each family: the searches run and the instances checked. It must also record, per lens, what it covered and whether it ran: the Codex command, model, exit status and log path, the diff-only agent's model and effort, and the structural lens checks from its reference file.

For a coordinated review, include the workflow coverage and closure receipt from `references/review-closure.md`. Completion is evidence for the selected scope, not a claim that the repository has no remaining bugs. After authorized repairs, recheck the changed contracts and repair interactions; reopen a closed finding only for new evidence, an unhandled sibling, or a relevant code change.

For a completed change review, calculate the Unified Review Protocol verdict without remediating findings:

- Introduced blocker remaining: `BLOCKED`.
- Introduced high or medium remaining: `CHANGES REQUIRED`.
- Otherwise: `PASS`, including the exact convergence line below.

Pre-existing findings never block the change. PASS describes the reviewed scope and available evidence; it does not prove unreviewed paths safe. Park introduced low findings for the user's decision. Do not ask to fix them or start a fix loop within this review phase. An authorized calling implementation task resumes as described above.

Use the shared rule-44 report template below for final change reviews. Write `none` for empty finding sections. Include the mandatory checklist's coverage ledger, completion status, checks actually run, unavailable checks, assumptions, open questions, and material limits in the verification log. Keep findings concise without dropping evidence. A PASS with open questions means no confirmed gating findings; it does not establish that unverified paths are safe.

```text
## Review: <intent one-liner>
Verdict: PASS | CHANGES REQUIRED | BLOCKED
Counts (introduced / pre-existing): blocker A/B · high C/D · medium E/F · low G/H

### Root causes
- **[F-1] <the cause in one line>** explains <I-1, I-3, P-1>
  - instances: <file:line: verified | unverified>, one per sibling found in the sweep
  - options: <per-site patch> vs <structural fix>, with trade-offs
  - recommendation: <which, and why> (user decides: yes | no)
  - earlier fix status (re-reviews only): <closed the cause | instance only; N siblings remain>

### Earlier findings (recheck only)
| ID | Earlier finding | Status | Proof |
|---|---|---|---|
| I-1 | <short> | FIXED / NOT FIXED / PARTLY / N/A / ACCEPTED | <one line> |

### Introduced by this change
**Blockers (must fix before done)**
- **[I-1] <issue in one line>** [<lenses>] [family: F-1] `<file:line>`
  - evidence: <quoted code / command output / source>
  - why: <trigger and impact>
  - fix: <the concrete change: file, method, existing scope or helper to reuse, what must stay unchanged>
  - verify: <focused spec or command to add or run, and the cases it must cover>
**High**
- none
**Medium**
- none
**Low (parked for user accept/reject)**
- none

### Pre-existing (user decides; NOT blocking this change)
- **[P-1] <severity>: <issue in one line>** [<lenses>] `<file:line>`
  - evidence: <proof>
  - why: <trigger and impact>
  - fix: <the concrete change, or a ticket suggestion if it is too large for now>
  - verify: <focused spec or command, and the cases it must cover>

### Verification log
- [I-1] re-proof: <read / command / traced caller> → upheld | discarded (<reason>)
```

Whenever the final change verdict is PASS, include this literal line:

```text
✅ LGTM: No critical issues found.
```

For whole-codebase or current-file assessments without a change baseline, use the same findings and verification structure, but write `Verdict: N/A (current-state assessment; no change baseline)`. Mark the introduced section not applicable and count findings under pre-existing. Do not emit PASS or LGTM for such assessments. Order findings by severity and report assessed flows and remaining coverage explicitly.

After the report, write the record body to `record.md` for the coordinator, which writes the ledger ("Who reviews" step 6). Every review produces a record body, including current-state assessments and incomplete reviews. In the inline fallback, follow step 6 yourself.

The report is this skill's deliverable. Finish the review phase without modifying the reviewed code, then return control to any authorized calling task.
