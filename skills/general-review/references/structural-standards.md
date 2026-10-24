# Structural standards (thermo-nuclear)

The single source of the thermo-nuclear code quality standards. The [structural lens](structural-lens.md) applies them inside every general review; `thermo-nuclear-code-quality-review` and `/thermonuke` run that lens on its own. Severity, report format and verdict come from the general-review SKILL.md and the lens file, not from this file.

## Core prompt

> Perform a deep code quality audit of the change.
> Rethink how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce spaghetti code, improve succinctness and legibility.
> Be ambitious: if there is a clear path to improving the implementation that involves restructuring some of the codebase, say so.
> Measure twice, cut once.

## Standards

Apply the core prompt plus these standards. Ask each one of every meaningful change and flag what it finds aggressively. Items marked **Presumptive** are problems unless the change justifies them clearly; the [structural lens](structural-lens.md) severity table sets their severity.

1. **Be ambitious about structural simplification.**
   - Do not stop at "this could be a bit cleaner." Assume there is often a "code judo" move available: a re-organization that uses the existing architecture more effectively and makes the change dramatically simpler and more elegant.
   - Look for a reframing that needs fewer concepts, so whole branches, helpers, modes, conditionals or layers disappear entirely. Prefer the solution that makes the code feel inevitable in hindsight.
   - If you see a path to delete complexity rather than rearrange it, push hard for that path. Flag a complicated implementation where a cleaner reframing could delete whole categories of complexity, and refactors that move code around but fail to reduce the number of concepts a reader must hold in their head.
   - **Presumptive:** the PR preserves a lot of incidental complexity when there is a plausible code-judo move that would delete it.

2. **Bias toward cleaning the design, not just accepting working code.**
   - If behavior can stay the same while the structure becomes meaningfully cleaner, push for the cleaner version. Do not rubber-stamp "it works" implementations that leave the codebase messier, including refactors that technically pass tests but make the code less modular or less readable.
   - Strongly prefer simplifications that remove moving pieces altogether over refactors that merely spread the same complexity around. Ask whether the change improves or worsens the local architecture, and whether a previously cohesive module became more coupled, more stateful, or harder to scan.

3. **Do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason.**
   - Treat this as a strong code-quality smell by default, especially if the new code could be split out. Prefer extracting helpers, subcomponents, modules, or local abstractions instead of letting a file or component sprawl past a healthy size boundary.
   - If the diff crosses that threshold, explicitly ask whether the code should be decomposed first. Only waive this if there is a compelling structural reason and the resulting file is still clearly organized.
   - **Presumptive:** the PR pushes a file from below 1000 lines to above 1000 lines.

4. **Do not allow random spaghetti growth in existing code.**
   - Be highly suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows. If a change adds "weird if statements in random places", treat that as a design problem, not a stylistic nit.
   - Flag one-off booleans, nullable modes or flags that complicate existing control flow; narrow edge-case handling in the middle of an already busy function; "temporary" branching that is likely to become permanent debt; repeated conditionals that signal a missing model or helper; and branching complexity added where a better abstraction should exist.
   - Prefer pushing the logic into a dedicated abstraction, helper, state machine, policy object, or separate module instead of tangling an existing path. Call out changes that make the surrounding code harder to reason about, even if they technically work, and implementations that rely on special cases and incidental control flow instead of being direct and legible.
   - **Presumptive:** the PR adds ad-hoc branching that makes an existing flow more tangled.

5. **Prefer direct, boring, maintainable code over hacky or magical code.**
   - Treat brittle, ad-hoc, or "magic" behavior as a code-quality problem. Be skeptical of generic mechanisms that hide simple data-shape assumptions or simple structure.
   - Flag thin abstractions, identity wrappers, or pass-through helpers that add indirection without buying clarity: is the abstraction earning its keep, or is it just a wrapper?

6. **Push hard on type and boundary cleanliness when they affect maintainability.**
   - Question unnecessary optionality, `unknown`, `any`, casts, or optional params that muddy the real contract or obscure the invariant, when a clearer type boundary could exist.
   - Prefer explicit typed models or shared contracts over loosely-shaped ad-hoc objects. If a branch relies on silent fallback to paper over an unclear invariant, ask whether the boundary should be made explicit instead.
   - **Presumptive:** the PR adds an unnecessary abstraction, wrapper, or cast-heavy contract that makes the design more indirect.

7. **Keep logic in the canonical layer and reuse existing helpers.**
   - Ask whether the logic lives in the right file, layer and package. Call out feature-specific logic leaking into shared or general-purpose paths, and implementation details leaking through APIs or across a boundary. Push code toward the package, service, or module that should own it instead of normalizing architectural drift.
   - Prefer existing canonical utilities and helpers over bespoke one-offs, and flag copy-pasted logic instead of extracted helpers.
   - **Presumptive:** the PR solves a local problem by scattering feature checks across shared code.
   - **Presumptive:** the PR duplicates an existing helper or puts logic in the wrong layer when there is a clear canonical home.

8. **Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious.**
   - If independent work is serialized for no good reason (including sequential async flow), ask whether the flow should run in parallel instead, where that keeps it simpler and clearer.
   - If related updates can leave state half-applied, push for a more atomic structure.
   - Do not over-index on micro-optimizations, but do flag avoidable orchestration complexity that makes the implementation more brittle.

9. **Do not add code debt.**
   - Code debt here means non-generic code that a repo has to keep in sync by hand. Flag a change that adds any of:
     - a name table or registry keyed on names declared somewhere else (method, type, symbol or route names), or a new entry in such a list;
     - a special case keyed on a type, method or symbol name string (`if name == "call"`, `match name.as_str()` over domain names) where a typed marker, a declaration or the data itself could carry the decision;
     - the same rule implemented again in a parallel stage, backend, binary or service instead of one shared place;
     - a string protocol two stages must match by hand (a synthesized name one stage emits and another parses or compares).
   - Find the repo's own debt record before judging, the same way in every repo: read the project instruction files (`CLAUDE.md`, `AGENTS.md`, and the files they link) for removed or forbidden patterns, then search the tree for a code-debt audit, a TODO or decisions file and ADRs (`rg -il "code.debt|tech.debt|non-generic|hardcod" docs *.md`), and skim recent commit subjects for removals (`git log --oneline -30`). Record in the verification log which files you used, or that the repo has none. A change that brings back a pattern the repo catalogued or removed in its recent history, or grows a list the repo marks as debt, is a regression even when it works.
   - **Presumptive:** the PR adds a name-keyed table or special case, duplicates a rule another stage already owns, or reintroduces a debt pattern the repo has catalogued or removed.

## Preferred remedies

When you identify a code-quality problem, prefer suggestions like:

- Delete a whole layer of indirection, or wrappers that do not meaningfully clarify the API, rather than polishing them.
- Reframe the state model so conditionals disappear instead of getting centralized; turn special-case logic into a simpler default flow with fewer exceptions; collapse duplicate branches into a single clearer flow.
- Change the ownership boundary so the feature becomes a natural extension of an existing abstraction, or move the logic to the package, module or layer that already owns the concept.
- Extract a helper or pure function, split a large file into smaller focused modules, or move feature-specific logic behind a dedicated abstraction.
- Replace condition chains with a typed model or explicit dispatcher, and make type boundaries more explicit so the control flow gets simpler.
- Separate orchestration from business logic.
- Reuse the existing canonical helper instead of introducing a near-duplicate.
- Replace a name table or name-keyed special case with one generic mechanism: derive the decision from the declaration, a typed marker or the data, and route every stage through one shared rule.
- Parallelize independent work when that also simplifies the orchestration, and restructure related updates into a more atomic flow when partial state would be harder to reason about.

## Priorities

Prefer a few high-conviction structural findings over a pile of cosmetic notes, in this order: structural regressions; missed code-judo simplifications; spaghetti or branching growth; boundary, abstraction and type-contract problems; file size and decomposition; modularity; legibility.
