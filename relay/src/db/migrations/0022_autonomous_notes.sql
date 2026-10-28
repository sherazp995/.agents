-- Relay's own notes for a task's next worker turn (an operation decided, a
-- verification gap, a correction). Kept apart from pending_events, which
-- hold what people wrote and are rendered to the worker as untrusted data.
ALTER TABLE autonomous_tasks ADD COLUMN pending_notes jsonb NOT NULL DEFAULT '[]';

-- QA checkouts relay created for this task under <RELAY_HOME>/tasks/<id>/qa/.
-- The guard allows the QA integration merge only inside one of these.
ALTER TABLE autonomous_tasks ADD COLUMN qa_checkouts text[] NOT NULL DEFAULT '{}';
