# <TICKET>: <what changes, in plain words>

- Ticket: <link>
- Branch: <branch> in <worktree>
- Plan file: <full path>
- Status: Waiting for your decisions
- Advisor status: <only for a plan made with rethink: agreed, open points or advisor unavailable>

## In short

<At most five sentences. What is broken or missing today. What we will do. Who notices the difference.>

## Decisions for you

### 1. <The question, as a short heading>

- Option A: <what it means for the user>
- Option B: <what it means for the user>
- **We recommend A**, because <reason>.
- If you approve without choosing: <what the build does>.

Settled in the plan:

- <straightforward choice>: <one-line reason (ticket text, repo pattern, dependency, safe default)>

## How it works today

<One-line caption for the flow.>

```text
( Start )
    |
    v
[ Step ]
    |
    v
< Question? >--no-->[ BUG: what goes wrong ]
    | yes
    v
( End )
```

## How it will work

```text
( Start )
    |
    v
[ CHANGED: step ]
    |
    v
( End )
```

## What changes

| Area | Today | After | Why |
|---|---|---|---|
| <page or feature> | <what happens now> | <what will happen> | <reason> |

## Confirmed intent

- Outcome:
- User:
- Why now:
- Success:
- Constraint:
- Out of scope:

## Steps

- [ ] 1. <Plain sentence.>
  - Files: <paths>
  - Done when: <test or check that proves it>

## Tests

- <Plain-words behaviour>. (`spec/...`)

## Checks

```
<exact commands>
```

## Risks and not doing

Risks:
- <risk>: <how we guard it>

Not doing:
- <out of scope item>

Follow-up ticket suggestions:
- <pre-existing issue or out-of-scope improvement>: `path:line`

## Appendix

### Root cause

- <claim>: `path:line`

### Overlap with open PRs

- <PR>: <shared files or none>

### Request (verbatim)

> <ticket text>

## Log

- <date>: plan written.
