# Report style

## Run attribution

Include `Runner: <host> | Run: <RUN_ID>` and the ledger/report path once per final report. Identify the host separately from reviewer model source tags.

## Language
- Simple English for non-native readers: short sentences, common words, no idioms.
- Be direct and specific. Name the file and line, the input that breaks it, and what happens.
- No filler and no praise padding. One or two lines about what the PR gets right is enough.
- Say how you know: "Proof: test showed …" or "checked by reading". Never claim a test you did not run.
- Severity tags: [CRITICAL] [HIGH] [MEDIUM] [LOW] [NIT]. Questions for the team get "[LOW, question for the team]".
- If something is not a regression (staging behaves the same), say so.

## Review mode (first review)
```
## PR #<n>: <title>
**Verdict: Approve / Approve with small fixes / Request changes.**

<2-3 short lines: what the PR does, what it gets right. Main claims proven by test.>

**Test run**
- PR merged into latest <base> (<sha>): clean / conflicts in <files>
- <N> examples, <F> failures (<which are pre-existing>)
- rubocop / eslint / JS tests: <result>

**Must fix**
1. **[HIGH] `path/file.rb:LINE`: <short title>.**
   - <what is wrong, 1-2 sentences>
   - Example: <input/state> → <what happens>
   - Proof: <what the test showed> / checked by reading
   - Fix: <what to do>

**Should fix**
2. ...

**Small things**
3. ...

**Dropped:** <finding>: <why it is not real> (one line each)
```

## Recheck mode (after new commits)
```
## PR #<n>: re-check after the new commit(s)
**Verdict: ...** <one line why>

**Test run** (same block as above)

### Earlier comments
| # | Earlier comment | Status | Proof |
|---|---|---|---|
| 1 | <short> | **FIXED** / **NOT FIXED** / **PARTLY** / No change | <1 short line> |

Main claims: still work / broken (<how>).

### New problems (from the new commit)
1. **[SEV] `file:line`: <title>.** <problem>. Proof: <...>. Fix: <...>.
(or "None.")

**Still to do:** <one short list of what the author still needs to do>
```

## Status of all PRs (orchestrator, after the last report)
| PR | State | Result |
|---|---|---|
| #n short-name, or branch <name> | Open / No PR yet / Merged / No new commits | **Verdict**: main open item |
