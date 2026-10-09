---
description: Thermo-nuclear code quality review of the current branch's changes (strict maintainability audit)
---

Invoke the `thermo-nuclear-code-quality-review` skill and apply it to the current branch's changes (diff against the base branch).

Be ambitious about structural simplification. Hunt for "code judo" moves that delete whole branches/layers rather than rearranging complexity. Flag files crossing 1000 lines, spaghetti conditionals, feature logic leaking into shared paths, thin wrappers, and unjustified casts/optionality. Prefer a few high-conviction structural comments over a pile of cosmetic nits.

$ARGUMENTS
