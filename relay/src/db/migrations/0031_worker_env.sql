-- Envs for the sessions Relay starts, kept in the shared database so each
-- laptop picks its own (README, "Envs for Relay's sessions").
--
-- worker_env_readers: one row per laptop key. A laptop makes a key pair the
-- first time it starts, keeps the private half in its own keystore and
-- publishes the public half here with its failover host name ('' when
-- failover is off). Nothing secret is ever shared between laptops.
--
-- worker_env: one row per stored env, scoped by host and folder ('' means
-- every host or every folder; NOT NULL so the unique scope also holds for
-- the defaults). updated_at moves on every replace, so a running session
-- can tell its envs changed without opening any value.
--
-- worker_env_copies: the value sealed for each laptop key allowed to read
-- it: a host entry only for that host's keys, every other entry for all.
CREATE TABLE worker_env_readers (
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint   text        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  public_key    text        NOT NULL,
  host          text        NOT NULL DEFAULT '' CHECK (host = '' OR host ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, fingerprint)
);

CREATE TABLE worker_env (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  host          text        NOT NULL DEFAULT '' CHECK (host = '' OR host ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
  folder        text        NOT NULL DEFAULT '' CHECK (folder = '' OR folder = '~' OR folder LIKE '~/%' OR folder LIKE '/%'),
  name          text        NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, host, folder, name),
  UNIQUE (workspace_id, id)
);

CREATE TABLE worker_env_copies (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id      uuid NOT NULL,
  fingerprint   text NOT NULL,
  sealed        text NOT NULL,
  PRIMARY KEY (entry_id, fingerprint),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES worker_env (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, fingerprint) REFERENCES worker_env_readers (workspace_id, fingerprint) ON DELETE CASCADE
);

CREATE INDEX worker_env_copies_reader ON worker_env_copies (workspace_id, fingerprint);
