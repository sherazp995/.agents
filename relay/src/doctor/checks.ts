import { ConfigError } from '../config/errors.js'
import { resolveRelayHome } from '../config/paths.js'
import { loadPolicy, loadRelayConfig } from '../config/load.js'
import { databasePasswordInConfig, resolveOperatorDatabaseUrl } from '../config/database-url.js'
import {
  APPROVAL_RECEIPT_KEY_SECRET,
  keychainItemStatus,
  relaySecretsHelperPath,
  type KeychainItemStatus,
} from '../secrets/keychain.js'
import type { Policy, RelayConfig } from '../config/schema.js'
import { closePool, createPool } from '../db/pool.js'
import { closeRedis, createRedis, pingRedis } from '../redis/client.js'
import { registerCheck } from './registry.js'
import type { CheckContext } from './registry.js'

export type CheckStatus = 'ok' | 'degraded' | 'failed'

/**
 * One diagnostic result. `remediation` is present whenever the operator can
 * act, because a diagnosis without an action is just bad news.
 */
export type CheckResult = {
  name: string
  status: CheckStatus
  detail: string
  remediation?: string
}

const MINIMUM_NODE_MAJOR = 22

export function checkNodeVersion(actual: string): CheckResult {
  const major = Number.parseInt(actual.replace(/^v/, '').split('.')[0] ?? '0', 10)
  if (major >= MINIMUM_NODE_MAJOR) {
    return { name: 'node', status: 'ok', detail: actual }
  }
  return {
    name: 'node',
    status: 'failed',
    detail: `${actual} is below the minimum`,
    remediation: `Install Node ${MINIMUM_NODE_MAJOR} or newer.`,
  }
}

/**
 * Loads and validates config and policy exactly once, returning both the
 * report and, on success, the parsed values themselves. runDoctor uses the
 * parsed values to build the CheckContext every other check runs against,
 * so this one load serves both purposes and nothing downstream loads
 * config a second time just to read a URL out of it.
 */
export function checkConfigDetailed(
  configPath: string,
  policyPath: string
): { result: CheckResult; config?: RelayConfig; policy?: Policy } {
  const relayHome = resolveRelayHome()
  try {
    const config = loadRelayConfig(configPath)
    const policy = loadPolicy(policyPath)
    return { result: { name: 'config', status: 'ok', detail: `${configPath}, ${policyPath}` }, config, policy }
  } catch (error) {
    if (error instanceof ConfigError) {
      return {
        result: {
          name: 'config',
          status: 'failed',
          detail: error.reason,
          // Says WHERE it looked and why, because the commonest cause of
          // this is not a broken file but running outside an installation:
          // an operator who sees only "fix this path" has no way to know
          // Relay chose that path rather than being told it.
          remediation:
            `Fix ${error.filePath}. Relay refuses to start on an invalid config or policy, per FR-POL-2.\n` +
            `Relay is using ${relayHome.path}, chosen from the ${relayHome.source}. ` +
            'If that is not where your installation lives, set RELAY_HOME, pass --config and --policy, or run ' +
            '`relay init` there to create one.',
        },
      }
    }
    throw error
  }
}

export function checkConfig(configPath: string, policyPath: string): CheckResult {
  return checkConfigDetailed(configPath, policyPath).result
}

export async function checkPostgres(url: string): Promise<CheckResult> {
  const pool = createPool(url)
  try {
    await pool.query('SELECT 1')
    return { name: 'postgres', status: 'ok', detail: 'reachable' }
  } catch (error) {
    return {
      name: 'postgres',
      status: 'failed',
      detail: (error as Error).message,
      remediation: 'Start the system services (`brew services start postgresql@17 redis`) and re-check.',
    }
  } finally {
    await closePool(pool)
  }
}

export async function checkRedisReachable(url: string): Promise<CheckResult> {
  const redis = createRedis(url)
  try {
    const alive = await pingRedis(redis)
    return alive
      ? { name: 'redis', status: 'ok', detail: 'reachable' }
      : {
          name: 'redis',
          status: 'failed',
          detail: 'ping failed',
          remediation: 'Start the system services (`brew services start postgresql@17 redis`) and re-check.',
        }
  } finally {
    await closeRedis(redis)
  }
}

/** Resolves `database.url` (a literal or a keystore reference) first, so a missing keystore item fails here naming it. */
export async function checkConfiguredPostgres(ctx: CheckContext): Promise<CheckResult> {
  let url: string
  try {
    url = await resolveOperatorDatabaseUrl(ctx.config, ctx.secrets)
  } catch (error) {
    return {
      name: 'postgres',
      status: 'failed',
      detail: error instanceof ConfigError ? error.reason : (error as Error).message,
      remediation: 'Run `relay secrets migrate`, or point database.url at a keystore item that exists.',
    }
  }
  return checkPostgres(url)
}

/** User decision 7: config holds a keystore reference, never a database password. */
export function checkDatabaseSecret(config: RelayConfig): CheckResult {
  if (databasePasswordInConfig(config)) {
    return {
      name: 'database-secret',
      status: 'failed',
      detail: 'database.url in the relay config holds a plaintext password, which any same-user process can read',
      remediation:
        'Run `relay secrets migrate`: it moves the URL into the keystore, connects relay as the relay_app role, ' +
        'and rewrites database.url to a keystore reference.',
    }
  }
  return { name: 'database-secret', status: 'ok', detail: 'database.url holds no password' }
}

export type ReceiptKeyDependencies = {
  readonly relayHome?: string
  readonly status?: (name: string, helperPath: string) => Promise<KeychainItemStatus>
}

/**
 * The approval receipt key must exist before the daemon signs approvals.
 * On the keychain it is asked through `relay-secrets status`, which prints
 * no value (whether its probe read can raise a dialog is unverified, see
 * native/relay-secrets); another keystore
 * is asked through the provider.
 */
export async function checkReceiptKey(ctx: CheckContext, deps: ReceiptKeyDependencies = {}): Promise<CheckResult> {
  const remediation = 'Run `relay secrets migrate`, which creates the receipt key.'
  try {
    let present: boolean
    if (ctx.secrets.kind === 'keychain') {
      const helperPath = relaySecretsHelperPath(deps.relayHome ?? resolveRelayHome().path)
      present = (await (deps.status ?? keychainItemStatus)(APPROVAL_RECEIPT_KEY_SECRET, helperPath)) !== 'missing'
    } else {
      present = await ctx.secrets.has(APPROVAL_RECEIPT_KEY_SECRET)
    }
    return present
      ? { name: 'receipt-key', status: 'ok', detail: `${APPROVAL_RECEIPT_KEY_SECRET} exists in the keystore` }
      : { name: 'receipt-key', status: 'failed', detail: `${APPROVAL_RECEIPT_KEY_SECRET} is missing from the keystore`, remediation }
  } catch (error) {
    return {
      name: 'receipt-key',
      status: 'failed',
      detail: `could not ask the keystore for ${APPROVAL_RECEIPT_KEY_SECRET}: ${(error as Error).message}`,
      remediation: 'Run `relay install-service` to build relay-secrets, then `relay secrets migrate`.',
    }
  }
}

// Registers this module's config-dependent checks against the registry, so
// runDoctor drives them without a hand-wired call for each one. Node and
// config are not registered here: node needs no config, and config is the
// step that produces the CheckContext every registered check receives, so
// it runs as its own step in runDoctor before a CheckContext can exist.
registerCheck({ name: 'postgres', run: (ctx: CheckContext) => checkConfiguredPostgres(ctx) })
registerCheck({ name: 'database-secret', run: async (ctx: CheckContext) => checkDatabaseSecret(ctx.config) })
registerCheck({ name: 'receipt-key', run: (ctx: CheckContext) => checkReceiptKey(ctx) })
registerCheck({ name: 'redis', run: (ctx: CheckContext) => checkRedisReachable(ctx.config.redis.url) })
