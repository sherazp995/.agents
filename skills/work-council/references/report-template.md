# Report template

Answer first, short lines, no dashes joining clauses. Every claim names its evidence.

```markdown
**<Done | Done with open items | Stopped>:** <one line outcome>

Mode: <fast | thorough>. Base: <sha>. Commit: <sha, amended or new; never pushed>.

**What changed**
- <file or area>: <what>

**Evidence**
- `<check command>` → exit 0
- Real product: `<command or flow>` → <observed result> | not verified: <why>
- general-review: <verdict> after <n> rounds

**Council**
- Plan critique: <Codex | llm-council>; adopted <n>, rejected <n> (<one-line reason each>)
- Build (thorough): winner <builder>, decided by <checks | judges | only-candidate | fallback>; grafts applied <n>

**Open items**
- <introduced lows, pre-existing findings, unverified paths, skipped steps>
- <missing inputs: Codex unavailable, builder failed, judges split>
```

Name the builder (Claude or Codex) only in this report, after judging.
