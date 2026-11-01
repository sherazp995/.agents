/**
 * The two roles a principal can hold on one Relay. The owner is the
 * person whose machine Relay runs on: only an owner resolves approvals
 * and reaches the unmediated paths ("direct", a live chat, "sessions",
 * Attach). A member is anyone else the owner added: they start ordinary
 * work in their own threads, and anything risky waits for an owner.
 *
 * `operator` is the role every principal was given before these two
 * existed. It still counts as owner, so an existing install keeps its
 * owner without a data migration; nothing grants it any more.
 *
 * Fail closed throughout: an empty or unknown role list is not an owner.
 */

export const OWNER_ROLE = 'owner'
export const MEMBER_ROLE = 'member'
export const LEGACY_OWNER_ROLE = 'operator'

/** The roles `principals add` accepts. */
export const ROLES = [OWNER_ROLE, MEMBER_ROLE] as const
export type Role = (typeof ROLES)[number]

/** Every stored role name that makes a principal an owner, for SQL `= ANY` filters. */
export const OWNER_ROLE_NAMES: readonly string[] = [OWNER_ROLE, LEGACY_OWNER_ROLE]

export function isOwner(roles: readonly string[]): boolean {
  return roles.some((role) => OWNER_ROLE_NAMES.includes(role))
}

export function parseRole(value: string): Role {
  const role = ROLES.find((candidate) => candidate === value.trim())
  if (role === undefined) throw new Error(`unknown role "${value}": use ${ROLES.join(' or ')}`)
  return role
}
