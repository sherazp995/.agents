# CI-345: Strata admins see company-wide health scores

- Ticket: https://example.atlassian.net/browse/CI-345
- Branch: fix/strata-manager-insurance-fixes in ../cohabit-web-ci-345-strata-manager-insurance-fixes
- Plan file: ~/.agents/tmp/plans/cohabit-web-ci-345-strata-manager-insurance-fixes.md
- Status: Waiting for your decisions

## In short

A strata admin who has no buildings of their own sees "Not enough data" for health scores on the dashboard, even though their company has many scored buildings. We will give admins health scores across every company building. Strata admins notice the difference; strata managers keep seeing their own buildings.

## Decisions for you

### 1. Dashboard speed for admins with large portfolios

- Option A: work out health scores for every company building on each dashboard load, and measure load time on a large company before the PR.
- Option B: also add caching in this ticket.
- **We recommend A**, because caching is a bigger change the ticket does not ask for.
- If you approve without choosing: we build A and report the numbers in the PR.

## How it works today

Dashboard health score for a strata admin with no buildings of their own.

```text
( Strata admin opens Dashboard )
              |
              v
[ BUG: health scores use only buildings connected to the admin ]
              |
              v
< Any of those buildings scored? >--no-->[ BUG: "Not enough data" ]
              | yes
              v
[ Average, Highest and Lowest from own buildings only ]
```

## How it will work

```text
( Strata admin opens Dashboard )
              |
              v
[ CHANGED: admin's health scores use every company building ]
              |
              v
< Any company building scored? >--no-->[ "Not enough data" ]
              | yes
              v
[ Average, Highest and Lowest across the company ]

  Strata managers: unchanged, own buildings only.
```

## What changes

| Area | Today | After | Why |
|---|---|---|---|
| Dashboard health score, strata admin | Own buildings only; "Not enough data" when they have none | Every company building | Ticket bullet 1 |
| Dashboard health score, strata manager | Own buildings | Own buildings, unchanged | Only admins were asked to widen |

## Confirmed intent

- Outcome: strata admins see health score average, highest and lowest across the whole company.
- User: strata admins on the SM dashboard.
- Why now: admins with no personal buildings see "Not enough data".
- Success: an admin with no own buildings sees company numbers; managers see no change.
- Constraint: no schema change; no data beyond what the admin can already see.
- Out of scope: the health score calculation itself, caching, card layout.

## Steps

- [ ] 1. Give strata admins health scores across every company building, and keep strata managers on their own buildings.
  - Files: app/controllers/dashboard_controller.rb, spec/controllers/dashboard_controller_spec.rb
  - Done when: an admin with no buildings of their own sees the company average, and a manager still sees only their own buildings, in the dashboard controller spec.
- [ ] 2. Browser check as a strata admin and a strata manager, and time the admin dashboard on a large company.
  - Files: none
  - Done when: both roles show the expected numbers and the timing is in the PR.

## Tests

- An admin with no buildings of their own and two company buildings scored 80 and 40 sees average 60, highest 80, lowest 40. (`spec/controllers/dashboard_controller_spec.rb`)
- A manager with one own building scored 70 does not see an unconnected company building scored 20. (`spec/controllers/dashboard_controller_spec.rb`)

## Checks

```
TEST_ENV_NUMBER=345 bundle exec rspec spec/controllers/dashboard_controller_spec.rb
bundle exec rubocop app/controllers/dashboard_controller.rb spec/controllers/dashboard_controller_spec.rb
```

## Risks and not doing

Risks:
- Slow dashboard for a large company: measured before the PR (decision 1).

Not doing:
- Caching dashboard numbers.

## Appendix

### Root cause

- Health score stats loop over `current_user.current_buildings` even for strata admins: `app/controllers/dashboard_controller.rb:128-135`.
- Every other dashboard number uses the company's buildings for an admin: `app/controllers/base_controller.rb:27-37`.

### Request (verbatim)

> Can we change this so that a Strata Admin can see whole portfolio numbers? both from average health score, as well as high and low.

## Log

- 2026-10-29: plan written.
