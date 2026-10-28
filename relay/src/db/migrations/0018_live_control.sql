-- FR-ATT-40: live control of an already-running Claude Code session.
--
-- The problem this solves, in the operator's own words: they want to type in
-- Slack and have it reach the session they are already sitting in, rather
-- than a fresh one Relay spawns. Section 24's answer is a tmux and pty proxy
-- Relay interposes in front of the session, which is phase 2 and a large
-- mechanism. This table is the small one that works today.
--
-- The insight is that Relay does not have to inject anything. A running
-- Claude Code session can CONSUME work: it can run a command that blocks
-- until something arrives. So a thread can be marked live-controlled, and
-- for such a thread Relay parks the message here instead of running its own
-- agent loop. The waiting session picks it up, does the work with all of its
-- own context, and posts the answer back through Relay.
--
-- That inverts section 24's design: the session pulls rather than Relay
-- pushing, which removes the pty proxy, the turn-taking race, and the
-- concurrent-writer fork entirely. Nothing ever resumes a live transcript,
-- so nothing can lose a turn.
--
-- Delivery is Postgres LISTEN/NOTIFY rather than polling, so a waiting
-- session wakes on the insert rather than on a timer.

-- Marks a session as live-controlled by an external consumer. Nullable and
-- additive, like every session column before it: absent means Relay runs its
-- own loop, which is every session that predates this feature.
ALTER TABLE sessions ADD COLUMN live_control_claimed_at timestamptz;

CREATE TABLE live_control_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id     uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  principal_id   text NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  -- The operator's own text. This is the one place Relay deliberately stores
  -- inbound message text: the whole point is to hand it to a consumer, and a
  -- message that cannot be read cannot be acted on. It is never logged, per
  -- FR-SEC-1, and it is deleted once claimed.
  body           text NOT NULL,
  reply_ref      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Set when a consumer takes it, so two waiting consumers cannot both act
  -- on one message. Claiming is a single UPDATE ... RETURNING, so the race
  -- is resolved by Postgres rather than by consumer discipline.
  claimed_at     timestamptz
);

-- Answers "is there anything waiting for me" without a scan. Partial on
-- unclaimed, since a claimed message is history.
CREATE INDEX live_control_messages_pending_idx
  ON live_control_messages (session_id, created_at)
  WHERE claimed_at IS NULL;

CREATE INDEX live_control_messages_workspace_idx ON live_control_messages (workspace_id);
