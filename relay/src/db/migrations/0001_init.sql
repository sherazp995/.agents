-- Workspaces are the tenancy root. Every domain table references one, per AP-8,
-- so opening Relay to a team later is configuration rather than a migration.
CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principals (
  id               text PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  platform         text NOT NULL,
  platform_user_id text NOT NULL,
  display_name     text NOT NULL,
  roles            text[] NOT NULL,
  budgets          jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferences      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, platform_user_id)
);

CREATE INDEX principals_workspace_idx ON principals (workspace_id);
