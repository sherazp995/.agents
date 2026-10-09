---
name: copilot-review
description: >-
  Emulate a GitHub Copilot PR review as a distinct, named review step in the workflow.
  A deliberately context-blind, diff-only pass that over-flags the specific class of things
  Copilot posts on PRs: correctness edge cases (boolean/nil vs truthiness), Rails method
  visibility, accessibility, comment/code mismatch, and test gaps. Use this whenever the
  user says "copilot review", "review like copilot", "run the copilot reviewer", or wants
  a branch cleaned of the comments Copilot would file before it goes to the real Copilot
  bot. Run it ALONGSIDE codex and the rule-44 review, not instead of them. It is a separate,
  parallel voice in a 3-reviewer workflow (copilot-review, codex, rule-44/deep).
---

# Copilot Review

Reproduce what GitHub Copilot's PR reviewer does: read the **diff blind**, with no intent and
no repo context, and over-flag the small, real nits a context-rich reviewer glosses over. This
is a separate review voice from `codex` and the deep rule-44 review. In our workflow, run all
three, then filter.

## Phase 1: blind net (high recall)

Get the diff (`git diff <base>...HEAD`, or `git diff` / `git diff --cached` for uncommitted work).
Dispatch a **fresh subagent that receives ONLY the diff**, no conversation history, no intent, no
other files. Brief it to over-flag like Copilot, checking every hunk for the patterns below.

**The Copilot pattern checklist (this is what Copilot actually posts):**

- **Correctness edge cases:** boolean/nil handling. `return nil unless raw` silently drops a
  JSON boolean `false`; check key presence (`return nil if raw.nil?`) instead of truthiness.
  Off-by-one, default values, empty/zero/negative, comparison type mismatches.
- **Method visibility:** non-action helper methods left **public** on controllers/models.
  Copilot flags these; move them below `private`. `helper_method`, `before_action`, and
  `before_create`/callbacks all still work with private methods, and subclasses can call a
  parent's private method without an explicit receiver.
- **Nil / error-path safety:** an unrescued error, a call that can `nil.something`, a branch
  assuming a shape it did not check, a stale session key rendering then crashing a view.
- **View/controller/policy consistency:** a UI control shown where the server would refuse it;
  a gate duplicated with slightly different conditions across layers.
- **Accessibility (Slim/ERB):** icon-only buttons missing `aria-label`; decorative icons
  missing `aria-hidden="true"`; toggles that hide content without moving keyboard focus.
- **Comments vs code:** a comment describing behavior the code does not do; a stale reference.
- **Config/ENV parsing:** string `"false"` treated as truthy; unset default; whitespace.
- **Test gaps:** behavior added with no assertion; a test that would still pass if the code broke;
  assertions on in-memory objects that never `reload` to prove DB round-trip.
- **Naming, dead code, leftover debug, comment typos.**

Ask for a FLAT list, `file:line` + one-line claim, split into **Substantive** (correctness /
security a maintainer would act on) and **Nitpick**. No praise, no severity theatre.

Optionally run a second blind angle in parallel (`codex exec` with the same "review only this
diff" framing) for more coverage.

## Phase 2: filter with context (high precision), but do NOT over-drop

Now switch to full context. For each finding, prove or disprove it against the real code, then
decide. **The failure mode to avoid is over-filtering.** Copilot files hygiene nits and expects
them fixed, so:

- **Do NOT drop a finding solely because it "matches the file's existing convention"** or
  "isn't reachable via the current UI." If it is a cheap, correct hardening (visibility,
  nil-vs-false, a11y, comment accuracy), FIX it.
- Reserve drops for findings that are provably wrong, or whose fix would break intent. Note the
  one-line reason for each drop.
- Fix the keepers one at a time, smallest change, matching surrounding style, then run the narrow
  tests plus the linter.

## Report

```
## Copilot review — <branch>
Substantive fixed (N):
- <file:line> — <what> -> <the fix>
Nitpicks fixed / parked (M):
- <file:line> — <what> -> <fix | parked, reason>
Dropped as wrong (K):
- <file:line> — <claim> | reason it does not hold
Verified: <narrow tests + linter>
```

## How it fits the workflow

This is one of three parallel review voices, run them together and reconcile:

1. **copilot-review** (this skill): blind, diff-only, Copilot-style nits.
2. **codex** (`codex exec` under rule-44): independent correctness/security/regression pass.
3. **rule-44 deep review** (self or specialist subagent): the load-bearing dimension walk.

Converge when the context-rich filter finds nothing real left to fix across all three. The blind
pass will always emit some nitpicks by nature; convergence is about the filtered result, not zero
raw findings. Fixing the small stuff here is exactly what stops the real GitHub Copilot bot from
posting it after you push.
