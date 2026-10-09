Do a THERMONUCLEAR structural review of a Rails change. This is a read-only review: do not modify, commit or push anything.

- Checkout (the change merged into the latest base): {WT}
- Full diff: {DIFF}. In recheck mode, the new commits only: {NEW_DIFF}. Read the diff fully first.
- Before-version of a file: `git -C {WT} show {BASE_REF}:<path>`.
- Purpose of the change: {PURPOSE}

Look past naming and formatting. Hunt for deep structural problems in the changed code:
- **Nuke indirection:** delete a whole layer instead of polishing it.
- **Flatten state:** reframe the data or state model so conditional chains disappear. For example, fix an association at its source instead of adding a parallel accessor.
- **Fix ownership:** move boundaries so the feature becomes a natural extension of an existing abstraction.
- **Simplify flow:** turn special-case logic into a default flow with fewer exceptions.
- **Isolate orchestration** from business logic.
- **Prune wrappers** that add no meaning.
- **Reuse over re-implement:** find near-duplicates of existing helpers and cite them.
- **Dead code:** code the change makes unused, or code it adds that nothing calls.

Report only issues this change introduces or should have fixed.

Output:
1. **The chopping block:** the files, methods or abstractions to delete. One line each, with `file:line` and a severity tag [HIGH|MEDIUM|LOW|NIT].
2. **The blueprint:** a flatter approach that applies the rules above, in at most ~10 bullets.
Keep it under ~700 words.
