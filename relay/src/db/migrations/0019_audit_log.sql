-- FR-AUD-1, FR-AUD-2: the append-only audit log and its tamper evidence.
--
-- ONE CHAIN PER WORKSPACE, not one globally. AP-8 requires every domain
-- table to carry a workspace_id, and here that is more than a convention:
-- two workspaces sharing a chain would let activity in one be inferred from
-- sequence gaps in the other, and an integrity failure in one would report
-- the whole log as broken. So `sequence` is unique WITHIN a workspace and
-- each workspace's chain is verified on its own.
--
-- `detail` is already redacted when it arrives: FR-AUD-3 requires redaction
-- on WRITE, so nothing sensitive is ever persisted in the clear and a
-- database dump carries no credential values.

CREATE TABLE IF NOT EXISTS audit_entries (
  id            BIGSERIAL   PRIMARY KEY,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence      BIGINT      NOT NULL,
  run_id        TEXT,
  kind          TEXT        NOT NULL,
  actor         TEXT        NOT NULL,
  detail        JSONB       NOT NULL,
  at            TIMESTAMPTZ NOT NULL,
  previous_hash TEXT        NOT NULL,
  hash          TEXT        NOT NULL,
  -- A gap is a deletion and a duplicate is impossible. The chain is verified
  -- by walking hashes; this is a second, cheaper way to notice the same
  -- damage.
  UNIQUE (workspace_id, sequence),
  UNIQUE (workspace_id, hash)
);

CREATE INDEX IF NOT EXISTS audit_entries_run_id_idx ON audit_entries (workspace_id, run_id);
CREATE INDEX IF NOT EXISTS audit_entries_kind_idx ON audit_entries (workspace_id, kind);
CREATE INDEX IF NOT EXISTS audit_entries_at_idx ON audit_entries (workspace_id, at);

-- FR-AUD-2's periodically signed chain heads. Their own table rather than a
-- column on the entry, because a head is signed on a schedule rather than
-- per entry, and a signature stored inside the thing it signs is a shape
-- that invites confusion later.
CREATE TABLE IF NOT EXISTS audit_chain_heads (
  id           BIGSERIAL   PRIMARY KEY,
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence     BIGINT      NOT NULL,
  hash         TEXT        NOT NULL,
  signed_at    TIMESTAMPTZ NOT NULL,
  signature    TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_chain_heads_sequence_idx ON audit_chain_heads (workspace_id, sequence DESC);
