/**
 * `relay kill engage <reason>` and `relay kill clear`: write the stored kill
 * switch directly, so a running daemon picks the change up on its next
 * KillSwitch.refresh() tick without being restarted.
 */

import type { Pool } from 'pg'
import { PostgresKillSwitchStore } from '../killswitch.js'

export async function runKillEngage(pool: Pool, workspaceId: string, reason: string): Promise<string> {
  await new PostgresKillSwitchStore(pool, workspaceId).recordEngaged(reason, new Date(), 'cli')
  return `Kill switch engaged: ${reason}. A running daemon stops its work within one tick.`
}

export async function runKillClear(pool: Pool, workspaceId: string): Promise<string> {
  await new PostgresKillSwitchStore(pool, workspaceId).recordCleared(new Date())
  return 'Kill switch cleared.'
}
