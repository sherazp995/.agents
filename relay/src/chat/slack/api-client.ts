/**
 * The Slack adapter's outbound side and live wiring: rate limit and
 * transport error classification, the real Bolt app and Web API client
 * behind the SlackBoltApp and SlackApiClient seams (src/chat/slack/types.ts),
 * and reading the two Slack tokens.
 */
import { App } from '@slack/bolt'
import { ErrorCode, WebClient } from '@slack/web-api'
import { CONFIRM_MODAL_BLOCK_ID, EDIT_MODAL_BLOCK_ID, EDIT_MODAL_CALLBACK_ID } from '../../approvals/blockkit.js'
import { SecretNotFoundError } from '../../secrets/provider.js'
import type { SecretProvider } from '../../secrets/provider.js'
import { TransportError } from '../outbox.js'
import type {
  SlackApiClient,
  SlackBlockActionElement,
  SlackBlockActionEnvelope,
  SlackBoltApp,
  SlackRawEvent,
  SlackViewSubmissionEnvelope,
} from './types.js'

// ---------------------------------------------------------------------------
// Rate limiting. Slack returns HTTP 429 with a Retry-After header; the
// live client is built with rejectRateLimitedCalls so that comes back as a
// WebAPIRateLimitedError (code slack_webapi_rate_limited_error, retryAfter
// in seconds) instead of the library silently retrying on its own schedule.
// SlackAdapter's #callApi is what actually waits and retries, so the behaviour is
// identical whether the underlying client is real or a test stub that
// throws the same shaped error.
// ---------------------------------------------------------------------------

type RateLimitedLike = { code: string; retryAfter: number }

export function isRateLimitedError(error: unknown): error is RateLimitedLike {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; retryAfter?: unknown }
  return candidate.code === ErrorCode.RateLimitedError && typeof candidate.retryAfter === 'number'
}

// ---------------------------------------------------------------------------
// Gate fix, Blocker 4: distinguishing a retryable transport failure from a
// permanent one, so a connectivity outage does not permanently fail a
// message the platform was always going to accept once it came back.
// ---------------------------------------------------------------------------

/**
 * `@slack/web-api`'s own ErrorCode already distinguishes the platform
 * genuinely rejecting a request (`PlatformError`: Slack answered with
 * `ok: false` and a specific reason, a channel that does not exist, an
 * invalid token) from the request never reaching Slack, or Slack's own
 * infrastructure failing to answer meaningfully at all
 * (`RequestError`: the underlying HTTP request itself failed, a DNS
 * failure, a connection reset, a timeout; `HTTPError`: a non-2xx response
 * with no valid platform JSON body, most plausibly Slack's own edge
 * returning a 5xx during an outage). Only the second pair describes a
 * transport-level failure src/chat/outbox.ts's TransportError classification
 * exists for; a PlatformError is Slack telling Relay plainly that this
 * specific request will never succeed, which is exactly what the ordinary,
 * bounded maxAttempts budget is for.
 */
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([ErrorCode.RequestError, ErrorCode.HTTPError])

/**
 * Rewraps a transport-level Slack API error as TransportError before it
 * ever reaches Outbox, so a 60 second Slack outage (TST-C-4) retries
 * indefinitely instead of burning the roughly 18 seconds DEFAULT_MAX_ATTEMPTS
 * with its default backoff allows before terminal failure. Any other error,
 * including a genuine PlatformError, passes through completely unchanged.
 */
export function classifyTransportError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string' || !TRANSPORT_ERROR_CODES.has(code)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new TransportError(
    `SlackAdapter: transport-level failure calling the Slack API (${code}): ${message}`,
    { cause: error },
  )
}

// ---------------------------------------------------------------------------
// Live wiring. Isolated here so the adapter's own logic never has to know
// Bolt's or WebClient's real types beyond this construction step.
// ---------------------------------------------------------------------------

export function createLiveSlackBoltApp(botToken: string, appToken: string): SlackBoltApp {
  const app = new App({ token: botToken, appToken, socketMode: true })
  return {
    event(eventType, listener) {
      app.event(eventType, async (args) => {
        await listener({
          event: args.event as unknown as SlackRawEvent,
          body: args.body as unknown as Record<string, unknown>,
        })
      })
    },
    action(actionId, listener) {
      // Bolt requires ack() within 3 seconds of delivery; the underlying
      // approval resolution (a database round trip, possibly a Slack
      // views.open call) can legitimately take longer than that, so this
      // acks immediately and lets the listener's own work happen after,
      // exactly like a real button click needs to feel instant even though
      // resolving the approval is not instant.
      app.action(actionId, async ({ ack, action, body }) => {
        await ack()
        const raw = body as unknown as {
          user: { id: string }
          channel?: { id: string }
          message?: { ts: string }
          trigger_id?: string
        }
        // Built conditionally, not as a literal with every key always
        // present: exactOptionalPropertyTypes (this project's own tsconfig)
        // distinguishes an omitted key from one explicitly set to
        // `undefined`, and SlackBlockActionEnvelope's optional fields
        // require the former.
        const envelope: SlackBlockActionEnvelope = {
          actions: [action as unknown as SlackBlockActionElement],
          user: raw.user,
        }
        if (raw.channel !== undefined) envelope.channel = raw.channel
        if (raw.message !== undefined) envelope.message = raw.message
        if (raw.trigger_id !== undefined) envelope.trigger_id = raw.trigger_id
        await listener(envelope)
      })
    },
    view(callbackId, listener) {
      app.view(callbackId, async ({ ack, view, body }) => {
        // Defense in depth, fix round 1: SlackAdapter's own view listener
        // functions (handleConfirmModalSubmission, handleEditModalSubmission)
        // already catch everything internally and never reject this
        // promise, but if something upstream of that ever did (decoding
        // `body`, a bug in a future listener), an unacked modal hangs until
        // Slack's own timeout, which is strictly worse than a generic,
        // truthful error. This still acks with one rather than leaving the
        // operator staring at a modal that can never close on its own.
        try {
          const raw = body as unknown as { user: { id: string } }
          const response = await listener({
            view: view as unknown as SlackViewSubmissionEnvelope['view'],
            user: raw.user,
          })
          if (response) await ack(response)
          else await ack()
        } catch {
          const blockId = callbackId === EDIT_MODAL_CALLBACK_ID ? EDIT_MODAL_BLOCK_ID : CONFIRM_MODAL_BLOCK_ID
          await ack({
            response_action: 'errors',
            errors: { [blockId]: 'Something went wrong; your decision was not recorded. Please try again.' },
          }).catch(() => {})
        }
      })
    },
    start: () => app.start(),
    stop: async () => {
      await app.stop()
    },
  }
}

/** Slack writes a user mention as `<@U123>`, or `<@U123|label>` in older payloads. */
export function mentionsUser(text: string, userId: string): boolean {
  return text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`)
}

function isAlreadyReacted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const data = (error as { data?: { error?: unknown } }).data
  return data?.error === 'already_reacted'
}

export function createLiveSlackApiClient(botToken: string): SlackApiClient {
  // rejectRateLimitedCalls: true means a 429 surfaces as a
  // WebAPIRateLimitedError immediately rather than the library retrying
  // silently on its own undocumented schedule; #callApi is the one place
  // that decides how Relay retries, so its behaviour is provably the same
  // whether this is a real WebClient or a test stub.
  const client = new WebClient(botToken, { rejectRateLimitedCalls: true })

  return {
    async authTest() {
      const result = await client.auth.test()
      const botUserId = typeof result.user_id === 'string' ? result.user_id : undefined
      const platformTeamId = typeof result.team_id === 'string' ? result.team_id : undefined
      if (!botUserId || !platformTeamId) {
        throw new Error('SlackAdapter: auth.test did not return both user_id and team_id')
      }
      return { botUserId, platformTeamId }
    },
    async postMessage(args) {
      const result = await client.chat.postMessage({
        channel: args.channel,
        text: args.text,
        ...(args.thread !== undefined ? { thread_ts: args.thread } : {}),
        ...(args.blocks !== undefined ? { blocks: args.blocks } : {}),
      })
      const ts = typeof result.ts === 'string' ? result.ts : undefined
      if (!ts) throw new Error('SlackAdapter: chat.postMessage did not return a ts')
      // A post to a user id lands in that user's DM, whose channel id only the response names.
      return typeof result.channel === 'string' ? { ts, channel: result.channel } : { ts }
    },
    async updateMessage(args) {
      const result = await client.chat.update({
        channel: args.channel,
        ts: args.ts,
        text: args.text,
        ...(args.blocks !== undefined ? { blocks: args.blocks } : {}),
      })
      const ts = typeof result.ts === 'string' ? result.ts : undefined
      if (!ts) throw new Error('SlackAdapter: chat.update did not return a ts')
      return { ts }
    },
    async uploadFile(args) {
      // Built as a mutable record rather than a typed literal: uploadV2's
      // argument type is a union keyed on which destination and thread
      // fields are present at all, which exactOptionalPropertyTypes will
      // not accept from a conditionally spread optional key. The cast on
      // the call below is the one place that type gets reasserted.
      const params: Record<string, unknown> = {
        channel_id: args.channel,
        filename: args.filename,
        file: Buffer.from(args.bytes),
      }
      if (args.comment !== undefined) params.initial_comment = args.comment
      if (args.thread !== undefined) params.thread_ts = args.thread
      await client.files.uploadV2(params as unknown as Parameters<typeof client.files.uploadV2>[0])
    },
    async openModal(args) {
      await client.views.open({
        trigger_id: args.triggerId,
        view: args.view as unknown as Parameters<typeof client.views.open>[0]['view'],
      })
    },
    async addReaction(args) {
      try {
        await client.reactions.add({ channel: args.channel, timestamp: args.ts, name: args.name })
      } catch (error) {
        if (isAlreadyReacted(error)) return
        throw error
      }
    },
  }
}

/** Reads a secret by name, converting "not found" into an error that names the secret and never the value, per FR-SLA-6 and the startup error requirement. */
export async function readRequiredSecret(secrets: SecretProvider, name: string): Promise<string> {
  try {
    return await secrets.get(name)
  } catch (error) {
    if (error instanceof SecretNotFoundError) {
      throw new Error(
        `SlackAdapter cannot start: secret "${name}" is not configured. Store it in the ` +
          'Keychain (or the configured secret provider) before starting the adapter.',
      )
    }
    throw error
  }
}
