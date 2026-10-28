-- Task 4 fix round 1 (finding 2): a dependency wait must not share the
-- delivery-failure budget outbox.ts's maxAttempts bounds, or a post
-- delayed a few drain() cycles behind unrelated work on a busy shared
-- adapter can exhaust its dependent edit's attempts while the post is
-- still perfectly deliverable, permanently dropping that edit.
--
-- outbound_dispatch_refs (0006_outbound_dispatch.sql) previously only
-- gained a row once a post or upload actually resolved. This migration
-- lets a row exist before that: OutboundDispatcher now writes a
-- placeholder the moment it mints a dispatch id, before the post is even
-- enqueued, carrying dispatched_at but no ref yet. A dependent edit reads
-- dispatched_at to bound how long it is willing to keep deferring (via
-- src/chat/outbox.ts's new OutboxDeferError, which does not spend
-- maxAttempts) before it gives up and lets a genuine, counted failure
-- happen instead, so a truly undeliverable edit still terminates.
--
-- ref and resolved_at both become nullable: a placeholder row's ref is
-- not known yet, and it is only resolved once the real adapter actually
-- delivers the post. dispatched_at is added NOT NULL with a DEFAULT, which
-- carries none of the non-empty-table hazard 0003_orchestrator.sql had to
-- guard against, since Postgres backfills existing rows from the default
-- rather than requiring one supplied per row.
ALTER TABLE outbound_dispatch_refs
  ALTER COLUMN ref DROP NOT NULL,
  ALTER COLUMN resolved_at DROP NOT NULL,
  ALTER COLUMN resolved_at DROP DEFAULT,
  ADD COLUMN dispatched_at timestamptz NOT NULL DEFAULT now();
