-- Durable outbound queue for Task 5's Outbox: one row per ChatAction,
-- written before anything is attempted, so a crash between enqueue and
-- send loses nothing rather than losing the action along with the process.
-- Carries workspace_id, NOT NULL with a foreign key to workspaces, per AP-8.
CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  adapter         text NOT NULL,
  action          jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

CREATE INDEX outbox_workspace_idx ON outbox (workspace_id);

-- Backs the drain scan: pending rows ready to send, ordered by readiness.
-- Partial so the index stays small as sent and failed rows accumulate.
CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at) WHERE status = 'pending';

-- resolvePrincipal filters on workspace_id, platform, and platform_user_id,
-- exactly the columns 0001_init.sql already covers with the UNIQUE
-- (workspace_id, platform, platform_user_id) constraint on principals,
-- which Postgres backs with a unique index. No further index is needed for
-- that lookup, and the comparison is a plain text equality, which Postgres
-- performs case sensitively by default, matching Slack's case sensitive ids.
