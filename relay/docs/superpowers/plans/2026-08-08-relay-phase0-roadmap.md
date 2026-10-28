# Relay Phase 0 Roadmap

**Source spec:** `docs/specs/2026-08-08-relay-requirements.md` v1.10
**Scope:** Phase 0 only (93 of 345 requirements). Phases 1 to 5 get their own roadmaps.

Phase 0 spans six independent subsystems. One plan for all of them would be unreviewable, so it is decomposed into six milestones. **Each milestone produces working, testable software on its own** and has its own plan document written just before it is executed, so later plans benefit from what earlier ones learned.

## Milestones

| ID | Milestone | Delivers | Done when |
|---|---|---|---|
| **P0.1** | Foundation | Repo scaffold, strict TypeScript, Vitest, fail-closed config and policy loading, structured logging, Postgres with migrations, Redis, `relay doctor` | `pnpm test` green, `relay doctor` reports every dependency truthfully, an invalid policy refuses startup |
| **P0.2** | Chat contract and Slack adapter | `ChatAdapter` interface, adapter conformance suite, mock Slack server, Slack Bolt over Socket Mode, mention/DM/thread ingestion, self-editing progress message | The bot receives a mention in a real workspace and edits one message in place. Conformance suite passes against both the mock and the real adapter |
| **P0.3** | Orchestrator and run lifecycle | Sessions, runs, steps, the run state machine, persist-before-side-effect, Agent SDK loop with one trivial capability, cancellation, final report | `@relay what is 2+2` produces a persisted run with steps and a final report. Killing the process mid-run leaves a resumable record. **GT-14 (cancel within 5s) passes** |
| **P0.4** | Capability registry, policy engine, approvals, secrets | Registry with risk tiers, classification and escalation rules, allow/deny/ask, hard-block list, kill switch, Block Kit approvals with timeout, Keychain secret broker | A sensitive action requests approval and honours Approve, Deny, and timeout. The kill switch halts mid-action within 5s. An invalid policy fails closed |
| **P0.5** | Browser tiers 1 and 2, profile registry | Profile registry with fail-closed resolution, per-tier origin enforcement, CDP driver, extension tier with identity verification, local fixture site | **GT-1 (authenticated read and count) passes.** A task binds to the correct profile or refuses. Setup reports which tiers are truly available per profile (FR-PRF-6a) |
| **P0.6** | Data governance, setup wizard, readiness, log rotation | Enumerated egress with the enforcing proxy, classification labels, `relay init` wizard, smoke tests, readiness report | **GT-20's profile half and GT-27 (network capture matches egress inventory) pass.** A clean machine reaches first successful task inside 30 minutes (NFR-12) |

**Carried gap.** FR-OBS-1 requires logs to be rotated and size-capped. P0.1 delivers structured logging with identifier binding but not rotation, which belongs with the daemon and its operational setup. P0.6 owns it. This is recorded rather than dropped, and phase 0 is not complete without it.

**Phase 0 exit (from spec §17):** GT-1, GT-14, and GT-20's profile half pass. An approval and the kill switch both demonstrably work. A task binds to the correct profile or refuses.

## Review intensity: full rigor, decided by the operator

Asked on 2026-08-08 whether to tier review intensity by milestone risk, the operator chose **full rigor everywhere**. That means, for every milestone including the plumbing-heavy ones:

- Every task gets an independent task reviewer, never self-review alone.
- Every milestone gate gets both a whole-branch reviewer on the most capable model and an independent Codex review of the diff.
- Every finding is re-proved before it is acted on, and every fix round ends with a scoped re-review.

This roughly doubles elapsed time per milestone relative to implementation alone. P0.1 justified it: the gate found a missing pool error listener that would have crashed the daemon on any Postgres restart while it held the machine lock, a mutable policy that left FR-POL-4 unenforced, and a test harness that reported success with all integration coverage silently skipped. None of those were caught by the implementers or by the per-task reviews.

## Concurrency discipline on a shared checkout

Learned the hard way during the P0.1 gate. Full rigor means reviewers routinely revert a fix in the working tree to prove its covering test fails without it. On a single shared checkout that races any concurrent commit. During P0.1 a docs commit made with `git add -A` swept a reviewer's temporary revert into history, and HEAD silently carried the old unbounded `pg_advisory_lock` call while still defining the bounded helper beside it. The suite still passed, because the reviewer had already restored the working tree.

Three rules, from here on:

1. **Never `git add -A`.** Stage explicit paths, always. A commit should contain only files its author edited.
2. **Reviewers performing revert-and-test work in their own git worktree**, not the shared checkout, whenever the controller may commit during their run.
3. **Verify HEAD after any commit made while an agent is live**: `git diff --stat <last-known-good> -- <paths>` on anything the agent might have touched.

The collision was caught only because the reviewer noticed and said so. Do not rely on that.

## Review gate between every milestone

Non-negotiable, per the operator's rule 44 and their explicit instruction. No milestone starts until the previous one passes.

1. **Self-review** under the Unified Review Protocol against the milestone's diff. Every finding carries `file:line`, quoted evidence, severity, and origin.
2. **Codex review** via `codex exec` on the diff, emitting the fixed template. Run it on the diff, never on the whole tree, since Codex took 40 minutes on a 1300-line document and produced nothing usable until the input was bounded.
3. **Re-prove every finding** before acting. Discard what does not hold up, with a one-line reason.
4. **Gate:** introduced blockers must be resolved; introduced high and medium fixed; introduced low parked for the operator. Pre-existing findings never block.
5. **Verify, do not assert:** the milestone's stated "done when" criteria are executed and their real output recorded, per `superpowers:verification-before-completion`.
6. **Immediately before tagging: confirm `git status --short` is empty, and confirm every fix the verdict depends on is in `HEAD` rather than the working tree.** P0.3 was tagged with two fixes uncommitted, including a GT-14 failure, because the final check was the tag list and diff totals rather than the tree. Passing tests prove nothing when the passing code is not committed.
7. Milestone tagged in git only after the gate passes and that check is clean.

## Global constraints

Copied verbatim from the spec; they apply to every task in every milestone.

- **AP-8:** every table carries `workspace_id` from the first migration. Multi-user must be configuration, not migration.
- **AP-5:** every step is persisted before it is executed and after it completes.
- **AP-2:** all outside content is data, never instruction. Never concatenated into a system prompt.
- **FR-POL-2:** an invalid or malformed policy file fails closed and prevents startup. Never defaults permissive.
- **FR-POL-3:** the default for anything unmatched is `ask`, never `allow`.
- **FR-DATA-2:** permitted egress destinations are a closed enumerated list. Anything absent is denied.
- **FR-DATA-3:** Relay's own code emits no third-party telemetry, analytics, or crash reporting.
- **FR-SEC-2:** credentials are brokered. A secret value never enters the model context, a transcript, a log, or an audit record.
- **FR-RPT-10:** no diffs, file bodies, raw logs, or long output in any chat surface. Summary plus link.
- **NFR-10:** the core orchestrator carries no macOS-specific dependency. macOS specifics live only in the local runner package.
- **NFR-11:** one stated purpose per module, documented interface, independent tests. Keep files small enough to reason about in one pass.
- **Rule 45:** no dash used as sentence punctuation in any prose, including code comments and commit messages.
- **Rule 41:** cache test output to `tmp/test-cache/<name>.log`; answer follow-ups from the cache rather than re-running.
- **Rule 42:** purely additive diffs run only their own narrow tests. The full suite runs once per milestone, at the review gate.

## Technology, fixed for phase 0

| Concern | Choice | Version present on this machine |
|---|---|---|
| Runtime | Node LTS | v22.18.0 |
| Package manager | pnpm | 10.33.0 |
| Language | TypeScript, `strict: true` | pinned in `package.json` |
| Tests | Vitest | pinned in `package.json` |
| Schema validation | Zod | pinned in `package.json` |
| Logging | Pino, JSON output | pinned in `package.json` |
| Database | Postgres | 17.7 local, Docker Compose for reproducibility |
| Queue, locks, pub/sub | Redis | 8.4.0 local, Docker Compose for reproducibility |
| CLI | Commander | pinned in `package.json` |
| Agent loop | Claude Agent SDK | added in P0.3, not before |
| Chat | Slack Bolt, Socket Mode | added in P0.2, not before |

Dependencies are added in the milestone that first needs them, never earlier. A dependency with no consumer is dead weight and hides its own risk.
