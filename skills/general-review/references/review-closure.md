# Bounded review and root-cause closure

Use this for a change spanning multiple workflows or layers, or when repeated review/fix cycles are the problem. It supplements the mandatory checklist with orchestration and completion evidence. It does not authorize fixes, enlarge the user's scope, guarantee every possible bug, or replace the repository's review gate.

## Freeze the scope and inventory behavior

Confirm the actual PR base or intended integration branch, its merge base, target revision, and working-tree state. Compare local and remote-tracking refs before relying on a local `main`; record unavailable freshness checks rather than reviewing unrelated commits silently. A branch audit includes affected callers and consumers elsewhere in the repository, but unrelated pre-existing debt stays outside its repair scope.

Map changed files to user workflows and changed contracts. A file list is not evidence that the workflow works. For each workflow record:

| Workflow / invariant | Entry points and states | Writer / reader boundaries | Reviewer | Evidence / remaining gap |
| --- | --- | --- | --- | --- |

Cover relevant combinations of state and action, not only individual conditions. Examples include editing a future inactive record, clearing a collection after a request is accepted, replacing a parent of historical children, and revisiting an editor after a write. Use the actual domain's invariants; do not mechanically enumerate every possible combination.

## Give boundaries an owner

When delegation is available and warranted, dispatch independent specialists by workflow or contract. Each brief supplies the same frozen revisions, intent, owned files/contracts, read-only limits, expected evidence, and existing verification caches. Use available concurrency; more copies of the same review are not inherently more coverage. For small scopes or unavailable delegation, one reviewer explicitly owns every boundary.

The lead owns integration across partitions. Assign a reviewer to each relevant boundary: form to request encoder, API parameters to persistence, persistence to serializer/generated client, UI restrictions to server validation, synchronous writes to jobs, legacy to replacement entry points, and mutation results to cached displays. Reviewers must trace across their file allocation far enough to establish the contract; a filesystem boundary is not a stopping point.

For a fresh audit, collect initial independent candidates before sharing the other reviewers' new conclusions. For a re-review, provide the accepted intent, prior finding IDs and dispositions so reviewers preserve task history, but require independent proof. Then have an independent reviewer challenge the merged causal explanations and proposed fixes, especially cases crossing partitions. They should try to disprove the trigger or identify a missing sibling, not merely agree. This is a focused reconciliation pass, not another whole-scope restart. If no independent reviewer can run, disclose that limit and perform the lead's boundary check.

## Close causes before handing off repairs

Keep stable finding and family IDs. Each family must contain:

- **Broken invariant:** what must remain true, and the precise reachable sequence that breaks it.
- **Owner:** the layer that should enforce it and the current writers/readers that bypass it.
- **Sibling sweep:** affected entry points, states and consumers, each verified, disproved, or explicitly unverified with a reason.
- **Repair:** the smallest coherent change that enforces the invariant for verified siblings. Compare a local patch with shared ownership only where they differ meaningfully; do not force a refactor.
- **Repair hazards:** valid neighboring behavior and other families the proposed fix might break.
- **Regression evidence:** the failing case plus those neighboring cases, at the lowest useful test layer; use integration checks for the actual boundaries.

Distinguish root cause from broad labels such as "state management" or "missing tests." Identify the concrete missing rule or ownership mismatch. Do not assume status names imply stronger semantics than the implementation promises, such as delivered when the contract only promises queued. Resolve product ambiguity from available requirements; otherwise record a bounded question without inflating severity.

Finish feasible inspection and consolidate duplicate symptoms before proposing a repair batch. A standalone review stops with that report. For an already-authorized implementation, pass the consolidated families and regression cases to the implementation task. Do not edit during the review phase or infer authorization from the existence of findings.

## Re-review and stop

Keep the same scope and ledger through repairs. Run narrow checks for each changed family, then one integration verification of the repaired workflows and their interactions. Select checks proportional to the change; this is not an instruction to run the entire repository suite. Cache results against the actual tested state.

The repair review inspects the final delta, affected callers, and family regression cases. Add a new finding only with fresh evidence; classify it as an introduced repair regression, a newly verified sibling, or unrelated pre-existing behavior. Do not reopen rejected hypotheses, change priorities without evidence, or restart a whole-branch review after every small fix. A genuinely new regression still requires correction and verification; a stopping rule must not hide known bugs.

Emit a concise closure receipt:

1. Frozen scope and workflow inventory reconciled with the final state.
2. Every workflow and boundary checked or explicitly limited, with evidence.
3. Every candidate disposition recorded; verified findings grouped by cause.
4. For repairs, each family closed or still open with the exact remaining sibling.
5. Checks and regression cases passed, failed, or unavailable, with cache locations.
6. Gate verdict, material uncertainties, and pre-existing issues kept separate.

Stop the review when feasible coverage is complete and the evidence-based verdict is issued. Stop an authorized repair phase when the repository gate passes and required verification is complete. Separate unavailable required checks from optional evidence: unavailable required checks cannot be described as completed verification, and their disposition follows the calling task's rules. Do not continue seeking hypothetical defects solely because absolute certainty is impossible. Do not issue PASS while feasible required coverage is unfinished.
