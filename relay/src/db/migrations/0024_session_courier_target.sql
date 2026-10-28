-- The exact Claude Code chat (its ListAgents "name [ref]") a thread's
-- messages are pushed to. Set by `relay notify --peer`; without it the
-- courier matches the chat by working directory, which is ambiguous when
-- two chats share a folder.
ALTER TABLE sessions ADD COLUMN courier_target text;
