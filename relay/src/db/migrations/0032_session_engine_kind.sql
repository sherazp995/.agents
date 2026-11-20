-- Which kind of chat a linked thread belongs to: a Claude chat (every link
-- before this column) or a `relay codex` chat. Written in the same statement
-- as engine_session_id, engine_cwd and engine_host, so a thread is never
-- linked to one kind of chat while recorded as the other: a Codex chat id
-- must never reach `claude --resume`, and a Claude chat open in the same
-- folder must never be taken for the Codex chat.
ALTER TABLE sessions ADD COLUMN engine_kind text NOT NULL DEFAULT 'claude' CHECK (engine_kind IN ('claude', 'codex'));
