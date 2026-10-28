-- Task 2 of the P0.3 orchestrator milestone: sessions. Closes PRE-5 by
-- giving src/sessions/store.ts's findOrCreateSession a table to bind a
-- chat thread to, and gives src/sessions/context.ts's sessionRunContext a
-- session row whose four identifiers can ride a bound RunContext, per
-- FR-OBS-1.
--
-- thread_ref is the stable identity of a chat thread, per FR-SL-3: the
-- reply thread IS the session. It is an opaque text value the adapter
-- composes (for Slack, channel and thread ts joined with a separator),
-- not a structured (channel, thread) pair split across two columns. A
-- single comparable value is what a single unique index and a single
-- equality lookup need; splitting it into two columns would only move
-- that composition into every query instead of once, at the adapter
-- boundary, where the platform specific format is already known. This is
-- also what src/chat/contract.ts's sessionRefFor already returns before an
-- adapter turns it into an outbound reply target: a ChatRef carrying a
-- channel and a thread that, for Slack, are message timestamps.
--
-- principal_id is the principal that opened the session, recorded once at
-- creation. It is not reassigned on later finds; a session's opener does
-- not change because a different principal later replies in the same
-- thread.
CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  principal_id   text NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  adapter        text NOT NULL,
  thread_ref     text NOT NULL,
  state          text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_workspace_idx ON sessions (workspace_id);

-- Backs findOrCreateSession's upsert and Task 3's "is this thread a known
-- session" lookup with a single indexed query, per the Task 2 brief.
-- Scoped to workspace_id and adapter, not thread_ref alone, so the same
-- thread_ref string under two workspaces (AP-8) or two adapters can never
-- collide, and partial on state = 'active' so archiving a session frees
-- its thread_ref for reuse rather than blocking a fresh session from ever
-- being created in a thread whose earlier session was archived. That
-- partial condition is the mechanism behind archiveSession's documented
-- behaviour in src/sessions/store.ts: a later findOrCreateSession call for
-- an archived thread's ref creates a new row rather than resurrecting the
-- archived one, because the archived row no longer participates in this
-- index at all.
CREATE UNIQUE INDEX sessions_workspace_adapter_thread_active_key
  ON sessions (workspace_id, adapter, thread_ref)
  WHERE state = 'active';
