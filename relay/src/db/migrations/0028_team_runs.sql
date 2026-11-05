-- A project's team runs a request (the teams phase 2 plan).
--
-- The lead is the thread's own autonomous task. A team run is one request
-- the lead started in that thread (at most one open at a time); its roster,
-- settings and persona texts are copied in at start, so editing the team
-- changes nothing for a running request. Each piece of work the lead hands
-- out is an assignment with its own lease, process group, session and
-- login, never the lead's. A merge into the request branch is recorded per
-- assignment and member revision, so a retried or interrupted merge ends as
-- either merged or not merged.
--
-- Every table carries a NOT NULL workspace_id foreign key (AP-8).

ALTER TABLE team_members
  ADD COLUMN client TEXT NOT NULL DEFAULT 'claude' CHECK (client IN ('claude', 'codex')),
  ADD COLUMN model  TEXT CHECK (model IS NULL OR btrim(model) <> '');

ALTER TABLE teams
  ADD COLUMN member_limit INTEGER NOT NULL DEFAULT 3 CHECK (member_limit BETWEEN 1 AND 6);

CREATE TABLE team_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id       UUID        NOT NULL,
  project_id    UUID        NOT NULL,
  title         TEXT        NOT NULL CHECK (btrim(title) <> ''),
  -- 'build' merges members' commits into the request branch; 'pr-review' checks a PR's head and merges nothing.
  kind          TEXT        NOT NULL CHECK (kind IN ('build', 'pr-review')),
  repo_name     TEXT        NOT NULL,
  repo_path     TEXT        NOT NULL CHECK (repo_path LIKE '/%'),
  pr_ref        TEXT,
  -- The local default branch head (build) or the fetched PR head (pr-review).
  base_commit   TEXT        NOT NULL,
  worktree_path TEXT,
  branch        TEXT,
  -- The roster, member limit and copied persona paths at start (src/teams/types.ts RunSnapshot).
  snapshot      JSONB       NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished', 'cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  CHECK (kind = 'pr-review' OR (worktree_path IS NOT NULL AND branch IS NOT NULL)),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES autonomous_tasks (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE CASCADE
);

-- One open request per thread, held by the database.
CREATE UNIQUE INDEX team_runs_one_open ON team_runs (task_id) WHERE status = 'open';

CREATE TABLE team_assignments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id            UUID        NOT NULL,
  task_id           UUID        NOT NULL,
  project_id        UUID        NOT NULL,
  -- The member as copied into the run's snapshot.
  member_id         TEXT        NOT NULL,
  member_name       TEXT        NOT NULL,
  kind              TEXT        NOT NULL CHECK (kind IN ('build', 'review', 'qa')),
  brief             TEXT        NOT NULL CHECK (btrim(brief) <> ''),
  -- A retried `relay team assign` with the same key adds nothing.
  idem_key          TEXT        NOT NULL,
  state             TEXT        NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled')),
  worktree_path     TEXT,
  branch            TEXT,
  start_commit      TEXT,
  result_text       TEXT,
  result_commit     TEXT,
  -- Review and QA: the request revision they checked.
  checked_commit    TEXT,
  -- The member's question, set by ask-lead during a turn; the turn then ends as waiting.
  question          TEXT,
  -- Answers from the lead not yet read, and every answer so far (replayed into a fresh session).
  pending_notes     JSONB       NOT NULL DEFAULT '[]',
  answers           JSONB       NOT NULL DEFAULT '[]',
  engine_session_id TEXT,
  account_key       TEXT,
  lease_owner       TEXT,
  lease_generation  BIGINT      NOT NULL DEFAULT 0,
  lease_expires_at  TIMESTAMPTZ,
  worker_pid        INTEGER,
  worker_pgid       INTEGER,
  attempts          INTEGER     NOT NULL DEFAULT 0,
  -- Times a restart interrupted it while running: it runs again once, then fails.
  restarts          INTEGER     NOT NULL DEFAULT 0,
  next_wakeup_at    TIMESTAMPTZ,
  -- Set once the lead was told this member is out of logins, so it is told once per wait.
  login_wait_told   BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, idem_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (run_id, workspace_id) REFERENCES team_runs (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (task_id, workspace_id) REFERENCES autonomous_tasks (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX team_assignments_due_idx ON team_assignments (workspace_id, state, next_wakeup_at);
CREATE INDEX team_assignments_run_idx ON team_assignments (run_id, created_at);

CREATE TABLE team_merges (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assignment_id  UUID        NOT NULL,
  member_commit  TEXT        NOT NULL,
  head_before    TEXT,
  head_after     TEXT,
  state          TEXT        NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'merged', 'conflict')),
  conflict_files TEXT[]      NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, member_commit),
  FOREIGN KEY (assignment_id, workspace_id) REFERENCES team_assignments (id, workspace_id) ON DELETE CASCADE
);
