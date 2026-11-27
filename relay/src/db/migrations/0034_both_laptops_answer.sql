-- Both laptops answer Slack at once (README, "Failover"). Slack hands each
-- event to one of the two Socket Mode connections, so the laptop that got it
-- saves it here before acknowledging it, decides which laptop it is for, and
-- passes it on through this table when that is the other one.
--
-- inbound_events only ever gains columns that have a default: a laptop on
-- the previous build may still be writing rows while this one migrates.
--
-- state: received (saved, not yet decided), forwarded (meant for
-- target_host, waiting for it to claim), accepted (a laptop is handling it;
-- never replayed), done (payload already erased). claim_generation rises on
-- every claim, so a slow laptop whose claim was taken back cannot also mark
-- the row accepted. secret holds a password popup's value, encrypted with
-- the laptops' shared forward key; it is erased with the payload.
CREATE TABLE inbound_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  dedupe_key        text        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN ('event', 'action', 'view')),
  received_by       text        NOT NULL,
  target_host       text,
  explicit          boolean     NOT NULL DEFAULT false,
  state             text        NOT NULL DEFAULT 'received' CHECK (state IN ('received', 'forwarded', 'accepted', 'done')),
  claimed_by        text,
  claim_generation  bigint      NOT NULL DEFAULT 0,
  payload           jsonb,
  secret            bytea,
  response          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX inbound_events_open_idx ON inbound_events (target_host, state) WHERE state IN ('received', 'forwarded');
CREATE INDEX inbound_events_created_idx ON inbound_events (created_at);

-- One Slack message arrives twice (app_mention and message) and the two can
-- land on different laptops. The first to accept it claims its channel:ts
-- key here; the key names the row that owns it, so a retry of that same row
-- may go ahead.
CREATE TABLE inbound_message_keys (
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  message_key   text NOT NULL,
  inbound_id    uuid NOT NULL REFERENCES inbound_events (id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, message_key)
);

-- The laptop a Slack thread belongs to: the one that handled its first
-- message. Plain follow-ups go there while it is ready; naming another
-- laptop never moves it (that laptop answers as a guest instead).
CREATE TABLE thread_hosts (
  workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  adapter       text        NOT NULL,
  thread_ref    text        NOT NULL,
  host          text        NOT NULL REFERENCES failover_hosts (name) ON DELETE CASCADE,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, adapter, thread_ref)
);

-- Threads from before this migration: the laptop their chat lives on, then
-- the laptop a reminder task is pinned to, then the laptop of its last worker.
INSERT INTO thread_hosts (workspace_id, adapter, thread_ref, host)
SELECT s.workspace_id, s.adapter, s.thread_ref, s.engine_host
  FROM sessions s JOIN failover_hosts h ON h.name = s.engine_host
 WHERE s.state = 'active' AND s.engine_host IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO thread_hosts (workspace_id, adapter, thread_ref, host)
SELECT s.workspace_id, s.adapter, s.thread_ref, COALESCE(t.pinned_host, t.worker_host)
  FROM sessions s
  JOIN autonomous_tasks t ON t.session_id = s.id
  JOIN failover_hosts h ON h.name = COALESCE(t.pinned_host, t.worker_host)
 WHERE s.state = 'active'
ON CONFLICT DO NOTHING;

-- A guest turn: a laptop named in a thread that belongs to the other one
-- answers there with its own session, chat and task. One active session per
-- thread becomes one per thread and guest laptop (NULL is the owner's).
ALTER TABLE sessions ADD COLUMN guest_host text;
DROP INDEX sessions_workspace_adapter_thread_active_key;
CREATE UNIQUE INDEX sessions_workspace_adapter_thread_active_key
  ON sessions (workspace_id, adapter, thread_ref, COALESCE(guest_host, ''))
  WHERE state = 'active';

-- The laptop that runs a team proposal, so starting one laptop fails only
-- its own cut off proposals. NULL is a proposal from before this migration.
ALTER TABLE team_proposals ADD COLUMN host text;

-- pause_requested_at: this laptop has migrations to apply and asks the other
-- to stop starting work. paused_at: this laptop has stopped for that request.
-- reminder_channels: the Slack reminder channels this laptop's config lists,
-- so a reminder the other laptop receives is passed to this one.
ALTER TABLE failover_hosts ADD COLUMN pause_requested_at timestamptz;
ALTER TABLE failover_hosts ADD COLUMN paused_at timestamptz;
ALTER TABLE failover_hosts ADD COLUMN reminder_channels text[] NOT NULL DEFAULT '{}';

-- The laptop that posted each Relay message with buttons, so a click the
-- other laptop receives is passed to the laptop whose work the buttons
-- belong to (an approval card, a session picker).
CREATE TABLE button_messages (
  workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  channel       text        NOT NULL,
  message_ts    text        NOT NULL,
  host          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, channel, message_ts)
);
