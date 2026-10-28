-- Task 1 of the P0.3 orchestrator milestone: workspace and principal
-- provisioning. Closes PRE-3 (docs/decisions/open-questions.md) by giving
-- workspaces the columns src/tenancy/workspaces.ts's resolveWorkspaceId
-- needs to map a chat platform's own tenant id onto a Relay workspace uuid.
--
-- principals already has everything src/tenancy/principals.ts's
-- provisionPrincipal needs, from 0001_init.sql's id, workspace_id, platform,
-- platform_user_id, display_name, roles, and its UNIQUE (workspace_id,
-- platform, platform_user_id) constraint, so this migration adds no columns
-- there. Only what Task 1 needs is added here; sessions, runs, and steps
-- belong to later tasks' own migrations.
-- Added nullable, backfilled, then constrained. Adding these NOT NULL with no
-- default in one step would abort this migration on any database whose
-- workspaces table already holds rows, which every environment that ran P0.1
-- or P0.2 does. Tests would not have caught that, since they migrate an empty
-- database, so the failure would have surfaced only on a real deployment.
ALTER TABLE workspaces
  ADD COLUMN platform          text,
  ADD COLUMN platform_team_id  text;

-- Backfills pre-existing rows with a deterministic placeholder derived from the
-- row's own uuid. These rows predate platform identity and no team id can be
-- recovered for them, so the placeholder is deliberately one that
-- resolveWorkspaceId can never collide with: it will not match a real Slack
-- team id, so a legacy row is never silently returned for a live workspace.
-- Instead the real team id provisions its own row on first sight, which is the
-- correct outcome. The 'legacy' platform makes such rows easy to find later.
UPDATE workspaces
SET platform         = 'legacy',
    platform_team_id = 'legacy:' || id::text
WHERE platform IS NULL OR platform_team_id IS NULL;

ALTER TABLE workspaces
  ALTER COLUMN platform         SET NOT NULL,
  ALTER COLUMN platform_team_id SET NOT NULL;

-- Backs resolveWorkspaceId's upsert. INSERT ... ON CONFLICT (platform,
-- platform_team_id) DO NOTHING, followed by a SELECT when DO NOTHING wins
-- the race and returns no row, is what makes concurrent first sight
-- provisioning produce exactly one workspaces row rather than two; this
-- constraint is what Postgres actually enforces that guarantee against, not
-- application logic. Postgres backs a UNIQUE constraint with a unique index
-- automatically, so ON CONFLICT (platform, platform_team_id) has an index to
-- target and a plain lookup by the same pair needs no separate index either.
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_platform_team_id_key UNIQUE (platform, platform_team_id);

-- workspaces is exempt from the AP-8 tenancy guard already, per 0001_init.sql:
-- it is the tenancy root every other table's workspace_id points at, so
-- platform and platform_team_id do not themselves need a workspace_id column.
