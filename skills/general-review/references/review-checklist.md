# Mandatory review checklist

Use this checklist with the parent skill. It specifies the investigation, not permission to fix anything. Keep the reviewed source unchanged. Read all steps before starting, then work in order. Keep a working coverage ledger and include its compact results in the final verification log. Do not create repository documentation just to track the review.

## 1. Establish intent and invariants (P0)

Record the requested outcome, acceptance criteria, and explicitly excluded work. Identify the behavior that must remain unchanged: permissions, existing workflows, returned values, persistence, side effects, and compatibility promises. Separate intentional behavior changes from regressions.

Use the task, PR description, relevant documentation, old implementation, and tests together. Tests alone are not a complete specification. If they conflict, expose the conflict rather than choosing silently. Ask for missing product intent only when it prevents a valid assessment; proceed with independent inspection meanwhile.

Completion evidence: a one-sentence intent, explicit invariants, and material assumptions.

## 2. Freeze the review scope (P0)

Record repository, target branch or PR, base and head revisions, and working-tree state. Inspect status, staged and unstaged diffs, changed-file lists, additions, deletions, renames, and relevant untracked files. For a PR, use its actual base and merge base. Do not include unrelated local changes in a PR finding.

Read the full diff, then full touched files and applicable project instructions. Include configuration, dependency manifests and lockfiles, migrations, generated artifacts, templates, scripts, and tests when changed. If a file is too large for one read, read it in explicit sections; truncated tool output does not count as coverage.

Use the exact baseline version of touched behavior when comparing changes. Do not switch branches, reset the checkout, or alter the user's files to inspect old code. If refs are unavailable or stale, disclose it and obtain the right baseline before a definitive change review.

For a branch or PR, inspect baseline files with `git show <merge-base>:<path>`, replacing `<merge-base>` with the recorded merge-base commit. For combined uncommitted changes, the baseline is normally `HEAD`; use the target's actual baseline rather than a branch merge base. Read staged content with `git show :<path>`. These commands inspect versions without switching branches.

Bind all source reads, caller searches, blame, and test results to the target state as well as the baseline. A PR diff against a recorded head does not make the current checkout that head. Read committed files with `git show <head>:<path>` and search with `git grep <pattern> <head> -- <paths>`, or use an isolated snapshot of that revision. Read deleted files at the baseline. For staged-only reviews, inspect the index rather than unstaged file contents; for combined working-tree reviews, record both layers and relevant untracked content.

Run checks in the current checkout only if its relevant files and dependencies match the target. Otherwise use an isolated temporary checkout of the recorded revision, without changing the user's checkout, or mark execution unverified. Label results with the actual revision and source state tested. Never use a local fix absent from the PR as proof that the PR passes.

For whole-codebase reviews, enumerate modules and important flows before sampling. Mark modules not inspected. A sampled review cannot be described as exhaustive.

Completion evidence: target identifiers and an inventory with every in-scope file accounted for.

## 3. Map architecture and changed contracts (P1)

Detect the stack from repository files. Map relevant entry points through business logic, persistence, external services, background work, and output consumers. Establish where validation, authorization, transactions, and error handling belong.

For each changed behavior, record its public entry point, changed symbols, intended difference, preserved contract, and dependent components. Include implicit contracts: ordering, filtering, nullability, exceptions, units, timezones, callback execution, and serialization. Treat configuration and dependency changes as behavioral changes even without a changed function.

Check whether the approach solves the right problem in the right layer. Identify existing facilities before recommending another abstraction.

Completion evidence: a behavior inventory and relevant architectural boundaries.

For coordinated reviews, give each workflow and cross-layer boundary an owner using `review-closure.md`. Reconcile file coverage with workflow coverage before proceeding; separate frontend and backend passes can both miss the contract between them.

## 4. Trace regression paths (P2)

For every changed contract, perform all of these checks:

1. Read the previous implementation and record observable behavior.
2. Find direct callers and consumers with targeted searches.
3. Search indirect wiring: routes, callbacks, events, registrations, dependency injection, reflection, templates, configuration, and generated clients.
4. Follow callers and callees at least one level deeper. Continue further when a changed assumption propagates, until reaching a stable boundary or observable outcome. One level is a minimum, not a safe stopping point by itself.
5. Identify consumers outside the repository, such as deployed clients, webhooks, integrations, stored jobs, and persisted payloads. Mark unavailable consumers as unverified; zero search matches does not establish that code is unused.
6. Compare before and after for the same input and relevant system state. Check output values and types, exceptions, ordering, persistence, side effects, permissions, performance, and timing.
7. Trace both the newly changed path and an existing neighboring path that must remain unaffected. Shared helpers require inspecting representative consumers with different assumptions.
8. Check removals and renames for remaining references, public contracts, old data, and dynamic use before calling them safe.
9. Link affected paths to existing tests or concrete inspection evidence. Explain any material uncovered path.

Record this regression information. Use a matrix for multiple affected contracts; the compact option in step 13 permits equivalent prose for a low-risk diff:

| Changed contract | Consumer or flow | Before | After | Preserved or intentional change | Evidence or gap |
| --- | --- | --- | --- | --- | --- |

Example: changing an empty collection to null requires checking iteration consumers. Report a crash only after tracing a reachable consumer that assumes a collection; check guards before asserting failure.

Completion evidence: each changed contract has a consumer trace and before-and-after comparison. Unresolved external dependencies are visible limitations.

## 5. Check logic and failure behavior (P2)

For applicable input types, inspect absent, null, empty, false, zero, negative, minimum, maximum, just-outside-boundary, duplicate, malformed, and unusually large values. Distinguish missing keys from explicitly cleared values, and booleans from truthiness.

Check condition ordering, fallback precedence, early returns, off-by-one errors, rounding, units, overflow, date boundaries, timezones, encoding, and normalization where relevant. Verify user-controlled values reach validation before consequential use.

Trace failure at each relevant boundary: validation rejection, missing records, database error, external timeout, partial response, cancellation, and resource exhaustion. Check cleanup, resource ownership, propagated errors, user feedback, and whether failed operations leave partial state. Do not demand elaborate handling for hypothetical failures without a real path or requirement.

Check user feedback on every outcome of a user action. For each flash, toast, or status message, ask when its condition is false and what the user sees then; a message guarded by an incidental signal (the `Referer` header, the previous page, a query flag) leaves some paths silent, e.g. `flash[:notice] = "Saved" if request.referer&.match?(...)` shows nothing when the browser omits the referer. For every operation that can report failure (a `destroy`, `save`, or `update` returning false, a service result, an HTTP call), check that success and failure get separate branches, and that the code does not announce success after an ignored return value, e.g. `@document.destroy` followed unconditionally by `flash[:notice] = "Deleted"`. Report both even when the failure path is rare.

Completion evidence: meaningful branches and boundaries inspected, with failures tied to concrete paths.

## 6. Check security and privacy (P2)

Trace authentication and authorization separately. Check resource ownership and tenant boundaries on reads and writes, including nested identifiers, bulk actions, downloads, and background jobs. Verify default-deny behavior and server-side enforcement; hidden UI controls are not authorization.

Inspect trust boundaries for query, shell, template, path, and HTML injection. Check mass assignment, CSRF where applicable, unsafe redirects, server-side URL fetching, file traversal, and unsafe deserialization on reachable paths. For uploads, examine filename handling, actual content validation, size limits, storage, and access controls.

Check credentials, sensitive logs, error responses, cache keys, encryption or blind-index behavior, and cross-user data exposure. Inspect abuse controls only where the exposed operation and its cost justify them. Do not echo secrets into the report; cite the location with redacted evidence.

Completion evidence: relevant trust boundaries, enforcement points, and sensitive data paths checked.

## 7. Check persistence and data transitions (P2)

Inspect database constraints alongside application validation. Check nulls, defaults, uniqueness, type changes, precision, referential integrity, deletion effects, and transaction boundaries. Ensure derived counters, caches, and indexes remain consistent with source data.

Check old records, partially populated records, and transitions such as set to cleared, active to inactive, owned to reassigned, and present to deleted. Compare state before and after, including effects on related records.

For migrations and backfills, inspect reversibility, locking, table size assumptions, batching, retry safety, partial completion, and compatibility with running old and new code. Check multiple databases and avoid assuming cross-database joins or transactions work.

Completion evidence: affected data states and migration or backfill implications recorded.

## 8. Check concurrency, jobs, and external effects (P2)

Consider two simultaneous requests, double submission, repeated delivery, out-of-order events, and a retry after partial success. Identify check-then-write races, lost updates, uniqueness races, lock ordering, and whether transaction scope covers the actual invariant.

For jobs and external calls, check idempotency, queue selection, retry behavior, timeout handling, deduplication, ordering, and job payload compatibility across deploys. Check whether work can run before its database transaction commits, or external effects occur before a rollback. Verify appropriate cleanup after cancellation or failure.

Completion evidence: applicable interleavings and retry paths traced; do not assert a race without a possible execution sequence.

## 9. Check performance and resource use (P2)

Inspect query counts, eager loading, nested loops, API calls per item, indexes, pagination, and query bounds. Look for loading entire collections when bounded iteration is needed. Check caches for invalidation, stale results, unbounded growth, and incorrectly shared keys.

Consider realistic input sizes, allocation, file or connection lifetimes, algorithmic growth, blocking work, and hot-path frequency. For frontend changes, examine repeated rendering, unnecessary requests, listener cleanup, and bundle impact where relevant. Inspect existing query diagnostics, including Prosopite logs when present.

Use measurements or query traces when needed to support a performance claim. Do not infer a production bottleneck solely from unfamiliar syntax or micro-optimization preferences.

Completion evidence: boundedness and hot-path costs assessed, with measured versus inferred evidence distinguished.

## 10. Check compatibility, deployment, and user flows (P2)

Check API signatures, status codes, error shapes, serialized fields, enum values or ordering, event schemas, and generated clients. Consider old clients with new servers and new clients with old servers when deployment is staggered.

Trace deployment order for code, schema, workers, feature flags, configuration, dependencies, caches, and generated assets. Check old queued jobs and stored payloads. Inspect rollback behavior where the change affects persisted contracts; a reversible migration alone does not prove safe rollback.

For user interfaces, walk initial, loading, empty, populated, success, validation-error, server-error, and repeat-interaction states as applicable. Check semantic controls, accessible names, focus, keyboard behavior, disabled states, duplicate handlers, scoped DOM queries, stale state, locale handling, and relevant responsive layouts. For server-rendered updates, inspect form ownership and replacement targets.

Use browser verification when a material behavior cannot be established from code or tests. If unavailable, state the unverified behavior instead of claiming visual or interaction correctness.

Completion evidence: compatibility boundaries, deployment ordering, and applicable user states assessed.

## 11. Assess tests and run focused verification (P2)

Map each meaningful changed behavior and regression-sensitive path to a test or explicit verification gap. Read assertions and setup; filenames and test counts are not coverage evidence. Check realistic inputs, behavior-based assertions, boundaries, failures, and initial state for transition tests.

Check whether mocks hide the changed integration, fixtures make the trigger unreachable, or assertions would pass if the relevant behavior disappeared. Check deleted or weakened assertions against the former contract. Do not require tests that merely restate framework declarations or trivial pass-through code.

Run the smallest applicable existing tests, type checks, linters, or build checks that add confidence. Reuse cached output only when command, relevant source state, dependencies, and environment match; an old passing filename is not enough. Cache full output and preserve failure exit codes. Do not repeat unchanged runs or default to the whole suite.

Do not mutate the reviewed checkout, add tests to it, or perform destructive reproductions in this reporting-only workflow (PR batch mode's throwaway worktrees, removed after the review, are the one exception; see SKILL.md). If mutation evidence is supplied, assess it; otherwise explain why assertions detect the suspected failure and state that mutation testing was not performed. Do not claim a test was seen failing when it was not.

A failing check is not automatically introduced. Compare with baseline evidence where practical or trace the causal change. Distinguish test failures from environment/setup failures. Unavailable tooling is a verification limitation, not an invented code defect.

Completion evidence: commands, results, cache locations, behavioral coverage, and unverified paths.

## 12. Check maintainability and re-prove findings (P2 through P4)

Check responsibilities, duplication, speculative abstractions, unnecessary dependencies, overly complex branching, unclear names, unused code, misleading comments, and applicable project conventions. Recommend simplicity only when it preserves required behavior. Do not mix unrelated cleanup into findings about the change.

Apply the [structural lens](structural-lens.md) here: measure file sizes at the selected baseline and target (current size only when no change baseline exists), look for new ad-hoc branching, thin wrappers, casts and optionality, logic in the wrong layer, and a code-judo move that deletes complexity. Merge its findings, and the Codex second opinion's, into the same candidate list before re-proving.

Assign severity and origin using the parent skill. For each candidate finding, verify all of the following:

1. The cited line exists in the reviewed revision.
2. The quoted code supports the claim in its full context.
3. The triggering input or state is reachable and relevant.
4. Callers or surrounding guards do not prevent the problem.
5. The user-visible or operational impact is concrete.
6. Origin is supported by baseline comparison, not line age alone.
7. The suggested fix respects intent and known consumers, and its verify step would fail without the fix.
8. Another finding does not already describe the root cause.

Before a repair handoff, challenge the proposed invariant against valid neighboring states and other repairs. Record the regression cases and sibling entry points that a local patch would miss. Preserve stable candidate IDs and dispositions across review rounds.

Discard disproven candidates. Keep unresolved questions separate from confirmed findings. Do not inflate severity because verification is incomplete. Pre-existing issues remain visible without gating the change.

Completion evidence: findings have locations, quotes, triggers, impact, origin, fix, verify, and re-proof.

## 13. Reconcile coverage and report (P5 and P6)

Before reporting, recheck the diff scope and revision. If the code changed during review, inspect the delta and revisit affected evidence; do not silently apply a verdict to another state.

Reconcile the file inventory, behavior inventory, regression matrix, review dimensions, and test coverage. Every in-scope item needs one of these statuses:

| Status | Required evidence |
| --- | --- |
| Checked | What was inspected or executed, plus the result. |
| Not applicable | A specific reason the checkpoint does not apply. |
| Unverified | What remains unknown, why, and its consequence for confidence. |

Use this compact coverage ledger in the final verification log. Group genuinely identical paths when evidence supports doing so; do not hide unchecked paths behind broad labels.

| Step or dimension | Files, contracts, or flows covered | Status | Evidence or limitation |
| --- | --- | --- | --- |

For a small, low-risk diff, keep the rule-44 report sections but compress the verification log. The file inventory, before/after comparison, caller trace, and coverage ledger may be short prose instead of separate tables. Group not-applicable dimensions into one line with a shared concrete reason, for example: `Persistence, concurrency, deployment: N/A; only static help text changed.` Record applicable checks, actual verification, and all material gaps explicitly. Do not list all 13 steps as separate rows or repeat the same evidence under multiple headings. Small line counts alone do not establish low risk; changes to authorization, persisted data, shared contracts, or concurrent behavior need the relevant detailed tracing.

Apply the completion rules in the parent's section 6. Unfinished feasible inspection or missing foundational review scope requires an interim `Review incomplete` report. After feasible inspection is complete, verification requiring prohibited changes or unavailable systems remains an explicit open question with its risk and resolution requirement; it does not prevent a verdict based on confirmed findings. Keep unavailable checks marked unverified and do not repeat them without changed circumstances. Never convert missing evidence into reassurance.

Use the parent skill's severity counts, origin sections, verdict rules, and report template. Include regression evidence when contracts changed; use a matrix or the compact prose option above, keeping consumers and before/after behavior clear. Report inspected scope, checks actually run, open questions, and residual risks. Do not pad a clean review with speculative findings.

End this review phase after reporting. Do not remediate findings, edit source, or publish anything externally within the skill. Return findings to any already-authorized calling implementation task so it can continue under the parent's handoff rules.
