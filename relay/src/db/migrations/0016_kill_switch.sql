-- Task 6 of the P0.4 policy-and-approvals milestone: FR-POL-9's global kill
-- switch. Persisted so "refuses new work until cleared" survives an
-- orchestrator restart, not just an in-process flag a crash would silently
-- reset to cleared.
--
-- Brand new table, so, like 0007_agent_runs.sql, it carries none of the
-- nullable-then-backfill-then-constrain hazard 0003_orchestrator.sql had to
-- guard against on an already-populated table: every column here, including
-- workspace_id, is NOT NULL (or constrained) from the very first row.
--
-- ONE ROW PER WORKSPACE, NOT A SINGLETON GLOBAL FLAG. FR-POL-9 calls this a
-- "global" kill switch, but "global" describes its blast radius WITHIN a
-- workspace (every run, every lock, every new request), not a cross-tenant
-- scope: nothing in FR-POL-9's phase-0 acceptance criteria asks one
-- operator's kill to also halt a different workspace's runs, and this
-- milestone's single-operator, single-workspace deployment makes the
-- distinction moot in practice today. Scoping by workspace_id keeps AP-8's
-- guarantee intact (every domain table carries tenancy from its first
-- migration) and leaves a genuinely cross-workspace "kill everything" as a
-- distinct, later decision, rather than collapsing it into this table's
-- shape now.
CREATE TABLE kill_switch (
  workspace_id  uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  engaged       boolean NOT NULL DEFAULT false,
  reason        text,
  engaged_at    timestamptz,
  engaged_by    text,
  cleared_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- engaged=true with no reason or engaged_at is not a state this table
-- should ever be able to represent: src/killswitch.ts's own store sets all
-- three together, in one statement, every time it engages. Clearing
-- deliberately does NOT null out reason/engaged_at (see that file for why:
-- the last engagement's history is worth keeping), so the false branch
-- below imposes no constraint on them.
ALTER TABLE kill_switch
  ADD CONSTRAINT kill_switch_engaged_consistency
  CHECK (
    engaged = false OR (reason IS NOT NULL AND engaged_at IS NOT NULL)
  );
