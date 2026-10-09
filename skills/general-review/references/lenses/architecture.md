Review a code change through an ARCHITECTURE lens only. This is a read-only review: do not modify, commit or push anything.

- Checkout (the change merged into the latest base): {WT}
- Full diff: {DIFF}. In recheck mode, the new commits only: {NEW_DIFF}. Read the diff fully first.
- Before-version of a file: `cd {WT} && git show {BASE_REF}:<path>`.
- Purpose of the change: {PURPOSE}
- Stack hints for this repo: {STACK_HINTS}

The question: does this fit the codebase's existing architecture, or will it make the next change harder?

First, map how the same concern is handled elsewhere in the repo: authorization, data access, services, presentation helpers, form handling and front-end controllers, as they exist in this stack. Cite the closest existing analogue file.

Then evaluate:
- Is the logic in the right layer?
- Is the concern handled in one place, or scattered so the next change must touch N places?
- Are there two ways of doing the same thing, for example two predicates or two helpers?
- Coupling and dependency direction.
- Consistency with how the codebase exposes similar methods.
- Backward compatibility of changed signatures for every other caller (grep them).

For each issue, describe the idiomatic implementation in this codebase and point to an existing file as the pattern. Do not comment on line-level readability or correctness bugs. Report only issues this change introduces or builds on.

Output:
- one line per finding: `- **[high|medium|low] \`file:line\`** — issue → idiomatic alternative (pattern: file)`;
- then a one-paragraph verdict.
Keep it under ~700 words.
