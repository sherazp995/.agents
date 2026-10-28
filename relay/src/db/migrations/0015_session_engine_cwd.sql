-- Records which folder a session's engine chat belongs to, so a Slack thread
-- resolves to both the chat to resume and the directory to resume it in.
--
-- The row already carried the other two thirds of that mapping: thread_ref is
-- the Slack thread the operator is typing in, and engine_session_id (added in
-- 0011) is the Claude Code chat id that `claude --resume` consumes. What was
-- missing is where to run it. The working directory is not cosmetic: it is
-- what gives a resumed session that project's own skills, agents, and
-- settings, including the ones that are gitignored. Resuming the right chat
-- in the wrong directory produces a session that looks correct and behaves
-- differently, which is worse than failing outright.
--
-- Read from the transcript's own cwd field at attach time, never decoded from
-- the ~/.claude/projects directory name, because that encoding is lossy:
-- /Users/you/.projects/relay becomes -Users-you--projects-relay, so a
-- separator and a dot collapse to the same character and the original path
-- cannot be recovered. See src/sessions/discovery.ts.
--
-- ADDITIVE ONLY, nullable, no default, following 0011 exactly. A NOT NULL
-- column with no default aborts against a non-empty table, and the tests
-- migrate an empty database so they would never catch it. The production
-- database is not empty. Every session that predates this column is a Relay
-- managed session running in Relay's own working directory, and NULL states
-- that honestly rather than backfilling a guess.
ALTER TABLE sessions ADD COLUMN engine_cwd text;

-- Answers "is there already a session for this folder, and which chat is it"
-- without scanning. Scoped by workspace_id per AP-8, and partial on active
-- sessions because an archived session is not a candidate to route new work
-- into.
CREATE INDEX sessions_workspace_engine_cwd_active_idx
  ON sessions (workspace_id, engine_cwd)
  WHERE state = 'active' AND engine_cwd IS NOT NULL;
