import type { RiskTier } from '../capabilities/registry.js'
import type { ApprovalPolicy } from '../config/schema.js'
import { OWNER_ROLE } from '../tenancy/roles.js'

/**
 * Who may resolve an approval at `tier`, from policy.yaml's `approvals`
 * section. A tier the policy does not name (or no `approvals` section at
 * all) needs an owner, so an install that never configured approvals
 * keeps working, and never falls open to anybody.
 */
export function approvalRolesFor(policy: ApprovalPolicy | undefined, tier: RiskTier): string[] {
  return [...(policy?.[tier]?.required_roles ?? [OWNER_ROLE])]
}
