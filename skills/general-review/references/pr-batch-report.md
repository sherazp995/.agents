# PR batch report format

## Language

- Simple English for non-native readers: short sentences, common words, no idioms.
- Be direct and specific. Name the file and line, the input that breaks it, and what happens.
- No filler or praise padding. One or two lines on what the change gets right is enough.
- Say how you know: "Proof: test showed …" or "checked by reading". Never claim a test you did not run.
- Severity tags: [blocker] [high] [medium] [low]. Questions for the team get "[low, question for the team]".
- If something is not a regression (the base behaves the same), say so.
- End each report with the final line from `ledger.md`: `Runner: <host> | Run: <RUN_ID> | Ledger: <record path, or "not recorded: <reason>">`, plus the proof spec path.
- "Pre-existing" is capped at three lines in the report only; the ledger record keeps every pre-existing finding.

## Review mode (first review)

```
## PR #<n>: <title>          (or: ## Branch <name> (no PR yet): <title>)
**Verdict: PASS / CHANGES REQUIRED / BLOCKED.**
Counts (introduced / pre-existing): blocker A/B · high C/D · medium E/F · low G/H

<2-3 short lines: what the change does, what it gets right. Main claims proven by test.>

**Test run**
- Merged into latest <base> (<sha>): clean / conflicts in <files>
- <N> examples, <F> failures (<which are pre-existing>)
- Linters / front-end tests: <result>

**Must fix** (blockers)
1. **[blocker] `path/file:LINE`: <short title>.** [sources] [family: F-1]
   - <what is wrong, 1-2 sentences>
   - Example: <input/state> → <what happens>
   - Proof: <what the test showed> / checked by reading
   - Fix: <the concrete change>. Fix proven: <N> examples, <F> failures / Fix not proven: <why>
   - Verify: <the spec to add and the cases it must cover>

**Should fix** (high, medium)
2. ...

**Small things** (low, parked for the user)
3. ...

**Root causes:** F-1 <cause>: instances <file:line, …>; recommend <per-site patch | structural fix> (one line each, only when a family has more than one instance)

**Pre-existing** (not blocking, at most three lines)

**Dropped:** <finding> (<source>): <why it is not real> (one line each)

✅ LGTM: No critical issues found.   (only when the verdict is PASS)
```

## Recheck mode (after new commits)

```
## PR #<n>: re-check after the new commit(s)   (add "force-pushed" when it was)
**Verdict: ...** <one line why>

**Test run** (same block as above)

### Earlier findings
| # | Earlier finding | Status | Proof |
|---|---|---|---|
| 1 | <short> | **FIXED** / **NOT FIXED** / **PARTLY** / **N/A** / **ACCEPTED** | <1 short line> |

Main claims: still work / broken (<how>).

### New problems (from the new commits)
1. **[sev] `file:line`: <title>.** <problem>. Proof: <...>. Fix: <...>. Verify: <...>.
(or "None.")

**Still to do:** <one short list of what the author still needs to do>
```

## Status of all targets (main session, after the last report)

| Target | State | Result |
|---|---|---|
| #n short-name, or branch <name> | Open / No PR yet / Merged / No new commits | **Verdict**: main open item |
