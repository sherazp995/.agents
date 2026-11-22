-- The folder each Slack thread's shell is in (README, "Shell from Slack").
-- A `!` message runs its lines in this folder and saves the folder the last
-- successful line ended in, so `! cd x` carries to the next message, like a
-- terminal tab. It is the only thing the shell stores: nothing about jobs,
-- commands, output or passwords. Kept apart from sessions.engine_cwd, which
-- is where a thread's Claude or Codex chat resumes and must never move.
-- A row also makes the thread known to the Slack adapter, so unmentioned
-- replies (the next `!` message, `stop`) reach Relay.
CREATE TABLE shell_folders (
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  adapter       text        NOT NULL,
  thread_ref    text        NOT NULL,
  folder        text        NOT NULL CHECK (folder LIKE '/%'),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, adapter, thread_ref)
);
