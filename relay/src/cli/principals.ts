/**
 * The operator-facing provisioning act FR-CA-4 requires: `resolvePrincipal`
 * correctly refuses to auto-create an identity, and `handleChatEvent`
 * (src/orchestrator.ts) correctly refuses to act for one, but until this
 * module existed nothing ever called `provisionPrincipal`
 * (src/tenancy/principals.ts) at all. An operator refused by the fail
 * closed path had no way to turn "unmapped" into "mapped": this is that
 * way, and the only one. It stays a deliberate, separate, operator-invoked
 * act, never something an unmapped event triggers on its own; see
 * src/orchestrator.ts's own fail closed branch, which is unchanged in
 * spirit by this module and only gained a log line naming the id this
 * module needs.
 */

import type { Pool } from 'pg'
import { provisionPrincipal } from '../tenancy/principals.js'
import { listWorkspacesForPlatform } from '../tenancy/workspaces.js'

export type PrincipalsAddParams = {
  platform: string
  platformUserId: string
  displayName: string
  roles: string[]
  /** Bypasses the platform lookup below. Mainly for tests and for the day a platform genuinely has more than one workspace and the operator already knows which uuid they mean. */
  workspaceId?: string
}

export type PrincipalsAddResult = {
  principalId: string
  workspaceId: string
}

/** Thrown for every refusal this module can produce; its `.message` is written to stderr as-is by the CLI command, so it is always a complete, actionable sentence, never a fragment. */
export class PrincipalsAddError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrincipalsAddError'
  }
}

/**
 * Provisions a principal for `params.platform` / `params.platformUserId`,
 * resolving the workspace to provision it into rather than accepting one
 * blindly.
 *
 * REFUSES RATHER THAN CREATES a workspace, per this module's own doc
 * comment on listWorkspacesForPlatform: if no workspace row exists yet for
 * `platform`, that means no adapter has ever connected for it, and
 * provisioning a principal into a freshly minted workspace nobody's adapter
 * will ever resolve to again would be a silent no-op dressed up as success.
 * Also refuses, rather than guessing, when more than one workspace exists
 * for the platform: naming one is the operator's call, not this function's.
 *
 * IDEMPOTENT, inherited directly from provisionPrincipal's own documented
 * behaviour: a second call for the same (workspaceId, platform,
 * platformUserId) identity returns the same principal id rather than
 * throwing or duplicating a row, so running this command twice, the
 * operator re-running it because they were not sure it worked the first
 * time, for instance, is safe.
 */
export async function runPrincipalsAdd(pool: Pool, params: PrincipalsAddParams): Promise<PrincipalsAddResult> {
  const workspaceId = params.workspaceId ?? (await resolveTargetWorkspaceId(pool, params.platform))
  const principalId = await provisionPrincipal(
    pool,
    workspaceId,
    params.platform,
    params.platformUserId,
    params.displayName,
    params.roles,
  )
  return { principalId, workspaceId }
}

async function resolveTargetWorkspaceId(pool: Pool, platform: string): Promise<string> {
  const matches = await listWorkspacesForPlatform(pool, platform)

  if (matches.length === 0) {
    throw new PrincipalsAddError(
      `No workspace found for platform "${platform}". Relay only provisions a workspace row once its ` +
        "adapter has connected at least once (src/tenancy/workspaces.ts's resolveWorkspaceId). Start the " +
        'orchestrator (pnpm orchestrator:live) so it can connect, then retry, or pass --workspace-id ' +
        'directly if you already know it.',
    )
  }

  if (matches.length > 1) {
    const listed = matches.map((match) => `${match.id} (team ${match.platformTeamId})`).join(', ')
    throw new PrincipalsAddError(
      `Multiple workspaces found for platform "${platform}"; pass --workspace-id to name the one you ` +
        `mean: ${listed}`,
    )
  }

  const [only] = matches
  if (!only) {
    throw new PrincipalsAddError(
      `resolveTargetWorkspaceId: expected exactly one workspace match for platform "${platform}" but found none`,
    )
  }
  return only.id
}
