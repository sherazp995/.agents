Review a Rails change through an ARCHITECTURE lens only. This is a read-only review: do not modify, commit or push anything.

- Checkout (the change merged into the latest base): {WT}
- Full diff: {DIFF}. In recheck mode, the new commits only: {NEW_DIFF}. Read the diff fully first.
- Before-version of a file: `git -C {WT} show {BASE_REF}:<path>`.
- Purpose of the change: {PURPOSE}

The question: does this fit the app's existing architecture, or will it make the next change harder?

First, map how the same concern is handled elsewhere in the app. Look at Pundit policies and scopes (BuildingScopedPolicy, `policy_scope`), services, decorators, form objects and Stimulus controllers. Cite the closest existing analogue file.

Then evaluate:
- Is the logic in the right layer: policy, model, service, decorator, view or controller?
- Is the concern handled in one place, or scattered so the next change must touch N places?
- Are there two ways of doing the same thing, for example two predicates or two helpers?
- Coupling and dependency direction.
- Consistency with how the codebase exposes similar methods.
- Backward compatibility of changed method signatures for every other caller (grep them).

For each issue, describe the idiomatic implementation in this codebase and point to an existing file as the pattern. Do not comment on line-level readability or correctness bugs. Report only issues this change introduces or builds on.

Output:
- one line per finding: `- **[HIGH|MEDIUM|LOW|NIT] \`file:line\`** — issue → idiomatic alternative (pattern: file)`;
- then a one-paragraph verdict.
Keep it under ~700 words.
