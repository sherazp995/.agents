/**
 * FR-AUD-2 in the readiness report: is the audit chain intact, and does a
 * signature still cover it.
 *
 * Reported as TWO facts rather than one verdict, because "intact but
 * unsigned" and "signed but broken" call for completely different responses
 * and only one of them is an incident:
 *
 *   - a broken chain is `failed`. Something has altered the log.
 *   - an unsigned chain is `degraded`, not ok. The operator has a weaker
 *     guarantee than they may think they have, and the fix is one command,
 *     but nothing is currently wrong.
 */

import { describeIntegrity, verifyHead } from '../../audit/signing.js'
import { latestSignedHead, verifyAuditChain } from '../../audit/store.js'
import { createSecretProvider } from '../../secrets/index.js'
import type { CheckResult } from '../checks.js'
import { registerCheck } from '../registry.js'
import type { CheckContext } from '../registry.js'
import { closePool, createPool } from '../../db/pool.js'
import { resolveOperatorDatabaseUrl } from '../../config/database-url.js'
import { ConfigError } from '../../config/errors.js'

registerCheck({
  name: 'audit',
  async run(context: CheckContext): Promise<CheckResult> {
    let url: string
    try {
      url = await resolveOperatorDatabaseUrl(context.config, context.secrets)
    } catch (error) {
      return {
        name: 'audit',
        status: 'failed',
        detail: `the database URL could not be resolved: ${error instanceof ConfigError ? error.reason : (error as Error).message}`,
        remediation: 'Run `relay secrets migrate`, or point database.url at a keystore item that exists.',
      }
    }
    const pool = createPool(url)
    try {
      // Verified per workspace, because the chain is per workspace: one
      // shared chain would let activity in one be inferred from sequence
      // gaps in another, and an integrity failure in one would report the
      // whole log as broken.
      const workspaces = await pool.query('SELECT id FROM workspaces')
      const ids = workspaces.rows.map((row) => String((row as { id: string }).id))

      let chain: Awaited<ReturnType<typeof verifyAuditChain>> = { intact: true, entries: 0, head: '' }
      let stored: Awaited<ReturnType<typeof latestSignedHead>>
      for (const id of ids) {
        const result = await verifyAuditChain(pool, id)
        if (!result.intact) {
          chain = result
          break
        }
        chain = { intact: true, entries: (chain.intact ? chain.entries : 0) + result.entries, head: result.head }
        stored = (await latestSignedHead(pool, id)) ?? stored
      }
      const head =
        stored === undefined ? undefined : await verifyHead(stored, createSecretProvider(context.config))
      const integrity = describeIntegrity(chain, head)

      if (!integrity.chainIntact) {
        return {
          name: 'audit',
          status: 'failed',
          detail: integrity.chainDetail,
          remediation:
            'The audit log has been altered since it was written. Treat this as a security incident (FR-AUD-6) ' +
            'rather than a configuration problem: investigate before running anything else.',
        }
      }

      if (!integrity.headSigned) {
        return { name: 'audit', status: 'degraded', detail: `${integrity.chainDetail} ${integrity.headDetail}`, remediation: 'Store an audit signing key so chain heads can be signed, per FR-AUD-2.' }
      }

      return { name: 'audit', status: 'ok', detail: `${integrity.chainDetail} ${integrity.headDetail}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A missing table is an unmigrated database, not a damaged log, and
      // the two call for completely different responses.
      const unmigrated = /relation .*audit_(entries|chain_heads).* does not exist/i.test(message)
      return {
        name: 'audit',
        status: 'failed',
        detail: unmigrated ? 'the audit tables do not exist, so this database has not been migrated.' : `the audit log could not be read: ${message}`,
        remediation: unmigrated
          ? 'Start the orchestrator once, which applies pending migrations, or apply them directly.'
          : 'Investigate before running anything else.',
      }
    } finally {
      await closePool(pool)
    }
  },
})
