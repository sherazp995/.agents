-- Task 4 of the P0.4 policy-and-approvals milestone: the human in the loop.
-- Backs src/approvals/store.ts, which is the only module that writes to
-- these three tables.
--
-- All three tables are brand new, so, like 0006_outbound_dispatch.sql and
-- 0007_agent_runs.sql, none carries the non-empty-table hazard
-- 0003_orchestrator.sql had to guard against with a nullable-then-backfill
-- dance: every column here can be NOT NULL from the very first row,
-- including workspace_id, which is what the AP-8 guard in
-- test/db/migrate.test.ts checks for on every domain table.
--
-- approvals is the pending-or-resolved record itself. Every field FR-APR-1
-- says an approval request must carry lives here: capability,
-- human-readable description, exact target, tier, escalation reason, run
-- and session identity, and the requester. `description` and `target` are
-- free text the requester or the policy engine supplied, which is exactly
-- the shape of value FR-SEC-1 worries about (a credential quoted into a
-- target), so src/approvals/store.ts runs both through scrubSecrets before
-- they ever reach this column; this migration does not enforce that on its
-- own, the same division of labour src/runs/store.ts already uses for
-- `steps.input`/`steps.output`.
CREATE TABLE approvals (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id                      uuid NOT NULL,
  session_id                  uuid NOT NULL,
  requester_principal_id      text NOT NULL,
  capability                  text NOT NULL,
  description                 text NOT NULL,
  target                      text NOT NULL,
  tier                        text NOT NULL CHECK (tier IN ('read', 'write', 'sensitive', 'irreversible')),
  escalation_reason           text NOT NULL,
  -- FR-APR-4: the set of roles authorised to resolve THIS approval. Chosen
  -- by the caller that creates the approval (the future policy seam), not
  -- derived in here from the tier: policy.yaml has no tier-to-role mapping
  -- defined yet (that is FR-SEC-7, phase 3), so this store stays agnostic
  -- about what the mapping should be rather than inventing one. See the
  -- Task 4 report for this named as a real gap, not an oversight.
  required_roles              text[] NOT NULL,
  -- FR-APR-5: whether resolving this approval with 'approve' requires the
  -- resolver to type the fixed confirmation word (src/approvals/store.ts's
  -- CONFIRMATION_TOKEN) rather than a single click. Set at creation time by
  -- the caller (a call for the highest tier), not derived from tier in
  -- here, for the same reason required_roles is caller-supplied above.
  requires_typed_confirmation boolean NOT NULL DEFAULT false,
  status                      text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'denied', 'timed_out')),
  -- FR-APR-2's four options. Null until resolved.
  selected_option              text
                               CHECK (selected_option IN ('approve', 'deny', 'approve_all_session', 'edit_and_approve')),
  resolved_by_principal_id     text,
  resolved_at                  timestamptz,
  -- FR-APR-2's "edit and approve": the operator's replacement text for
  -- `target`, collected as free text from a Slack modal rather than a
  -- structured argument editor. A richer per-argument editor is future
  -- work; see the Task 4 report.
  edited_arguments             text,
  -- FR-APR-3: the deadline this approval defaults to deny-and-pause at.
  -- Fixed at creation from the caller's configured timeout for this tier;
  -- src/approvals/store.ts's expireApproval is what actually acts on it.
  timeout_at                    timestamptz NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approvals_workspace_idx ON approvals (workspace_id);
CREATE INDEX approvals_run_idx ON approvals (run_id);
CREATE INDEX approvals_session_idx ON approvals (session_id);

-- Backs sweeping for overdue approvals (FR-APR-3) without a sequential scan:
-- only 'pending' rows are ever candidates for expiry, so the index is
-- partial rather than covering every status.
CREATE INDEX approvals_pending_timeout_idx ON approvals (timeout_at) WHERE status = 'pending';

-- Composite foreign keys, mirroring 0005_session_principal_workspace.sql
-- and 0010_parent_child_workspace_consistency.sql's own fixes applied here
-- from the start rather than as a follow-up patch: an approval's run_id,
-- session_id, and requester_principal_id must each describe the same
-- tenant as the approval's own workspace_id, and these are what Postgres
-- enforces that against, not application logic. They target
-- runs_id_workspace_id_key, sessions_id_workspace_id_key, and
-- principals_id_workspace_id_key, the composite unique constraints
-- 0010 and 0005 already added.
ALTER TABLE approvals
  ADD CONSTRAINT approvals_run_workspace_fkey
  FOREIGN KEY (run_id, workspace_id) REFERENCES runs (id, workspace_id) ON DELETE CASCADE;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_session_workspace_fkey
  FOREIGN KEY (session_id, workspace_id) REFERENCES sessions (id, workspace_id) ON DELETE CASCADE;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_requester_workspace_fkey
  FOREIGN KEY (requester_principal_id, workspace_id) REFERENCES principals (id, workspace_id);

-- resolved_by_principal_id is nullable (an unresolved approval has none),
-- so this is a plain foreign key, not a composite one gated by NOT NULL:
-- Postgres allows either column of a multi-column foreign key to be NULL,
-- in which case the constraint is simply not checked for that row, which is
-- exactly the "no resolver yet" case. Once resolved, resolveApproval always
-- writes both columns from the same authenticated lookup, so a resolved row
-- can never carry a resolver from a different workspace in practice; this
-- constraint is the enforced backstop for that.
ALTER TABLE approvals
  ADD CONSTRAINT approvals_resolver_workspace_fkey
  FOREIGN KEY (resolved_by_principal_id, workspace_id) REFERENCES principals (id, workspace_id);

-- approvals needs its own (id, workspace_id) unique pair for the two
-- composite foreign keys below (approval_events, session_approval_grants)
-- to target, the same pattern 0005/0010 established for principals,
-- sessions, and runs. Added here, before either table that references it,
-- since a foreign key can only target a unique constraint that already
-- exists.
ALTER TABLE approvals ADD CONSTRAINT approvals_id_workspace_id_key UNIQUE (id, workspace_id);

-- approval_events is the append-only audit trail FR-APR-2 and FR-APR-4
-- require: every resolution, successful or refused, is recorded with an
-- actor, a timestamp, and the option attempted. `actor_principal_id` is
-- nullable to cover the one actor that is not a principal: expireApproval's
-- own system-driven timeout transition (FR-APR-3), recorded as an audit row
-- with a null actor rather than either skipping the audit or inventing a
-- fake principal to attribute it to.
CREATE TABLE approval_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  approval_id        uuid NOT NULL,
  actor_principal_id text,
  action             text NOT NULL CHECK (action IN ('created', 'resolve_attempt', 'expired')),
  option              text,
  outcome            text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approval_events_workspace_idx ON approval_events (workspace_id);
CREATE INDEX approval_events_approval_idx ON approval_events (approval_id);

ALTER TABLE approval_events
  ADD CONSTRAINT approval_events_approval_workspace_fkey
  FOREIGN KEY (approval_id, workspace_id) REFERENCES approvals (id, workspace_id) ON DELETE CASCADE;

ALTER TABLE approval_events
  ADD CONSTRAINT approval_events_actor_workspace_fkey
  FOREIGN KEY (actor_principal_id, workspace_id) REFERENCES principals (id, workspace_id);

-- session_approval_grants records FR-APR-2's "approve all of this type for
-- this session" option and FR-SES-3's TTL-scoped escalation: a grant is
-- created when an approval is resolved with selected_option =
-- 'approve_all_session', and expires on its own schedule independent of
-- the approval that created it. Read-only from a future policy seam's point
-- of view (findActiveSessionGrant in src/approvals/store.ts); nothing in
-- this task wires a caller that checks it before creating a new approval,
-- per the Task 4 brief's "build the store so it can satisfy such an
-- interface, do not wire the two together."
CREATE TABLE session_approval_grants (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id              uuid NOT NULL,
  capability              text NOT NULL,
  source_approval_id      uuid NOT NULL,
  granted_by_principal_id text NOT NULL,
  granted_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL
);

CREATE INDEX session_approval_grants_workspace_idx ON session_approval_grants (workspace_id);

-- The lookup findActiveSessionGrant will run: "is there a live grant for
-- this session and this capability right now." Partial on a bound future
-- callers always need (an expired grant is never a match), same idea as
-- approvals_pending_timeout_idx above.
CREATE INDEX session_approval_grants_lookup_idx
  ON session_approval_grants (session_id, capability, expires_at);

ALTER TABLE session_approval_grants
  ADD CONSTRAINT session_approval_grants_session_workspace_fkey
  FOREIGN KEY (session_id, workspace_id) REFERENCES sessions (id, workspace_id) ON DELETE CASCADE;

ALTER TABLE session_approval_grants
  ADD CONSTRAINT session_approval_grants_source_approval_workspace_fkey
  FOREIGN KEY (source_approval_id, workspace_id) REFERENCES approvals (id, workspace_id) ON DELETE CASCADE;

ALTER TABLE session_approval_grants
  ADD CONSTRAINT session_approval_grants_granted_by_workspace_fkey
  FOREIGN KEY (granted_by_principal_id, workspace_id) REFERENCES principals (id, workspace_id);
