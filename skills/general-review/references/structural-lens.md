# Structural lens (thermo-nuclear)

This lens brings the thermo-nuclear code quality review into every general review, so it no longer needs a separate call.

## Source of the standards

Read `~/.agents/skills/thermo-nuclear-code-quality-review/SKILL.md` in full and apply its "Non-Negotiable Additional Standards", "Primary Review Questions", "What to Flag Aggressively" and "Preferred Remedies" to the change under review. That file stays the single source of the standards; do not copy or reword them here. Its own report format, tone section and approval bar do not apply inside general-review; this file replaces them with the mapping below.

## How to apply inside a general review

- Scope: the frozen change scope from P0. Structural concerns about code the change did not touch are pre-existing.
- Ambition: look for a "code judo" move that deletes branches, helpers or layers rather than rearranging them. A suggestion must preserve behavior and stay within the change's intent.
- Measure, don't guess: for the 1000-line rule, compare line counts in P0's actual baseline and target contents, using the selected committed revision, index, or working-tree snapshot. Cite both numbers. Without a change baseline, report current size without claiming the review introduced a threshold crossing.
- Evidence: every structural finding still needs a file:line, a quoted snippet, the concrete maintainability cost, and a proposed restructuring. "Could be cleaner" without a concrete alternative is not a finding.
- Volume: prefer a few high-conviction structural findings. Drop cosmetic notes when a larger structural issue exists.

## Severity mapping

| Structural situation | Severity when introduced |
| --- | --- |
| Thermo-nuclear "presumptive blocker": pushes a file past 1000 lines, adds ad-hoc branching that tangles an existing flow, scatters feature checks across shared code, adds an unnecessary wrapper or cast-heavy contract, duplicates a canonical helper, or puts logic in the wrong layer | high |
| Missed code-judo simplification with a clear, behavior-preserving path | medium |
| Thin wrapper, needless optionality or cast, legibility harm with concrete cost | medium |
| Naming or cosmetic polish | low |

A structural problem that also causes a correctness or security failure takes that dimension's higher severity. Origin follows the parent skill: an existing structural smell the change merely touches is pre-existing unless the change made it worse.

## Recording

In the verification log, list the structural checks run: files whose line counts were compared (with numbers), changed flows checked for new branching, wrappers and casts inspected, and any code-judo alternative considered and rejected (with the reason).
