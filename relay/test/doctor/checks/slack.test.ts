import { describe, expect, it, vi } from 'vitest'
import {
  SLACK_BOT_SCOPES,
  checkSlackIdentity,
  checkSlackScopes,
  checkSlackSocketMode,
  checkSlackToken,
  checkSlackTokenValid,
} from '../../../src/doctor/checks/slack.js'
import type { CheckResult } from '../../../src/doctor/checks.js'
import type { Logger } from '../../../src/obs/logger.js'
import { formatResults } from '../../../src/doctor/run.js'
import type { CheckContext } from '../../../src/doctor/registry.js'
import type { SecretProvider } from '../../../src/secrets/provider.js'
import { SecretNotFoundError } from '../../../src/secrets/provider.js'

/** A SecretProvider backed by a plain map, rejecting with SecretNotFoundError for anything not in it, matching what the real providers do. */
function fakeSecrets(values: Record<string, string>): SecretProvider {
  return {
    kind: 'env',
    async get(name: string) {
      const value = values[name]
      if (value === undefined) throw new SecretNotFoundError(name)
      return value
    },
    async has(name: string) {
      return values[name] !== undefined
    },
  }
}

function buildContext(values: Record<string, string>): CheckContext {
  return {
    config: {
      model_provider: { name: 'anthropic', zero_data_retention: true },
      database: { url: 'postgres://user:pass@localhost:5432/relay' },
      redis: { url: 'redis://localhost:6379' },
      logging: { level: 'info' },
      secrets: { provider: 'keychain' },
    },
    policy: { version: 1, defaults: { unmatched: 'ask' }, hard_blocked_origins: ['*.example.com'] },
    secrets: fakeSecrets(values),
  }
}

/** Builds a fetch stub that returns the given body and, when given, the x-oauth-scopes header auth.test's caller reads. */
function fakeFetch(body: unknown, scopes?: string[]): typeof fetch {
  const headers = new Headers()
  if (scopes) headers.set('x-oauth-scopes', scopes.join(','))
  return vi.fn(async () => new Response(JSON.stringify(body), { headers })) as unknown as typeof fetch
}

/** A Logger double whose methods are spies, so a test can assert nothing, including a token, ever reached one. */
function fakeLogger(): Logger {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger),
  }
  return logger as unknown as Logger
}

function loggerCalls(logger: Logger): unknown[] {
  const spy = logger as unknown as Record<'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal', ReturnType<typeof vi.fn>>
  return (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).flatMap((level) => spy[level].mock.calls)
}

describe('checkSlackToken', () => {
  it('is degraded, not failed, when no bot token is configured', async () => {
    const result = await checkSlackToken.run(buildContext({}))
    expect(result.status).toBe('degraded')
    expect(result.remediation).toBeDefined()
  })

  it('is ok when a bot token is present', async () => {
    const result = await checkSlackToken.run(buildContext({ 'relay-slack-bot-token': 'xoxb-test' }))
    expect(result.status).toBe('ok')
  })
})

describe('checkSlackTokenValid', () => {
  it('is degraded and never calls Slack when no token is configured', async () => {
    const fetchMock = fakeFetch({ ok: true })
    const result = await checkSlackTokenValid(fetchMock).run(buildContext({}))
    expect(result.status).toBe('degraded')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is ok when Slack accepts the token', async () => {
    const fetchMock = fakeFetch({ ok: true, user: 'relay-bot', bot_id: 'B123', team: 'Acme' })
    const result = await checkSlackTokenValid(fetchMock).run(
      buildContext({ 'relay-slack-bot-token': 'xoxb-test' })
    )
    expect(result.status).toBe('ok')
  })

  // 'invalid_auth' is on the auth.test error code allowlist (src/doctor/checks/slack.ts),
  // so it is reported verbatim: a recognised code is exactly the case where echoing the
  // text back is safe and useful. See the "token redaction" describe block below for the
  // companion case, an unrecognised code, which is not echoed.
  it('fails with remediation when Slack rejects the token, and still names a recognised error code verbatim', async () => {
    const fetchMock = fakeFetch({ ok: false, error: 'invalid_auth' })
    const result = await checkSlackTokenValid(fetchMock).run(
      buildContext({ 'relay-slack-bot-token': 'xoxb-bad' })
    )
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('invalid_auth')
    expect(result.remediation).toBeDefined()
  })

  // Neither 'getaddrinfo' nor 'ENOTFOUND' is the configured token, so redaction leaves this
  // message untouched: it proves a thrown network error still produces a failed result with
  // a useful reason, not that raw exception text is safe to echo in general.
  it('fails rather than throwing when the network call itself errors', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND slack.com')
    }) as unknown as typeof fetch
    const result = await checkSlackTokenValid(fetchMock).run(
      buildContext({ 'relay-slack-bot-token': 'xoxb-test' })
    )
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('ENOTFOUND')
  })
})

describe('checkSlackScopes', () => {
  it('is degraded and never calls Slack when no token is configured', async () => {
    const fetchMock = fakeFetch({ ok: true })
    const result = await checkSlackScopes(fetchMock).run(buildContext({}))
    expect(result.status).toBe('degraded')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is ok when granted scopes match the declared minimum exactly', async () => {
    const fetchMock = fakeFetch({ ok: true }, [...SLACK_BOT_SCOPES])
    const result = await checkSlackScopes(fetchMock).run(buildContext({ 'relay-slack-bot-token': 'xoxb-test' }))
    expect(result.status).toBe('ok')
  })

  it('fails and names the missing scope when a required scope is absent', async () => {
    const granted = SLACK_BOT_SCOPES.filter((scope) => scope !== 'chat:write')
    const fetchMock = fakeFetch({ ok: true }, granted)
    const result = await checkSlackScopes(fetchMock).run(buildContext({ 'relay-slack-bot-token': 'xoxb-test' }))
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('chat:write')
  })

  it('warns, as degraded rather than ok or failed, when scopes exceed the declared minimum, per FR-SLA-11', async () => {
    const granted = [...SLACK_BOT_SCOPES, 'admin']
    const fetchMock = fakeFetch({ ok: true }, granted)
    const result = await checkSlackScopes(fetchMock).run(buildContext({ 'relay-slack-bot-token': 'xoxb-test' }))
    expect(result.status).toBe('degraded')
    expect(result.detail).toContain('admin')
  })
})

describe('checkSlackSocketMode', () => {
  it('is degraded and never calls Slack when no app-level token is configured', async () => {
    const fetchMock = fakeFetch({ ok: true, url: 'wss://example.com' })
    const result = await checkSlackSocketMode(fetchMock).run(buildContext({}))
    expect(result.status).toBe('degraded')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is ok when Slack opens the Socket Mode connection', async () => {
    const fetchMock = fakeFetch({ ok: true, url: 'wss://example.com' })
    const result = await checkSlackSocketMode(fetchMock).run(
      buildContext({ 'relay-slack-app-token': 'xapp-test' })
    )
    expect(result.status).toBe('ok')
  })

  it('fails with remediation when Slack refuses the connection', async () => {
    const fetchMock = fakeFetch({ ok: false, error: 'invalid_auth' })
    const result = await checkSlackSocketMode(fetchMock).run(
      buildContext({ 'relay-slack-app-token': 'xapp-bad' })
    )
    expect(result.status).toBe('failed')
    expect(result.remediation).toBeDefined()
  })
})

describe('checkSlackIdentity', () => {
  it('is degraded and never calls Slack when no token is configured', async () => {
    const fetchMock = fakeFetch({ ok: true })
    const result = await checkSlackIdentity(fetchMock).run(buildContext({}))
    expect(result.status).toBe('degraded')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is ok and reports the bot identity when Slack accepts the token', async () => {
    const fetchMock = fakeFetch({ ok: true, user: 'relay-bot', bot_id: 'B123', team: 'Acme' })
    const result = await checkSlackIdentity(fetchMock).run(buildContext({ 'relay-slack-bot-token': 'xoxb-test' }))
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('relay-bot')
    expect(result.detail).toContain('B123')
    expect(result.detail).toContain('Acme')
  })
})

/**
 * FR-SEC-1: no token value may reach a CheckResult, formatResults output, or
 * a log line. Reproduces the leak an independent reviewer found (a mock
 * Slack response whose error field echoed the token verbatim reached
 * formatResults unredacted) and extends it to every site that builds a
 * detail from Slack-returned text or a caught exception's message: the
 * outcome.error/body.error branch and the catch block in each of the three
 * auth.test-backed checks, plus both in checkSlackSocketMode, which has no
 * error-code allowlist to fall back on.
 */
describe('token redaction (FR-SEC-1)', () => {
  const BOT_TOKEN = 'xoxb-secret-9999-should-never-leak'
  const APP_TOKEN = 'xapp-secret-8888-should-never-leak'

  function assertNeverLeaked(result: CheckResult, secret: string): void {
    expect(result.detail).not.toContain(secret)
    expect(result.remediation ?? '').not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(formatResults([result])).not.toContain(secret)
  }

  it('LEAK CONFIRMED regression: never lets the bot token reach CheckResult or formatResults when an unrecognised auth.test error code echoes it', async () => {
    const fetchMock = fakeFetch({ ok: false, error: `token ${BOT_TOKEN} was rejected by a future error code` })
    const result = await checkSlackTokenValid(fetchMock).run(buildContext({ 'relay-slack-bot-token': BOT_TOKEN }))
    expect(result.status).toBe('failed')
    // The allowlist alone already keeps this off an unrecognised code, and redaction
    // backs it up: neither the raw error text nor the token itself may appear.
    expect(result.detail).not.toContain('was rejected by a future error code')
    assertNeverLeaked(result, BOT_TOKEN)
  })

  it('never lets the app token reach CheckResult or formatResults when a Socket Mode error echoes it, with no allowlist to fall back on', async () => {
    const fetchMock = fakeFetch({ ok: false, error: `invalid_auth for ${APP_TOKEN}` })
    const result = await checkSlackSocketMode(fetchMock).run(buildContext({ 'relay-slack-app-token': APP_TOKEN }))
    expect(result.status).toBe('failed')
    assertNeverLeaked(result, APP_TOKEN)
  })

  it('LEAK CONFIRMED regression: never lets the bot token reach CheckResult or formatResults when a caught exception message echoes it', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${BOT_TOKEN}`)
    }) as unknown as typeof fetch
    const result = await checkSlackTokenValid(fetchMock).run(buildContext({ 'relay-slack-bot-token': BOT_TOKEN }))
    expect(result.status).toBe('failed')
    assertNeverLeaked(result, BOT_TOKEN)
  })

  it('never lets the app token reach CheckResult or formatResults when checkSlackSocketMode catches an exception that echoes it', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${APP_TOKEN}`)
    }) as unknown as typeof fetch
    const result = await checkSlackSocketMode(fetchMock).run(buildContext({ 'relay-slack-app-token': APP_TOKEN }))
    expect(result.status).toBe('failed')
    assertNeverLeaked(result, APP_TOKEN)
  })

  it('never lets the bot token reach CheckResult when checkSlackScopes or checkSlackIdentity catch an exception that echoes it', async () => {
    const throwingFetch = vi.fn(async () => {
      throw new Error(`request failed carrying token ${BOT_TOKEN}`)
    }) as unknown as typeof fetch

    const scopesResult = await checkSlackScopes(throwingFetch).run(buildContext({ 'relay-slack-bot-token': BOT_TOKEN }))
    assertNeverLeaked(scopesResult, BOT_TOKEN)

    const identityResult = await checkSlackIdentity(throwingFetch).run(
      buildContext({ 'relay-slack-bot-token': BOT_TOKEN })
    )
    assertNeverLeaked(identityResult, BOT_TOKEN)
  })

  it('replaces the token with a fixed placeholder that carries no length or prefix hint', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error(`failed for ${BOT_TOKEN}`)
    }) as unknown as typeof fetch
    const result = await checkSlackTokenValid(fetchMock).run(buildContext({ 'relay-slack-bot-token': BOT_TOKEN }))
    expect(result.detail).toContain('[redacted token]')
    expect(result.detail).not.toMatch(/xoxb-secret-9/)
  })

  it('never logs the token, so a check that starts logging later inherits the same protection', async () => {
    const log = fakeLogger()
    const fetchMock = vi.fn(async () => {
      throw new Error(`failed for ${BOT_TOKEN}`)
    }) as unknown as typeof fetch
    const ctx: CheckContext = { ...buildContext({ 'relay-slack-bot-token': BOT_TOKEN }), log }

    await checkSlackTokenValid(fetchMock).run(ctx)

    const calls = loggerCalls(log)
    expect(calls).toHaveLength(0)
  })
})
