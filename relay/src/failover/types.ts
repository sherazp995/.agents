/**
 * What the rest of Relay sees of failover (README, "Failover"). Two laptops
 * share one database; one holds the "who is answering" record and takes new
 * work. Code that starts work asks the gate first; code that manages worker
 * processes passes this laptop's name so it never touches another laptop's.
 *
 * With failover off, ALWAYS_ACTIVE stands in: every check passes and the
 * host name is null, which matches rows written before failover existed.
 */

export interface FailoverGate {
  /** This laptop's name, written on every worker it starts; null when failover is off. */
  readonly host: string | null
  /** Cheap and synchronous: renewed within the trust window by this laptop's wall clock. False once the record is lost or released. */
  holdsFresh(): boolean
  /** The full check before starting work: fresh, and the generation in the database is still ours. False means start nothing; the failover runner alone decides whether to step down. */
  mayStartWork(): Promise<boolean>
}

export const ALWAYS_ACTIVE: FailoverGate = {
  host: null,
  holdsFresh: () => true,
  mayStartWork: async () => true,
}

/** One laptop's row in failover_hosts. */
export type FailoverHost = { name: string; home: string; buildMigration: string; preferred: boolean; lastSeenAt: Date }
