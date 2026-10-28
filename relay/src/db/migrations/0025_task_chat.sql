-- The Claude Code chat an autonomous task took over from a closed attached
-- chat: its id and folder. Turns resume that chat (any Claude login sharing
-- its projects folder can), run in its folder, and a turn that cannot
-- resume it is pointed at its transcript instead of starting blind.
ALTER TABLE autonomous_tasks ADD COLUMN chat_session_id text, ADD COLUMN chat_cwd text;
