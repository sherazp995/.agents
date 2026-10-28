-- Task 4 fix round 1: three schema findings against 0012_approvals.sql.
-- 0012 is already committed and, per this project's own hard-won rule
-- (0003_orchestrator.sql's header comment, and the same lesson relearned
-- here the hard way), a migration that has already run is history, not
-- source: editing it in place would silently strand every environment
-- that already applied it in the old shape, since schema_migrations tracks
-- applied migrations by filename, not by content hash. Every change below
-- is therefore a forward migration, not an edit to 0012 itself.
--
-- All three changes touch a table this same milestone introduced
-- (approvals, approval_events), with no other environment's production
-- data at stake in practice, but this migration is still written as if a
-- populated table were a live possibility, per the same discipline
-- 0003_orchestrator.sql, 0005_session_principal_workspace.sql, and
-- 0010_parent_child_workspace_consistency.sql already apply: detect a
-- violation and fail loudly before adding a constraint that would reject
-- it, rather than assuming an empty table.

-- 1. required_roles must never be empty. An empty array is ambiguous
-- between "nobody can ever resolve this" (a silent deadlock into
-- FR-APR-3's timeout) and "anybody can" (FR-APR-4's gate silently absent);
-- src/approvals/store.ts's hasRequiredRole already treats an empty
-- required_roles as "nobody qualifies," fail-closed, and this CHECK makes
-- that the only representable state rather than a convention the
-- application has to uphold on its own. createApproval also refuses an
-- empty array before any I/O, so this CHECK is the backstop, not the only
-- guard.
--
-- Division-by-zero guard, matching 0005's and 0010's own identical
-- pattern: the migration runner (src/db/migrate.ts) rejects any file
-- containing its own transaction-control keywords, which rules out a
-- PL/pgSQL DO block with an explicit RAISE for this check.
SELECT 1 / (CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END)
FROM approvals
WHERE cardinality(required_roles) = 0;

ALTER TABLE approvals ADD CONSTRAINT approvals_required_roles_not_empty CHECK (cardinality(required_roles) > 0);

-- 2. approval_events.option had no CHECK while approvals.selected_option
-- already did, so the audit trail was the weaker of the two. It is what
-- someone reads months later to answer what was approved and by whom, so
-- it must be at least as constrained as the row it describes, not less.
-- Nullable rows ('created' and 'expired' actions, which never carry an
-- option) are unaffected: a CHECK only ever evaluates a NOT NULL condition
-- when the column IS NULL if the constraint expression itself does not
-- exempt NULL, and `option IN (...)` evaluates to NULL, not false, for a
-- NULL option, which Postgres treats as satisfying the CHECK. The guard
-- below only has to rule out a NON-NULL value outside the four options.
SELECT 1 / (CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END)
FROM approval_events
WHERE option IS NOT NULL
  AND option NOT IN ('approve', 'deny', 'approve_all_session', 'edit_and_approve');

ALTER TABLE approval_events
  ADD CONSTRAINT approval_events_option_valid
  CHECK (option IN ('approve', 'deny', 'approve_all_session', 'edit_and_approve'));

-- 3. edited_arguments moves from text to jsonb: src/approvals/store.ts's
-- resolveApproval now parses the operator's edit-and-approve submission as
-- JSON and validates it against the capability's own registered
-- inputSchema before it is ever written, so every future write is already
-- a real JSON value, never raw text.
--
-- The USING clause is the actual decision this finding asked for: what
-- happens to an existing row whose text is not valid JSON. `text::jsonb`
-- would throw at migration time for exactly that row, aborting the whole
-- migration on data this change did not create and has no way to repair
-- automatically. `to_jsonb(edited_arguments)` instead always succeeds: for
-- a plain text column it produces that text's own JSON STRING
-- representation (quoted and escaped), never inspecting or requiring the
-- text to already look like JSON. A NULL column stays NULL either way
-- (to_jsonb(NULL) is NULL). This preserves whatever was there losslessly,
-- rather than discarding it or aborting the migration on it, at the cost
-- of a pre-existing plain-text row now reading as a JSON string rather
-- than a JSON object; that is an honest reflection of what the value
-- actually was, not a claim that it was ever validated against a schema.
ALTER TABLE approvals
  ALTER COLUMN edited_arguments TYPE jsonb
  USING to_jsonb(edited_arguments);
