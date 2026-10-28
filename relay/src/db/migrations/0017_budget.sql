-- Task 7 of the P0.4 policy-and-approvals milestone: FR-POL-7's spend
-- caps. FR-POL-7's full text also names token caps, per-origin request
-- rate limits, per-capability call-count caps, and a global-per-day
-- currency cap; per the Task 7 brief, this task scopes to the three
-- currency caps it names explicitly: per-run, per-session, and
-- per-principal-per-day. See the task report for that narrowing stated as
-- a brief interpretation, not silently assumed.
--
-- budget_ledger is an append-only record of every spend event, not three
-- separately maintained running totals. src/budget/meter.ts's recordSpend
-- SUMs this table on every call rather than incrementing three counters by
-- hand, so the three scopes can never drift out of sync with each other or
-- with reality the way three independently updated counters could if a
-- caller updated one and forgot another. Both new tables are brand new, so
-- neither carries the nullable-then-backfill-then-constrain hazard
-- 0003_orchestrator.sql had to guard against on an already-populated table.
CREATE TABLE budget_ledger (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id       uuid NOT NULL,
  session_id   uuid NOT NULL,
  principal_id text NOT NULL,
  amount_usd   numeric NOT NULL CHECK (amount_usd >= 0),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX budget_ledger_workspace_idx ON budget_ledger (workspace_id);

-- Backs the three SUM queries src/budget/meter.ts's recordSpend runs on
-- every call: per-run and per-session are plain equality lookups; the
-- principal-day index carries occurred_at as its second column because that
-- scope's query also filters on a caller-computed [start, end) window, per
-- src/budget/meter.ts's own utcDayBounds and its header comment on why the
-- day boundary is computed in application code rather than left to
-- Postgres's own session timezone.
CREATE INDEX budget_ledger_run_idx ON budget_ledger (run_id);
CREATE INDEX budget_ledger_session_idx ON budget_ledger (session_id);
CREATE INDEX budget_ledger_principal_occurred_idx ON budget_ledger (principal_id, occurred_at);

-- Composite foreign keys, mirroring 0005_session_principal_workspace.sql's
-- and 0010_parent_child_workspace_consistency.sql's own fixes applied here
-- from the start: a ledger row's run_id, session_id, and principal_id must
-- each describe the same tenant as its own workspace_id. Target the
-- composite unique constraints those two migrations and 0005 already added
-- (runs_id_workspace_id_key, sessions_id_workspace_id_key,
-- principals_id_workspace_id_key).
ALTER TABLE budget_ledger
  ADD CONSTRAINT budget_ledger_run_workspace_fkey
  FOREIGN KEY (run_id, workspace_id) REFERENCES runs (id, workspace_id) ON DELETE CASCADE;

ALTER TABLE budget_ledger
  ADD CONSTRAINT budget_ledger_session_workspace_fkey
  FOREIGN KEY (session_id, workspace_id) REFERENCES sessions (id, workspace_id) ON DELETE CASCADE;

ALTER TABLE budget_ledger
  ADD CONSTRAINT budget_ledger_principal_workspace_fkey
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id);

-- budget_run_exemptions is FR-ORC-7's "exceeding a cap pauses the run and
-- asks for authorisation" remedy, scoped exactly the way the task brief
-- requires: "approving raises the cap for that run only, never permanently
-- and never for a sibling." One row per (run_id, scope): a run's own
-- effective cap for that scope, once raised, is the greater of the
-- caller-supplied policy cap and this row's raised_to_usd, per
-- src/budget/meter.ts's own recordSpend. Nothing here touches the
-- underlying policy-configured cap value or any OTHER run's row, which is
-- what makes "never permanently" and "never for a sibling" true by table
-- design rather than by caller discipline: a query for a different run_id
-- simply finds no matching row here, regardless of scope.
CREATE TABLE budget_run_exemptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id                  uuid NOT NULL,
  scope                   text NOT NULL CHECK (scope IN ('run', 'session', 'principal_day')),
  raised_to_usd           numeric NOT NULL CHECK (raised_to_usd >= 0),
  granted_by_principal_id text NOT NULL,
  granted_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, scope)
);

CREATE INDEX budget_run_exemptions_workspace_idx ON budget_run_exemptions (workspace_id);

ALTER TABLE budget_run_exemptions
  ADD CONSTRAINT budget_run_exemptions_run_workspace_fkey
  FOREIGN KEY (run_id, workspace_id) REFERENCES runs (id, workspace_id) ON DELETE CASCADE;

ALTER TABLE budget_run_exemptions
  ADD CONSTRAINT budget_run_exemptions_granted_by_workspace_fkey
  FOREIGN KEY (granted_by_principal_id, workspace_id) REFERENCES principals (id, workspace_id);
