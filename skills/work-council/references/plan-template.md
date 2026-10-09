# Plan template

Keep it short; the user reads it before approving.

```markdown
# Plan: <task>

Intent: <one line: what changes and why>
Out of scope: <what this change will not touch>
Base: <BASE sha>

## Unknowns
- <question that would change the design> → <probe run> → <answer> [measured | inferred | unknown]

## Cards
1. <what>; files: <up to ~5 paths>
   Check: `<one command that passes or fails>`
2. ...

## Final checks (all must exit 0)
- `<command>`
- `<command>`

## Real-product proof
<the command, URL, or flow to run on the core path, or why it cannot be run here>
```

Rules:

- A card without a pass/fail command is not a card. Split or rewrite it.
- Final checks are real repository commands you have seen work (or seen fail for the expected reason) on BASE.
- An `[unknown]` that would change the design is a question for the user at the approval pause.
