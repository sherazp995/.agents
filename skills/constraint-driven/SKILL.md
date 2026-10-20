---
name: constraint-driven
description: Write a project's quality bar down as CONSTRAINTS.md (a floor every change must meet, numbered limits each backed by a command, ratchets that must not get worse, and dated exceptions) and catch diffs that quietly lower it, such as new eslint-disable, rubocop:disable or @ts-ignore lines, skipped or deleted tests, stripped assertions, empty rescues, or a threshold edited down. Use when the user says "set up constraints", "define our standards" or "add quality gates", when an agent keeps silencing checks to get to green, or when choosing a coverage or performance number. When a repo already has CONSTRAINTS.md, read and follow it; doing-substantial-work and general-review do.
---

# Constraint-driven development

Rules in prose get forgotten at the end of a session. This skill writes **this project's** bar into a file with commands behind it, so any agent on any harness can check it, and a change to it shows up in review.

## When a repo already has CONSTRAINTS.md

Read it before writing code (`doing-substantial-work` step 1) and before reviewing (`general-review` step 1). Run its fast checks on changed files as plan check commands. Never edit it to make a change pass; propose the change to the user instead.

## Setting it up

The interview needs a live user. In non-interactive runs, apply the floor only and report that the rest needs a human.

### 1. Detect before you ask

Read the stack, test runner, linters (`.rubocop.yml`, `eslint.config.*`, `biome.json`), CI workflows, current coverage output and the repo's `AGENTS.md`/`CLAUDE.md`. Report what you found in two lines.

### 2. Four questions, one at a time, each with a default

Use the `interview-me` format (one question, a guess attached). "I don't know" takes the default.

1. **Which dimensions beyond the floor?** Coverage of changed lines, security scanning, performance budgets, accessibility, architecture boundaries. Default: coverage and security. Say the cost: performance and accessibility need a running URL.
2. **Block or warn when a check fails mid-task?** Default: block on the floor, warn on the rest for two weeks.
3. **Target numbers, or measure today and hold the line?** Default: measure and hold (ratchet).
4. **Slowest check you'll tolerate at task end?** Default: 90 seconds; slower checks run in CI only.

Stop at four.

### 3. Write CONSTRAINTS.md at the repo root

```markdown
# Constraints

Last reviewed: <date> by <name>

## Floor (always enforced)

- No new suppressions: `rubocop:disable`, `eslint-disable`, `@ts-ignore`, `# noqa`, `# type: ignore`, `istanbul ignore`, `nosemgrep`, `gitleaks:allow`
- No skipped (`skip`, `xit`, `pending`, `.only`) or deleted tests without a reason in the commit
- No assertions removed from tests that stay
- No stubs that raise "not implemented", no empty `rescue`/`catch`
- No secrets in source
- This file is not weakened to make a change pass

## Enforced with numbers

| Dimension | Rule | Checked by | Runs at |
|-----------|------|------------|---------|
| Lint | Zero offenses on changed files | `bin/rubocop <files>` | task end |
| Secrets | No findings | `gitleaks detect --redact --no-banner` | CI |
| Coverage | Changed lines >= 80% | coverage report intersected with `git diff` | CI |

## Measured, not yet enforced

| Metric | Today | Direction |
|--------|-------|-----------|
| Project coverage | 62.4% | must not fall |

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|----|------|------|--------|-------|---------|
```

Every number has a reason and a command. A number with no command is an aspiration; leave it out or move it to "Measured". Prefer the de facto tool (rubocop, eslint, brakeman, bundler-audit, gitleaks with `--redact`, osv-scanner, axe, Lighthouse) over a hand-written checker, and keep at least one external check (not judged by the project's own tests).

Then add one line to the repo's `AGENTS.md` or `CLAUDE.md`: `Read CONSTRAINTS.md before writing code. Do not weaken it to make a change pass.` Show the user the diff; committing follows rule 54.

### 4. Defaults when the user has no number

| Constraint | Default | Why |
|------------|---------|-----|
| Coverage of changed lines | >= 80% | Forces a test, allows a config line |
| Project coverage | today's value, must not fall | No argument needed |
| Dependency vulnerabilities | nothing high or above | Below that is mostly noise |
| LCP / CLS | <= 2500 ms / <= 0.1 | Core Web Vitals "good" |
| Accessibility | zero critical or serious axe violations | Lower levels are debatable |
| Exception lifetime | 90 days | Long enough to plan the fix |

Never set a budget the code fails today; record today's value and ratchet instead.

## Guarding the bar (reviews)

Agents take the cheapest road to green. On every review of a repo with `CONSTRAINTS.md`, check the diff for:

1. **A threshold moved:** compare `CONSTRAINTS.md` with its state at the branch point.
2. **A test got easier:** skip markers added, a test file deleted, assertions pulled out.
3. **A checker got silenced:** any new suppression comment from the floor list.
4. **Unfinished work:** a raising stub, an empty rescue turning a failure into silence, a TODO in place of the code (rule 36).
5. **A new exception** nobody discussed, or one with no owner or expiry.

`git diff <base>...HEAD` is enough. Loosening the bar is a finding at medium or above; tightening it is fine.
