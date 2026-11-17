-- Failover between two laptops sharing one database (README, "Failover").
--
-- failover_hosts and failover_lease describe the laptops running this
-- database, not any workspace's data, so like schema_migrations they carry
-- no workspace_id (test/db/migrate.test.ts, AP-8).
--
-- failover_hosts: one row per laptop that has run Relay against this
-- database: its home folder (to map stored paths between usernames), the
-- newest migration its build knows (an older build refuses to answer), and
-- when it was last seen (a laptop finishing its turns after losing the
-- record keeps this fresh, so the other laptop does not treat its workers as
-- dead). wants_back_at is the preferred laptop asking for the record.
CREATE TABLE failover_hosts (
  name             text        PRIMARY KEY CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
  home             text        NOT NULL CHECK (home LIKE '/%'),
  build_migration  text        NOT NULL,
  preferred        boolean     NOT NULL DEFAULT false,
  wants_back_at    timestamptz,
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);

-- The one "who is answering" record. Every grant bumps generation, so a
-- laptop that lost the record is fenced out by comparing generations, and
-- renewals and expiry use the database clock, never a laptop's.
CREATE TABLE failover_lease (
  id          smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder      text        REFERENCES failover_hosts (name),
  generation  bigint      NOT NULL DEFAULT 0,
  renewed_at  timestamptz,
  expires_at  timestamptz
);
INSERT INTO failover_lease (id) VALUES (1);

-- The laptop each worker process runs on; a laptop signals, waits on and
-- recovers only its own. NULL is a row written before failover existed: its
-- process ids may belong to either laptop, so with failover on it is never
-- signalled, and its task is only fenced once every other laptop is gone.
ALTER TABLE autonomous_tasks ADD COLUMN worker_host text;
ALTER TABLE team_assignments ADD COLUMN worker_host text;
-- A reminder task runs only on the laptop that took the reminder, because it
-- runs as the person that laptop's config names.
ALTER TABLE autonomous_tasks ADD COLUMN pinned_host text;
-- An attached terminal chat lives on one laptop's disk.
ALTER TABLE sessions ADD COLUMN engine_host text;

-- Persona text, so both laptops read the same persona. NULL means the text
-- is still only in the file on the laptop that made it.
ALTER TABLE personas ADD COLUMN body text;

-- A Slack task thread's Claude chat, saved after each turn so the other
-- laptop can resume it. revision only goes up; a save carrying an older one
-- is refused. archive is a gzipped tar of the chat file and its folder.
CREATE TABLE failover_chats (
  task_id      uuid        PRIMARY KEY REFERENCES autonomous_tasks (id) ON DELETE CASCADE,
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id   text        NOT NULL,
  cwd          text        NOT NULL CHECK (cwd LIKE '/%'),
  revision     bigint      NOT NULL CHECK (revision > 0),
  archive      bytea       NOT NULL,
  size_bytes   integer     NOT NULL CHECK (size_bytes >= 0),
  saved_by     text        NOT NULL,
  saved_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX failover_chats_saved_at_idx ON failover_chats (saved_at);

-- A file a session queues for Slack, held in the database so whichever
-- laptop is answering can post it. The outbox action names its id.
CREATE TABLE outbox_files (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid       NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  filename    text        NOT NULL,
  content     bytea       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
