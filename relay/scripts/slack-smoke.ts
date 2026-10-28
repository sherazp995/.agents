#!/usr/bin/env node
/**
 * Manual, real workspace verification for the Slack adapter. Not part of
 * `pnpm test`: this needs a human in the loop to actually send a Slack
 * message, per the Task 6 brief's honest gate, "do not present a mock run
 * as this criterion." Run it, then send a mention, a DM, or a thread reply
 * from the workspace the operator installed Relay into, and watch the one
 * progress message post and edit itself at least twice before it finishes.
 *
 * Usage: pnpm slack:smoke
 *
 * Reads both tokens through KeychainSecretProvider by name, never from a
 * file or process.env, per FR-SLA-6. If either token is missing this exits
 * with a clear error naming the secret and never prints a token.
 */
import { unwrapForAudit } from '../src/agent/untrusted.js'
import { createLogger } from '../src/obs/logger.js'
import { SlackAdapter } from '../src/chat/slack/adapter.js'
import { ProgressReporter } from '../src/chat/progress.js'
import { KeychainSecretProvider } from '../src/secrets/keychain.js'
import { sessionRefFor } from '../src/chat/contract.js'
import type { ChatEvent } from '../src/chat/contract.js'
import { closePool, createPool } from '../src/db/pool.js'
import { resolveWorkspaceId } from '../src/tenancy/workspaces.js'

const DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Overridable so a live test is not a race against however long the operator
 * takes to reach for their phone. Default stays modest for an unattended run.
 *
 * A junk or non positive override falls back to the default rather than being
 * trusted: `Number.parseInt` yields NaN for "abc" and an unset-but-present
 * empty string, and a NaN or zero delay makes setTimeout fire on the next tick,
 * so the run would abort with "timed out waiting for an inbound Slack event"
 * before the operator could possibly send anything. Failing loudly back to the
 * default beats a mistyped variable silently inverting the whole point of the
 * knob.
 */
function resolveWaitTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    process.stderr.write(
      `RELAY_SMOKE_WAIT_MS=${JSON.stringify(raw)} is not a positive integer; ` +
        `falling back to ${DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS}ms.\n`,
    )
    return DEFAULT_WAIT_FOR_EVENT_TIMEOUT_MS
  }
  return parsed
}

const WAIT_FOR_EVENT_TIMEOUT_MS = resolveWaitTimeoutMs(process.env.RELAY_SMOKE_WAIT_MS)
const STEP_DELAY_MS = 3500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Metadata only, never content. This is manual verification against a real
 * workspace: whatever the operator types (which could be anything, a
 * password pasted into a DM to test with, for instance) must never be
 * copied into this script's stdout or log output. `kind`, `ref`, whether a
 * principal resolved, a file count, and the text's LENGTH are all safe:
 * none of them can reconstruct what was actually said.
 */
function describeEvent(event: ChatEvent): string {
  return [
    `kind: ${event.kind}`,
    `ref: ${JSON.stringify(event.ref)}`,
    `principal: ${event.principalId !== null ? 'mapped' : '(unmapped)'}`,
    `textLength: ${unwrapForAudit(event.text).length}`,
    `files: ${event.files.length}`,
  ].join(', ')
}

/**
 * SlackAdapter.create refuses to start without a real workspace mapping, per
 * PRE-3: ChatEvent.workspaceId must be a Relay workspaces uuid, never the raw
 * Slack team id. That makes a reachable Postgres a hard requirement for this
 * script, so the URL is resolved up front and named in the error when absent,
 * rather than letting the adapter fail later with a less specific message.
 */
function requireDatabaseUrl(): string {
  const url = process.env.RELAY_DATABASE_URL
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'RELAY_DATABASE_URL is not set. slack-smoke needs a reachable Postgres to map this Slack ' +
        'team id onto a Relay workspace uuid, per PRE-3, so ChatEvent.workspaceId is a real ' +
        'workspaces row rather than the raw team id. Start the system Postgres and set ' +
        'RELAY_DATABASE_URL to the relay database.',
    )
  }
  return url
}

async function main(): Promise<void> {
  const log = createLogger('info')
  const secrets = new KeychainSecretProvider()
  const pool = createPool(requireDatabaseUrl())

  try {
    await runSmoke(log, secrets, pool)
  } finally {
    // Always closed, including when runSmoke throws or sets a failing
    // exit code, so a failed run exits instead of hanging on an open pool
    // connection.
    await closePool(pool)
  }
}

async function runSmoke(
  log: ReturnType<typeof createLogger>,
  secrets: KeychainSecretProvider,
  pool: ReturnType<typeof createPool>,
): Promise<void> {
  log.info('starting SlackAdapter against the real workspace')
  const adapter = await SlackAdapter.create(secrets, {
    log,
    resolveWorkspaceId: (platform, platformTeamId) => resolveWorkspaceId(pool, platform, platformTeamId),
  })
  log.info({ capabilities: adapter.capabilities }, 'adapter created, capabilities declared')

  let resolveFirstEvent: ((event: ChatEvent) => void) | undefined
  const firstEvent = new Promise<ChatEvent>((resolve) => {
    resolveFirstEvent = resolve
  })

  await adapter.start(async (event) => {
    log.info({ event: describeEvent(event) }, 'inbound event received')
    resolveFirstEvent?.(event)
    resolveFirstEvent = undefined
  })

  process.stdout.write(
    'Relay is listening on Socket Mode. Send a mention, a DM, or reply in an existing thread ' +
      `now. Waiting up to ${WAIT_FOR_EVENT_TIMEOUT_MS / 1000}s for one inbound event...\n`,
  )

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('timed out waiting for an inbound Slack event')), WAIT_FOR_EVENT_TIMEOUT_MS)
  })

  let event: ChatEvent
  try {
    event = await Promise.race([firstEvent, timeout])
  } catch (error) {
    log.error({ err: error }, 'no inbound event arrived within the wait window')
    await adapter.stop()
    process.exitCode = 1
    return
  }

  process.stdout.write(`Observed one inbound event: ${describeEvent(event)}\n`)

  const reporter = new ProgressReporter(adapter, sessionRefFor(event), { minIntervalMs: 3000, log })

  await reporter.update('Relay smoke test: step 1 of 3, just started...')
  process.stdout.write('Posted progress message, step 1 of 3.\n')
  await sleep(STEP_DELAY_MS)

  await reporter.update('Relay smoke test: step 2 of 3, still working...')
  process.stdout.write('Edited progress message, step 2 of 3.\n')
  await sleep(STEP_DELAY_MS)

  // unwrapForAudit, not renderForModel: this echoes the operator's own text
  // straight back into the same Slack thread they typed it in, never into a
  // model prompt, so there is nothing here for renderForModel's provenance
  // tagging to protect against.
  await reporter.finish(`Relay smoke test: done. Received "${unwrapForAudit(event.text).slice(0, 60)}"`)
  process.stdout.write('Edited progress message a final time, step 3 of 3 (finished).\n')

  await adapter.stop()
  process.stdout.write('Adapter stopped cleanly. Smoke test complete.\n')
}

main().catch((error: unknown) => {
  // error may be an Error whose message names a missing secret (see
  // SlackAdapter.create); it is never one that contains a token value,
  // since no token is ever interpolated into an error message anywhere in
  // this path.
  process.stderr.write(`slack-smoke failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
