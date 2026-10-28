import { SLACK_BOT_SCOPES } from '../../chat/slack/scopes.js'
import { SecretNotFoundError } from '../../secrets/provider.js'
import type { SecretProvider } from '../../secrets/provider.js'
import type { CheckResult } from '../checks.js'
import { registerCheck } from '../registry.js'
import type { Check, CheckContext } from '../registry.js'

const BOT_TOKEN_SECRET = 'relay-slack-bot-token'
const APP_TOKEN_SECRET = 'relay-slack-app-token'

export { SLACK_BOT_SCOPES }

type FetchFn = typeof fetch

/**
 * Reads a secret by name, returning undefined for "not configured" instead
 * of throwing, so callers can tell a legitimately absent token apart from
 * every other kind of failure.
 */
async function readOptionalSecret(secrets: SecretProvider, name: string): Promise<string | undefined> {
  try {
    return await secrets.get(name)
  } catch (error) {
    if (error instanceof SecretNotFoundError) return undefined
    throw error
  }
}

const REDACTED_TOKEN_PLACEHOLDER = '[redacted token]'

/**
 * Removes every occurrence of the given token from a piece of text before
 * that text can reach a CheckResult. Every detail built from Slack's own
 * response or from a caught exception's message goes through this first,
 * because neither is trustworthy content to echo verbatim: a Slack error
 * could echo request text back, and an exception message can include the
 * request that failed. relay doctor output is exactly what an operator
 * pastes into a bug report, so this runs whether or not the leak is
 * currently reachable against the real Slack API.
 *
 * The placeholder is fixed text carrying no length or prefix hint of the
 * token, and nothing here logs what it scrubbed, so the redaction itself
 * cannot become a second leak.
 */
function redactToken(text: string, token: string): string {
  if (token.length === 0) return text
  return text.split(token).join(REDACTED_TOKEN_PLACEHOLDER)
}

/**
 * Slack's currently documented auth.test error codes
 * (https://api.slack.com/methods/auth.test), treated as safe to report
 * verbatim because they are a fixed, known vocabulary. Anything outside
 * this set is reported as an opaque summary instead of being echoed: a
 * future Slack error we have not enumerated could contain arbitrary
 * request text, including the token that failed, and token redaction alone
 * should not be the only thing standing between that and an operator's
 * terminal. This is defence in depth alongside redactToken, not a
 * replacement for it: redaction still runs on whatever comes out of here.
 */
const KNOWN_AUTH_TEST_ERROR_CODES = new Set([
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
  'org_login_required',
  'ekm_access_denied',
  'missing_scope',
  'ratelimited',
  'accesslimited',
  'request_timeout',
  'fatal_error',
  'internal_error',
])

const UNRECOGNISED_AUTH_TEST_ERROR_SUMMARY = 'an unrecognised error code'
const NO_AUTH_TEST_ERROR_CODE_SUMMARY = 'Slack returned no error code'

function summarizeAuthTestError(rawError: string | undefined): string {
  if (rawError === undefined) return NO_AUTH_TEST_ERROR_CODE_SUMMARY
  return KNOWN_AUTH_TEST_ERROR_CODES.has(rawError) ? rawError : UNRECOGNISED_AUTH_TEST_ERROR_SUMMARY
}

type AuthTestOutcome =
  | { ok: true; scopes: string[]; user: string; botId: string; team: string }
  | { ok: false; error: string }

/**
 * Calls Slack's auth.test with the bot token. The granted scopes come back
 * on the x-oauth-scopes response header, per Slack's own documented
 * behaviour for any OAuth-scoped Web API call, so this single request
 * covers token validity, granted scopes, and bot identity at once; each
 * check below still calls it independently rather than sharing a result,
 * so no check depends on another one having already run. A failure's error
 * code is summarised through the allowlist above before it ever reaches a
 * caller, so every check built on this function inherits that protection
 * automatically.
 */
async function callAuthTest(token: string, fetchImpl: FetchFn): Promise<AuthTestOutcome> {
  const response = await fetchImpl('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  const body = (await response.json()) as {
    ok: boolean
    error?: string
    user?: string
    bot_id?: string
    team?: string
  }
  if (!body.ok) return { ok: false, error: summarizeAuthTestError(body.error) }

  const scopesHeader = response.headers.get('x-oauth-scopes') ?? ''
  const scopes = scopesHeader
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
  return { ok: true, scopes, user: body.user ?? '', botId: body.bot_id ?? '', team: body.team ?? '' }
}

/** Token present in the Keychain. Degraded, not failed, because a fresh install legitimately has none yet. */
export const checkSlackToken: Check = {
  name: 'slack-token',
  async run(ctx: CheckContext): Promise<CheckResult> {
    const token = await readOptionalSecret(ctx.secrets, BOT_TOKEN_SECRET)
    if (token === undefined) {
      return {
        name: 'slack-token',
        status: 'degraded',
        detail: 'no Slack bot token configured',
        remediation: 'Run Slack setup to install the app and store its bot token in Keychain.',
      }
    }
    return { name: 'slack-token', status: 'ok', detail: 'bot token present' }
  },
}

/**
 * Token validity via auth.test. Reads the token itself rather than trusting
 * a prior check's result, since checks run independently, but never calls
 * Slack when the token is absent: the guard below returns before fetchImpl
 * is ever touched.
 */
export function checkSlackTokenValid(fetchImpl: FetchFn = fetch): Check {
  return {
    name: 'slack-token-valid',
    async run(ctx: CheckContext): Promise<CheckResult> {
      const token = await readOptionalSecret(ctx.secrets, BOT_TOKEN_SECRET)
      if (token === undefined) {
        return { name: 'slack-token-valid', status: 'degraded', detail: 'not attempted, no Slack bot token configured' }
      }
      try {
        const outcome = await callAuthTest(token, fetchImpl)
        if (!outcome.ok) {
          return {
            name: 'slack-token-valid',
            status: 'failed',
            detail: redactToken(`Slack rejected the bot token: ${outcome.error}`, token),
            remediation: 'The token may be revoked or rotated. Reinstall the app and store the new token in Keychain.',
          }
        }
        return { name: 'slack-token-valid', status: 'ok', detail: 'token accepted by auth.test' }
      } catch (error) {
        return {
          name: 'slack-token-valid',
          status: 'failed',
          detail: redactToken((error as Error).message, token),
          remediation: 'Check network connectivity to slack.com and retry.',
        }
      }
    },
  }
}

/** Granted scopes versus the declared minimum. Missing scopes fail; excess scopes warn, per FR-SLA-11. */
export function checkSlackScopes(fetchImpl: FetchFn = fetch): Check {
  return {
    name: 'slack-scopes',
    async run(ctx: CheckContext): Promise<CheckResult> {
      const token = await readOptionalSecret(ctx.secrets, BOT_TOKEN_SECRET)
      if (token === undefined) {
        return { name: 'slack-scopes', status: 'degraded', detail: 'not attempted, no Slack bot token configured' }
      }
      try {
        const outcome = await callAuthTest(token, fetchImpl)
        if (!outcome.ok) {
          return {
            name: 'slack-scopes',
            status: 'failed',
            detail: redactToken(`could not read granted scopes: ${outcome.error}`, token),
            remediation: 'Fix the bot token first. Scopes cannot be read from a token Slack rejects.',
          }
        }

        const granted = new Set(outcome.scopes)
        const missing = SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope))
        if (missing.length > 0) {
          return {
            name: 'slack-scopes',
            status: 'failed',
            detail: `missing required scopes: ${missing.join(', ')}`,
            remediation: 'Reinstall the Slack app from its manifest so the missing scopes are granted.',
          }
        }

        const declared = new Set<string>(SLACK_BOT_SCOPES)
        const excess = outcome.scopes.filter((scope) => !declared.has(scope))
        if (excess.length > 0) {
          return {
            name: 'slack-scopes',
            status: 'degraded',
            detail: `granted scopes exceed the declared minimum: ${excess.join(', ')}`,
            remediation: 'Reinstall the app from its current manifest to narrow scopes back to the minimum.',
          }
        }

        return { name: 'slack-scopes', status: 'ok', detail: 'granted scopes match the declared minimum exactly' }
      } catch (error) {
        return {
          name: 'slack-scopes',
          status: 'failed',
          detail: redactToken((error as Error).message, token),
          remediation: 'Check network connectivity to slack.com and retry.',
        }
      }
    },
  }
}

/** Socket Mode connectivity via apps.connections.open, using the app-level token. */
export function checkSlackSocketMode(fetchImpl: FetchFn = fetch): Check {
  return {
    name: 'slack-socket-mode',
    async run(ctx: CheckContext): Promise<CheckResult> {
      const token = await readOptionalSecret(ctx.secrets, APP_TOKEN_SECRET)
      if (token === undefined) {
        return {
          name: 'slack-socket-mode',
          status: 'degraded',
          detail: 'not attempted, no Slack app-level token configured',
        }
      }
      try {
        const response = await fetchImpl('https://slack.com/api/apps.connections.open', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
        const body = (await response.json()) as { ok: boolean; error?: string }
        if (!body.ok) {
          return {
            name: 'slack-socket-mode',
            status: 'failed',
            detail: redactToken(`Socket Mode connection could not be opened: ${body.error ?? 'unknown error'}`, token),
            remediation: 'Confirm the app-level token has the connections:write scope and Socket Mode is enabled.',
          }
        }
        return { name: 'slack-socket-mode', status: 'ok', detail: 'Socket Mode connection URL obtained' }
      } catch (error) {
        return {
          name: 'slack-socket-mode',
          status: 'failed',
          detail: redactToken((error as Error).message, token),
          remediation: 'Check network connectivity to slack.com and retry.',
        }
      }
    },
  }
}

/** Bot identity, confirmed the same way as token validity. */
export function checkSlackIdentity(fetchImpl: FetchFn = fetch): Check {
  return {
    name: 'slack-identity',
    async run(ctx: CheckContext): Promise<CheckResult> {
      const token = await readOptionalSecret(ctx.secrets, BOT_TOKEN_SECRET)
      if (token === undefined) {
        return { name: 'slack-identity', status: 'degraded', detail: 'not attempted, no Slack bot token configured' }
      }
      try {
        const outcome = await callAuthTest(token, fetchImpl)
        if (!outcome.ok) {
          return {
            name: 'slack-identity',
            status: 'failed',
            detail: redactToken(`could not confirm bot identity: ${outcome.error}`, token),
            remediation: 'Fix the bot token first. Identity cannot be confirmed from a token Slack rejects.',
          }
        }
        return {
          name: 'slack-identity',
          status: 'ok',
          detail: `authenticated as ${outcome.user} (bot ${outcome.botId}) in team ${outcome.team}`,
        }
      } catch (error) {
        return {
          name: 'slack-identity',
          status: 'failed',
          detail: redactToken((error as Error).message, token),
          remediation: 'Check network connectivity to slack.com and retry.',
        }
      }
    },
  }
}

registerCheck(checkSlackToken)
registerCheck(checkSlackTokenValid())
registerCheck(checkSlackScopes())
registerCheck(checkSlackSocketMode())
registerCheck(checkSlackIdentity())
