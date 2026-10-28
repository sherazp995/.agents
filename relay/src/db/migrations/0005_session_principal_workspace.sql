-- Task 2 fix round 1: closes the tenancy hole a reviewer found in
-- 0004_sessions.sql. sessions.principal_id foreign-keys to principals(id)
-- and sessions.workspace_id foreign-keys to workspaces(id) separately, but
-- nothing stops the two from pointing at a principal that actually belongs
-- to a different workspace than the session claims. principals(id) alone
-- is globally unique, not scoped per workspace, so a session could bind a
-- principal from workspace A while itself carrying workspace B's id.
--
-- Not exploitable today, since nothing in this milestone yet calls
-- findOrCreateSession from a real caller, but Task 8 will, and this closes
-- the hole before anything is wired to fall into it.
--
-- principals.id is already the primary key, so every existing row already
-- has a unique id on its own; pairing it with workspace_id cannot make an
-- already-unique column collide with itself. This UNIQUE constraint is
-- therefore satisfiable by any pre-existing principals data unconditionally,
-- unlike 0003_orchestrator.sql's workspaces columns, which needed a
-- nullable-then-backfill step because NOT NULL with no default can fail
-- against existing rows. A composite unique constraint over an already
-- unique column has no such hazard.
ALTER TABLE principals
  ADD CONSTRAINT principals_id_workspace_id_key UNIQUE (id, workspace_id);

-- The composite foreign key below is what a pre-existing mismatched row
-- would violate, so that risk is checked and reported explicitly here
-- rather than assumed away. sessions is a table this same milestone
-- introduced in 0004_sessions.sql, so no environment should hold a
-- mismatched row, but the tests in this project migrate an empty database
-- and would not catch a real deployment that somehow did, so this fails
-- loudly instead of silently corrupting or silently skipping the fix.
--
-- A PL/pgSQL anonymous code block with an explicit RAISE would read more
-- clearly, but the migration runner (src/db/migrate.ts) rejects any
-- migration file that contains its own transaction control keyword
-- anywhere in the file, including inside a comment or a procedural block,
-- and such a block's opening and closing keywords would trip that guard
-- even though neither is a transaction statement. This division by zero
-- trick reaches the same outcome in plain SQL: the divisor is 1 when no
-- mismatched row exists and 0 when at least one does, so the migration
-- itself fails with a division by zero error precisely when the guard
-- needs to fire.
SELECT 1 / (CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END)
FROM sessions s
JOIN principals p ON p.id = s.principal_id
WHERE p.workspace_id != s.workspace_id;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_principal_workspace_fkey
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id);
