-- Where a sent action landed (the platform's channel and message ts), so a
-- caller that queued a post, such as `relay notify`, can find the
-- thread it started.
ALTER TABLE outbox ADD COLUMN sent_ref jsonb;
