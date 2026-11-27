/**
 * What the rest of Relay sees of failover (README, "Failover"). Two laptops
 * share one database and both answer Slack. One of them holds the "default
 * laptop" record: it takes messages that name no laptop and threads whose
 * own laptop is offline. Losing the record changes only that; nothing stops.
 * Code that manages worker processes passes this laptop's name so it never
 * touches another laptop's.
 *
 * With failover off, ALWAYS_ACTIVE stands in: this laptop is always the
 * default and the host name is null, which matches rows written before
 * failover existed.
 */

export interface FailoverGate {
  /** This laptop's name, written on every worker it starts; null when failover is off. */
  readonly host: string | null
  /** Cheap and synchronous: holds the default record, renewed within the trust window by this laptop's wall clock. */
  isDefault(): boolean
}

export const ALWAYS_ACTIVE: FailoverGate = {
  host: null,
  isDefault: () => true,
}

/** One laptop's row in failover_hosts. */
export type FailoverHost = { name: string; home: string; buildMigration: string; preferred: boolean; lastSeenAt: Date }
