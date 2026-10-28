-- A Slack thread is either DIRECT or GOVERNED, and it says which.
--
-- Direct means Relay is a relay: an ordinary `claude` session runs in a
-- directory, the conversation lives in Claude Code's own transcript, and the
-- operator can pick the same chat up at a keyboard. It is UNMEDIATED
-- (FR-ATT-30): no sandbox, no policy engine, no approvals, no budget caps.
--
-- Governed means Relay's own loop: the model chooses a capability, Relay
-- executes it under policy, and every guarantee this system makes applies.
--
-- Defaulting to 'governed' is deliberate. A thread that has said nothing
-- about which it wants gets the mode with the guarantees; becoming
-- unmediated is something the operator asks for, never something they end
-- up in by omission.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'governed';

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_mode_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_mode_check CHECK (mode IN ('direct', 'governed'));
