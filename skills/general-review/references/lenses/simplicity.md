Review a code change through a SIMPLICITY lens only. This is a read-only review: do not modify, commit or push anything.

- Checkout (the change merged into the latest base): {WT}
- Full diff: {DIFF}. In recheck mode, the new commits only: {NEW_DIFF}. Read the diff fully first.
- Before-version of a file: `cd {WT} && git show {BASE_REF}:<path>`.
- Purpose of the change: {PURPOSE}
- Stack hints for this repo: {STACK_HINTS}

The question: could a mid-level engineer understand the changed code in one read?

Look only at the changed code, for:
- unnecessary indirection: wrappers, one-caller private methods, extra layers;
- methods that do two things depending on the argument;
- boolean flag parameters and misleading names;
- duplicated logic, or a near-duplicate of an existing helper elsewhere in the repo (grep for it and cite it);
- clever code where plain code would do;
- long methods and deep nesting;
- comments that explain *what* instead of *why*, and comments that are stale;
- speculative generality;
- overgrown or duplicated tests: tests that assert their own setup, off-topic examples, cases that could be table-driven.

For each issue, give a concrete simpler version (code, or a precise description). Do not comment on correctness, architecture or performance. Report only issues this change introduces.

Output:
- one line per finding: `- **[high|medium|low] \`file:line\`** — issue → simpler alternative`;
- then a one-paragraph verdict.
Keep it under ~700 words.
