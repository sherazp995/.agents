-- A task started by a Slackbot reminder (src/chat/slack/reminder.ts) is
-- read-only for its whole life: set when the task is created, never cleared.
-- Existing tasks, and every task a person starts, stay as they are.
ALTER TABLE autonomous_tasks ADD COLUMN read_only boolean NOT NULL DEFAULT false;
