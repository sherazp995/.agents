-- Autonomous tasks: a thread opened by a mention that relay works on by
-- itself after the plan is approved. Relay owns the task state; the worker
-- CLI only reports through its structured reply.

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_mode_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_mode_check CHECK (mode IN ('direct', 'governed', 'autonomous'));

CREATE TABLE autonomous_tasks (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id              uuid NOT NULL UNIQUE,
  requester_principal_id  text NOT NULL,
  repo_name               text,
  task_type               text CHECK (task_type IN ('review', 'implement')),
  change_kind             text CHECK (change_kind IN ('fix', 'feature')),
  visible                 boolean,
  acceptance_criteria     jsonb,
  test_command            text,
  plan_version            integer NOT NULL DEFAULT 0,
  plan_digest             text,
  phase                   text NOT NULL DEFAULT 'intake'
                           CHECK (phase IN ('intake', 'interview', 'awaiting_plan_approval', 'working', 'verifying',
                                            'waiting_on_approval', 'done', 'blocked', 'stopped')),
  cancel_requested_at     timestamptz,
  agent_preference        text,
  extension_granted_by    text,
  account_key             text,
  engine_session_id       text,
  worktree_path           text,
  approved_scope          text,
  plan                    jsonb,
  -- Each finding carries a stable id, so "review again" can recheck it by id.
  findings                jsonb NOT NULL DEFAULT '[]',
  progress_log            jsonb NOT NULL DEFAULT '[]',
  pending_events          jsonb NOT NULL DEFAULT '[]',
  -- Per file: Slack file id, name, status (pending, downloaded, skipped), local path, reason.
  files                   jsonb NOT NULL DEFAULT '[]',
  seen_event_ids          text[] NOT NULL DEFAULT '{}',
  review_rounds           integer NOT NULL DEFAULT 0,
  -- Fenced lease: every state write names the owner and generation it holds.
  lease_owner             text,
  lease_generation        bigint NOT NULL DEFAULT 0,
  lease_expires_at        timestamptz,
  worker_pid              integer,
  worker_pgid             integer,
  worker_started_at       timestamptz,
  next_wakeup_at          timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE INDEX autonomous_tasks_workspace_idx ON autonomous_tasks (workspace_id);
CREATE INDEX autonomous_tasks_wakeup_idx ON autonomous_tasks (next_wakeup_at) WHERE next_wakeup_at IS NOT NULL;
CREATE INDEX autonomous_tasks_worker_idx ON autonomous_tasks (worker_pgid) WHERE worker_pgid IS NOT NULL;

ALTER TABLE autonomous_tasks
  ADD CONSTRAINT autonomous_tasks_session_workspace_fkey
  FOREIGN KEY (session_id, workspace_id) REFERENCES sessions (id, workspace_id) ON DELETE CASCADE;
ALTER TABLE autonomous_tasks
  ADD CONSTRAINT autonomous_tasks_requester_workspace_fkey
  FOREIGN KEY (requester_principal_id, workspace_id) REFERENCES principals (id, workspace_id);

-- A remote write relay itself executes after a per-operation approval. The
-- payload is immutable once stored; its digest binds the approval to it.
CREATE TABLE autonomous_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  task_id         uuid NOT NULL,
  approval_id     uuid,
  op_kind         text NOT NULL,
  payload         jsonb NOT NULL,
  payload_digest  text NOT NULL,
  state           text NOT NULL DEFAULT 'requested'
                   CHECK (state IN ('requested', 'approved', 'dispatching', 'succeeded', 'failed', 'uncertain',
                                    'skipped', 'cancelled')),
  result          jsonb,
  claimed_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);

CREATE INDEX autonomous_operations_workspace_idx ON autonomous_operations (workspace_id);
CREATE INDEX autonomous_operations_task_idx ON autonomous_operations (task_id);

ALTER TABLE autonomous_operations
  ADD CONSTRAINT autonomous_operations_task_workspace_fkey
  FOREIGN KEY (task_id, workspace_id) REFERENCES autonomous_tasks (id, workspace_id) ON DELETE CASCADE;

-- Evidence relay produced itself for one snapshot of an implement task.
CREATE TABLE autonomous_verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  task_id            uuid NOT NULL,
  repo               text NOT NULL,
  base_sha           text NOT NULL,
  head_sha           text NOT NULL,
  tests_exit         integer,
  review_record      text,
  review_verdict     text,
  visual_qa_verdict  text,
  video_qa_verdict   text,
  passed             boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, repo, base_sha, head_sha)
);

CREATE INDEX autonomous_verifications_workspace_idx ON autonomous_verifications (workspace_id);

ALTER TABLE autonomous_verifications
  ADD CONSTRAINT autonomous_verifications_task_workspace_fkey
  FOREIGN KEY (task_id, workspace_id) REFERENCES autonomous_tasks (id, workspace_id) ON DELETE CASCADE;

-- One row per CLI process relay starts, written before the spawn, so spend
-- is reserved up front and charged exactly once.
CREATE TABLE autonomous_invocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  task_id               uuid NOT NULL,
  account_key           text NOT NULL,
  purpose               text NOT NULL CHECK (purpose IN ('worker', 'review', 'visual_qa', 'video_qa')),
  run_id                uuid NOT NULL,
  session_id            uuid NOT NULL,
  principal_id          text NOT NULL,
  reserved_usd          numeric NOT NULL CHECK (reserved_usd >= 0),
  -- Fixed allowance for the nested Codex lens of review and visual QA runs (user decision 11).
  nested_allowance_usd  numeric NOT NULL DEFAULT 0 CHECK (nested_allowance_usd >= 0),
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  state                 text NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'finished', 'charged')),
  amount_usd            numeric CHECK (amount_usd >= 0)
);

CREATE INDEX autonomous_invocations_workspace_idx ON autonomous_invocations (workspace_id);
CREATE INDEX autonomous_invocations_open_idx ON autonomous_invocations (task_id) WHERE state <> 'charged';

ALTER TABLE autonomous_invocations
  ADD CONSTRAINT autonomous_invocations_task_workspace_fkey
  FOREIGN KEY (task_id, workspace_id) REFERENCES autonomous_tasks (id, workspace_id) ON DELETE CASCADE;
ALTER TABLE autonomous_invocations
  ADD CONSTRAINT autonomous_invocations_run_workspace_fkey
  FOREIGN KEY (run_id, workspace_id) REFERENCES runs (id, workspace_id) ON DELETE CASCADE;

-- One invocation is charged at most once; governed spend leaves it null.
ALTER TABLE budget_ledger ADD COLUMN invocation_id uuid UNIQUE;

ALTER TABLE approvals ADD COLUMN allowed_principal_ids text[];
ALTER TABLE approvals ADD COLUMN kind text NOT NULL DEFAULT 'standard'
  CHECK (kind IN ('standard', 'plan', 'remote_write'));
ALTER TABLE approvals ADD COLUMN operation_id uuid REFERENCES autonomous_operations (id);
ALTER TABLE approvals ADD COLUMN receipt text;
