---
name: thermo-nuclear-code-quality-review
description: Run an extremely strict maintainability review for abstraction quality, giant files, and spaghetti-condition growth. A thin alias that runs general-review with only its structural (thermo-nuclear) lens. Use for a thermo-nuclear code quality review, thermonuclear review, deep code quality audit, or especially harsh maintainability review.
disable-model-invocation: true
---

# Thermo-nuclear code quality review

This is an alias. Read `~/.agents/skills/general-review/SKILL.md` and run it as a single-lens run with the lens `structural` (its "Single-lens runs" section).

- The standards live in `general-review/references/structural-standards.md` and the severity mapping in `general-review/references/structural-lens.md`. They are the single source; do not keep a copy here.
- Default target: the current branch's changes against its base branch.
- Be ambitious: hunt for code-judo moves that delete whole branches or layers, and prefer a few high-conviction structural findings over cosmetic notes.
- For a full review with every lens, run general-review itself.
