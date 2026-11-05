-- Projects and agent teams, set up in the local web page (relay ui).
--
-- A project ties a Slack channel to a folder (and, by name, to entries in
-- the repo registry), so a new thread in that channel starts in the
-- project's folder. Personas are one library per workspace: each is a
-- Markdown file under Relay's home `personas/`, and the row only names the
-- file. A project has one team, whose members each pick a persona; the same
-- persona may serve several teams, and twice on one team.
--
-- Every table carries a NOT NULL workspace_id foreign key (AP-8), removed
-- with its workspace.

CREATE TABLE projects (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL CHECK (btrim(name) <> ''),
  slack_channel TEXT        NOT NULL CHECK (btrim(slack_channel) <> ''),
  -- Stored expanded and resolved, the way a folder named in a channel
  -- description is used today.
  folder        TEXT        NOT NULL CHECK (folder LIKE '/%'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slack_channel),
  UNIQUE (workspace_id, id)
);

CREATE TABLE project_repos (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL,
  -- A name in config/repos.yaml; a name whose entry is gone is shown as missing.
  repo_name    TEXT NOT NULL CHECK (btrim(repo_name) <> ''),
  PRIMARY KEY (project_id, repo_name),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE personas (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL CHECK (btrim(name) <> ''),
  -- Set once at creation (slug plus a short id), so a rename never moves a file.
  file_name    TEXT        NOT NULL CHECK (file_name ~ '^[a-z0-9][a-z0-9-]*\.md$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, file_name),
  UNIQUE (workspace_id, id)
);

CREATE TABLE teams (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id   UUID        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One team per project.
  UNIQUE (project_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE team_members (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      UUID        NOT NULL,
  -- RESTRICT: a persona still on a team cannot be deleted.
  persona_id   UUID        NOT NULL,
  name         TEXT        NOT NULL CHECK (btrim(name) <> ''),
  role         TEXT        NOT NULL CHECK (btrim(role) <> ''),
  is_lead      BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, persona_id) REFERENCES personas(workspace_id, id) ON DELETE RESTRICT
);

-- At most one lead per team, held by the database.
CREATE UNIQUE INDEX team_members_one_lead ON team_members (team_id) WHERE is_lead;
CREATE INDEX team_members_persona_idx ON team_members (workspace_id, persona_id);

-- One-time login links minted by `relay ui`: only a hash of the token is kept.
CREATE TABLE web_login_links (
  token_hash   TEXT        PRIMARY KEY,
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_id TEXT        NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Page sessions: only a hash of the cookie value is kept.
CREATE TABLE web_sessions (
  id_hash          TEXT        PRIMARY KEY,
  workspace_id     UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_id     TEXT        NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  csrf_token       TEXT        NOT NULL,
  last_seen_at     TIMESTAMPTZ NOT NULL,
  idle_expires_at  TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
