-- Teams Relay proposes for a project, which the owner reviews and approves
-- in the setup page or from a Slack card. Nothing reaches the team until an
-- owner approves; the proposal row keeps what was proposed, the fingerprint
-- of the team it was proposed against, and the exact snapshot applied.
--
-- Every table carries a NOT NULL workspace_id foreign key (AP-8).

ALTER TABLE personas ADD COLUMN written_by_relay BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE team_proposals (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id     UUID        NOT NULL,
  requested_by   TEXT        NOT NULL,
  -- 'page', or 'slack' with the thread that asked and, once posted, the card.
  source         TEXT        NOT NULL CHECK (source IN ('page', 'slack')),
  slack_channel  TEXT,
  slack_thread   TEXT,
  card_dispatch_id TEXT,
  card_message_ts  TEXT,
  status         TEXT        NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'ready', 'failed', 'approved', 'rejected', 'superseded')),
  -- The checked, scrubbed rows Relay proposed (see src/projects/proposals.ts).
  rows           JSONB,
  -- A hash of the members, project folder and repos, and persona texts when proposed.
  fingerprint    TEXT,
  -- Exactly what an approval applied: rows and new persona texts, for recovering files.
  applied        JSONB,
  error          TEXT,
  decided_by     TEXT,
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source = 'page' OR (slack_channel IS NOT NULL AND slack_thread IS NOT NULL)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);

-- One running proposal per project, held by the database.
CREATE UNIQUE INDEX team_proposals_one_running ON team_proposals (project_id) WHERE status = 'running';
CREATE INDEX team_proposals_project_idx ON team_proposals (workspace_id, project_id, created_at DESC);
