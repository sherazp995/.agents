-- Task 6 of the P0.3 orchestrator milestone: the agent loop's own tables.
-- Gives src/runs/store.ts a run row and a step row per attempted capability
-- call, backing AP-5 (a step is persisted before it executes and again
-- after it completes), FR-ORC-1 (every state transition persisted
-- transactionally with a monotonically increasing sequence number before
-- any externally visible side effect occurs), FR-ORC-8 (step and run
-- timeouts, recorded), and FR-ORC-9 (loop protection, recorded).
--
-- Both tables are brand new, so, like 0006_outbound_dispatch.sql, neither
-- carries the non-empty-table hazard 0003_orchestrator.sql had to guard
-- against with a nullable-then-backfill dance: every column here can be
-- NOT NULL from the very first row, including workspace_id, which is what
-- the AP-8 guard in test/db/migrate.test.ts checks for on every domain
-- table.
--
-- SCOPE DECISION on FR-ORC-1's sequence number, stated because a reviewer
-- should not have to reverse engineer it: only `steps.seq` carries an
-- explicit monotonically increasing sequence (a bigserial, assigned at
-- INSERT time, before src/agent/loop.ts ever invokes the corresponding
-- capability). `runs` has no equivalent column. A run transitions state a
-- handful of times over its lifetime, always driven by the single loop
-- instance that owns it, and is a single row rather than an append-only
-- log, so `updated_at` plus the transaction that produced it is sufficient
-- ordering for a run; there is no concurrent-writer scenario a run-level
-- sequence number would need to arbitrate that steps.seq does not already
-- cover for the finer-grained, actually-repeated unit (a step), which is
-- also the unit FR-ORC-9's "identical consecutive steps" detection reads
-- in seq order.
CREATE TABLE runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id          uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  principal_id        text NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  state               text NOT NULL DEFAULT 'queued'
                       CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead_letter')),
  plan                jsonb,
  dead_letter_reason  text,
  failure_reason      text,
  cost_usd            numeric,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  ended_at            timestamptz
);

CREATE INDEX runs_workspace_idx ON runs (workspace_id);
CREATE INDEX runs_session_idx ON runs (session_id);

-- Mirrors 0005_session_principal_workspace.sql's tenancy fix, applied here
-- from the start rather than as a follow-up patch: a run's principal_id and
-- workspace_id must describe the same tenant, and this composite foreign
-- key is what Postgres enforces that against, not application logic. It
-- targets principals_id_workspace_id_key, the composite unique constraint
-- 0005 already added.
ALTER TABLE runs
  ADD CONSTRAINT runs_principal_workspace_fkey
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id);

CREATE TABLE steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  seq          bigserial NOT NULL,
  capability   text NOT NULL,
  input        jsonb,
  state        text NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')),
  output       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  ended_at     timestamptz
);

CREATE INDEX steps_run_idx ON steps (run_id);
CREATE INDEX steps_workspace_idx ON steps (workspace_id);

-- Backs "read this run's steps in the order they actually happened", which
-- both the AP-5 ordering proof and FR-ORC-9's identical-consecutive-steps
-- detection need. seq is already globally unique on its own (bigserial),
-- so this index exists for the WHERE run_id = $1 ORDER BY seq access
-- pattern, not for uniqueness.
CREATE UNIQUE INDEX steps_run_seq_key ON steps (run_id, seq);
