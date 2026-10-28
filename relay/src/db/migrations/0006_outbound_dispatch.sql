-- Task 4 of the P0.3 orchestrator milestone: the durable outbound
-- dispatcher (src/dispatch/outbound.ts), closing PRE-1. ProgressReporter's
-- edit depends on the message id its own post returns, but Outbox drains
-- rows independently, so an edit's dependency on its post's real platform
-- id must be resolved at drain time rather than assumed from row order.
--
-- This table is that resolution. OutboundDispatcher mints a random
-- dispatch id for every post or upload action before it is ever enqueued,
-- hands that id back to the caller in place of a real platform message id,
-- and writes the real result here, keyed by that same dispatch id, once
-- the real adapter actually delivers it. A dependent edit looks itself up
-- here before it is allowed to reach the real adapter; if no row exists
-- yet, delivery of the edit fails and is retried through Outbox's own
-- backoff path, never sent against a message that does not exist yet.
--
-- Nothing here is added NOT NULL onto an existing table, so this migration
-- carries none of the non-empty-table hazard 0003_orchestrator.sql had to
-- guard against: it is a brand new table, so every column can be NOT NULL
-- from the first row.
CREATE TABLE outbound_dispatch_refs (
  dispatch_id  uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  ref          jsonb NOT NULL,
  resolved_at  timestamptz NOT NULL DEFAULT now()
);

-- Scoped lookups and any future cleanup by workspace, mirroring
-- outbox_workspace_idx in 0002_chat.sql for the same reason: nothing
-- queries this table today without a workspace in hand, but an unindexed
-- workspace_id would become a sequential scan the moment something does.
CREATE INDEX outbound_dispatch_refs_workspace_idx ON outbound_dispatch_refs (workspace_id);
