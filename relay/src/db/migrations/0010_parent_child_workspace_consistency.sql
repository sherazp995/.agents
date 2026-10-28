-- Gate fix, High 2: parent-child workspace consistency was unenforced for
-- runs -> sessions and steps -> runs. runs.workspace_id and
-- runs.session_id are independent columns, each foreign-keyed on its own,
-- so nothing stopped a run labelled workspace B from holding a session
-- that actually belongs to workspace A; the same shape of hole existed
-- between steps.workspace_id and steps.run_id. Mirrors exactly the fix
-- 0005_session_principal_workspace.sql already made for sessions ->
-- principals, applied here to the two composite relationships
-- 0007_agent_runs.sql introduced.
--
-- sessions.id and runs.id are already primary keys, so every existing row
-- already has a unique id on its own; pairing either with workspace_id
-- cannot make an already-unique column collide with itself. This UNIQUE
-- constraint is therefore satisfiable by any pre-existing data
-- unconditionally, the same reasoning 0005 already gives for the identical
-- shape of constraint on principals.
ALTER TABLE sessions ADD CONSTRAINT sessions_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE runs     ADD CONSTRAINT runs_id_workspace_id_key     UNIQUE (id, workspace_id);

-- The composite foreign keys below are what a pre-existing mismatched row
-- would violate, so that risk is checked and reported explicitly here
-- rather than assumed away, exactly like 0005's own guard. sessions, runs,
-- and steps are all tables this same milestone introduced, so no
-- environment should hold a mismatched row, but the tests in this project
-- migrate an empty database and would not catch a real deployment that
-- somehow did, so this fails loudly instead of silently corrupting or
-- silently skipping the fix. Same division-by-zero trick 0005 uses: the
-- migration runner rejects a file containing its own transaction control
-- keyword, which rules out a PL/pgSQL block with an explicit RAISE.
SELECT 1 / (CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END)
FROM runs r
JOIN sessions s ON s.id = r.session_id
WHERE s.workspace_id != r.workspace_id;

SELECT 1 / (CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END)
FROM steps st
JOIN runs r ON r.id = st.run_id
WHERE r.workspace_id != st.workspace_id;

ALTER TABLE runs
  ADD CONSTRAINT runs_session_workspace_fkey
  FOREIGN KEY (session_id, workspace_id) REFERENCES sessions (id, workspace_id);

ALTER TABLE steps
  ADD CONSTRAINT steps_run_workspace_fkey
  FOREIGN KEY (run_id, workspace_id) REFERENCES runs (id, workspace_id);
