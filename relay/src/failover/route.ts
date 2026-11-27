/**
 * Which laptop answers a Slack envelope (README, "Failover"). Both laptops
 * stay connected; Slack hands each envelope to one of them. That laptop
 * saves it (src/failover/inbound.ts), then decides:
 *
 *   1. a laptop named as the first word after the mention
 *      ("@relay zubair-mbp hi"), or "<laptop> is offline" when it is not ready;
 *   2. otherwise the laptop that owns the thread, while it is ready;
 *   3. a Slackbot reminder: the laptop whose config lists that channel;
 *   4. otherwise the default laptop (the failover record), else this one.
 *
 * A button goes to the laptop that posted it, a popup to the laptop named in
 * its metadata. An envelope for another laptop is passed through the
 * database and that laptop is woken by a notify, with a 2 second poll as the
 * backstop. Naming a laptop in a thread another laptop owns makes it a guest
 * turn there (decision 2): the owner's work is left alone.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Notification, Pool } from 'pg'
import type { Logger } from 'pino'
import { SHELL_PASSWORD_CALLBACK_ID } from '../chat/slack/shell-password.js'
import { composeThreadRef } from '../chat/slack/events.js'
import { liveHolder, readyHosts, reminderHost } from './lease.js'
import {
  acceptInbound,
  answerInbound,
  claimNoteKey,
  buttonMessageHost,
  claimInbound,
  closeInboundWait,
  finishInbound,
  forwardInbound,
  inboundIdentity,
  pruneInbound,
  readInboundResponse,
  reclaimInbound,
  saveInbound,
  threadOwner,
  type InboundRow,
} from './inbound.js'

/** The notify channel a laptop listens on for envelopes passed to it. */
export const INBOUND_CHANNEL = 'relay_inbound'
/** How long the laptop that received a popup waits for its owner's answer; Slack allows 3 seconds. */
export const POPUP_WAIT_MS = 2500

/** Bolt's receiver event: the envelope and its acknowledgement. */
export type ReceivedEnvelope = {
  readonly body: Record<string, unknown>
  readonly ack: (response?: unknown) => Promise<void>
  readonly retryNum?: number
  readonly retryReason?: string
  readonly customProperties?: Record<string, unknown>
}
export type ProcessEnvelope = (event: ReceivedEnvelope) => Promise<void>

/** Thrown before an envelope is acknowledged, so Slack sends it again. */
export class EnvelopeNotSavedError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`the envelope was not saved (${reason}); Slack will send it again`, options)
    this.name = 'EnvelopeNotSavedError'
  }
}

/** Set on the envelope body by the router; the adapter reads it. Never taken from Slack's own payload. */
export const ROUTE_FIELD = 'relay_route'
export type RouteNote = {
  readonly inboundId: string
  /** Set on a guest turn: the laptop named in a thread another laptop owns. */
  readonly guestHost?: string
}

export function routeNoteOf(body: Record<string, unknown>): RouteNote | undefined {
  const note = body[ROUTE_FIELD]
  return typeof note === 'object' && note !== null && typeof (note as RouteNote).inboundId === 'string' ? (note as RouteNote) : undefined
}

export type Decision =
  | { readonly kind: 'here'; readonly guestHost?: string }
  | { readonly kind: 'forward'; readonly target: string; readonly explicit: boolean; readonly guestHost?: string }
  | { readonly kind: 'offline'; readonly name: string }

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const obj = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** The word after a leading mention of the bot, when it is a laptop's name. */
export function namedLaptop(text: string, botUserId: string, laptops: readonly string[]): string | undefined {
  const match = new RegExp(`^\\s*<@${botUserId}(?:\\|[^>]*)?>\\s+([A-Za-z0-9._-]+)`).exec(text)
  const word = match?.[1]?.toLowerCase()
  // Case does not matter: "@relay Zubair-MBP" names zubair-mbp.
  return word === undefined ? undefined : laptops.find((laptop) => laptop.toLowerCase() === word)
}

/**
 * The message text with the laptop's name taken out, so the prompt is what
 * came after it. "@relay zubair-mbp stop" becomes plain "stop" (and the same
 * for "relay end"), so it stops that laptop's turn the way a plain stop does.
 */
export function withoutLaptopName(text: string, botUserId: string, name: string): string {
  const stripped = text.replace(new RegExp(`^(\\s*<@${botUserId}(?:\\|[^>]*)?>)\\s+${name.replace(/[.]/g, '\\.')}(?=\\s|$)`, 'i'), '$1')
  if (stripped === text) return text
  const rest = stripped.replace(new RegExp(`^\\s*<@${botUserId}(?:\\|[^>]*)?>\\s*`), '')
  return ['stop', 'relay end'].includes(rest.trim().toLowerCase()) ? rest.trim() : stripped
}

export function offlineText(name: string): string {
  return `\`${name}\` is offline right now, so it cannot answer. Ask again once it is back, or ask without naming a laptop.`
}

export function queuedText(owner: string): string {
  return `This thread's run is still going on \`${owner}\`, which is offline right now; your message is queued for it. Say stop to end it and carry on here.`
}

// ---------------------------------------------------------------------------
// Password popups: their value is encrypted with the laptops' shared forward
// key (keychain item relay-forward-key) before the envelope is saved.
// ---------------------------------------------------------------------------

function cipherKey(forwardKey: string): Buffer {
  return createHash('sha256').update(forwardKey).digest()
}

export function sealSecret(forwardKey: string, plain: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', cipherKey(forwardKey), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

export function openSecret(forwardKey: string, sealed: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', cipherKey(forwardKey), sealed.subarray(0, 12))
  decipher.setAuthTag(sealed.subarray(12, 28))
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8')
}

function isPasswordView(body: Record<string, unknown>): boolean {
  return body.type === 'view_submission' && obj(body.view)?.callback_id === SHELL_PASSWORD_CALLBACK_ID
}

/** The body as saved: a password popup's typed values are taken out (and sealed when a forward key is set). */
export function splitSecret(body: Record<string, unknown>, forwardKey: string | undefined): { payload: Record<string, unknown>; secret: Buffer | null } {
  if (!isPasswordView(body)) return { payload: body, secret: null }
  const view = obj(body.view) ?? {}
  const state = view.state
  const payload = { ...body, view: { ...view, state: { values: {} } } }
  return { payload, secret: forwardKey === undefined ? null : sealSecret(forwardKey, JSON.stringify(state ?? {})) }
}

function joinSecret(payload: Record<string, unknown>, secret: Buffer | null, forwardKey: string | undefined): Record<string, unknown> {
  if (secret === null || forwardKey === undefined) return payload
  const view = obj(payload.view) ?? {}
  return { ...payload, view: { ...view, state: JSON.parse(openSecret(forwardKey, secret)) as unknown } }
}

// ---------------------------------------------------------------------------

export type InboundRouterDeps = {
  readonly pool: Pool
  readonly host: string
  readonly log: Logger
  /** The laptops' shared key for password popups; without it they are answered only where they land. */
  readonly forwardKey?: string
  /**
   * Opens the dedicated connection notifies arrive on: its own, outside the
   * pool, which it would otherwise hold for good. Absent means the 2 second
   * poll alone.
   */
  readonly connectListener?: () => Promise<ListenConnection>
  readonly pollMs?: number
  readonly popupWaitMs?: number
}

/** The part of a pg Client the listener uses. */
export type ListenConnection = {
  query(text: string): Promise<unknown>
  on(event: 'notification', listener: (message: Notification) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  end(): Promise<void>
}

/** Set once the Slack adapter knows them; envelopes before that are left unacknowledged. */
export type RouterBinding = {
  readonly workspaceId: string
  readonly botUserId: string
  /** Posts a line in a thread from this laptop (the offline and queued notes). */
  readonly post: (channel: string, threadTs: string, text: string) => Promise<void>
}

export class InboundRouter {
  readonly #deps: InboundRouterDeps
  /** Own rows last touched before this are unfinished work from before this laptop started, picked up again. */
  readonly #heldBefore = new Date()
  #paused = false
  /** Rows saved and acknowledged while paused: resuming handles exactly these. */
  readonly #held = new Set<string>()
  #binding: RouterBinding | undefined
  #process: ProcessEnvelope | undefined
  #timer: NodeJS.Timeout | undefined
  #listener: ListenConnection | undefined
  #stopped = false
  #draining: Promise<void> | undefined
  #lastPrune = 0

  constructor(deps: InboundRouterDeps) {
    this.#deps = deps
  }

  get host(): string {
    return this.#deps.host
  }

  bind(binding: RouterBinding): void {
    this.#binding = binding
  }

  /** The receiver's own processing, for envelopes passed here from the other laptop. */
  useProcessor(process: ProcessEnvelope): void {
    this.#process = process
  }

  /**
   * While paused (the other laptop is applying migrations), envelopes are
   * still saved and acknowledged but not handled; resuming picks them up.
   */
  setPaused(paused: boolean): void {
    this.#paused = paused
    if (!paused) void this.drain()
  }

  /** Called by the receiver on every envelope Slack delivers to this laptop. */
  async handle(event: ReceivedEnvelope, process: ProcessEnvelope): Promise<void> {
    this.#process ??= process
    const identity = inboundIdentity(event.body)
    if (identity === undefined) return process(event)
    const binding = this.#binding
    if (binding === undefined) throw new EnvelopeNotSavedError('Relay is still starting')
    const { payload, secret } = splitSecret(withoutRouteNote(event.body), this.#deps.forwardKey)
    let saved: { row: InboundRow; fresh: boolean }
    try {
      saved = await saveInbound(this.#deps.pool, { workspaceId: binding.workspaceId, ...identity, host: this.#deps.host, payload, secret })
    } catch (error) {
      throw new EnvelopeNotSavedError('the database did not answer', { cause: error })
    }
    if (this.#paused && saved.fresh) {
      this.#held.add(saved.row.id)
      await event.ack()
      return
    }
    if (!saved.fresh) {
      // A second delivery: a popup gets the answer the first one got, when there is one.
      const response = identity.kind === 'view' ? await readInboundResponse(this.#deps.pool, saved.row.id).catch(() => null) : null
      await event.ack(isAnswer(response) ? response : undefined)
      return
    }
    const decision = await this.decide(event.body, binding, saved.row.id).catch((error: unknown) => {
      this.#deps.log.warn({ err: error }, 'could not decide which laptop answers; answering here')
      return { kind: 'here' } as Decision
    })
    await this.#apply(saved.row, event, decision, binding, payload, true)
  }

  /** Where an envelope goes; see the file comment. */
  async decide(body: Record<string, unknown>, binding: RouterBinding, inboundId?: string): Promise<Decision> {
    const pool = this.#deps.pool
    const here = this.#deps.host
    const ready = await readyHosts(pool)
    const isReady = (name: string | null | undefined): name is string => name !== null && name !== undefined && ready.includes(name)
    const toward = (target: string, explicit: boolean, guestHost?: string): Decision =>
      target === here
        ? { kind: 'here', ...(guestHost !== undefined ? { guestHost } : {}) }
        : { kind: 'forward', target, explicit, ...(guestHost !== undefined ? { guestHost } : {}) }

    if (body.type === 'block_actions') {
      const channel = str(obj(body.channel)?.id)
      const message = obj(body.message)
      const ts = str(message?.ts)
      if (channel === undefined || ts === undefined) return { kind: 'here' }
      const poster = await buttonMessageHost(pool, binding.workspaceId, channel, ts)
      if (isReady(poster)) return toward(poster, false)
      const owner = await threadOwner(pool, binding.workspaceId, composeThreadRef(channel, str(message?.thread_ts) ?? ts))
      return isReady(owner) ? toward(owner, false) : { kind: 'here' }
    }
    if (body.type === 'view_submission') {
      const named = popupHost(str(obj(body.view)?.private_metadata))
      return isReady(named) ? toward(named, false) : { kind: 'here' }
    }

    const event = obj(body.event) ?? {}
    const channel = str(event.channel)
    const ts = str(event.ts)
    if (channel === undefined || ts === undefined) return { kind: 'here' }
    const text = str(event.text) ?? ''
    const threadRef = composeThreadRef(channel, str(event.thread_ts) ?? ts)
    const laptops = (await pool.query<{ name: string }>('SELECT name FROM failover_hosts')).rows.map((row) => row.name)
    const named = namedLaptop(text, binding.botUserId, laptops)
    const owner = await threadOwner(pool, binding.workspaceId, threadRef)
    if (named !== undefined) {
      if (!isReady(named)) return { kind: 'offline', name: named }
      return toward(named, true, owner !== undefined && owner !== named ? named : undefined)
    }
    if (event.user === 'USLACKBOT' && text.startsWith('Reminder: ')) {
      const pinned = await reminderHost(pool, channel)
      return isReady(pinned) ? toward(pinned, false) : { kind: 'here' }
    }
    if (isReady(owner)) return toward(owner, false)
    if (owner !== undefined && inboundId !== undefined) await this.#noteQueued(binding, inboundId, threadRef, owner, channel, str(event.thread_ts))
    const holder = await liveHolder(pool)
    if (isReady(holder)) return toward(holder, false)
    return { kind: 'here' }
  }

  /** Starts picking up envelopes passed to this laptop: on a notify, and every 2 seconds. */
  async start(): Promise<void> {
    this.#stopped = false
    await this.#listen()
    const poll = (): void => {
      if (this.#stopped) return
      this.#timer = setTimeout(() => {
        void this.drain().finally(poll)
      }, this.#deps.pollMs ?? 2000)
    }
    poll()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#timer)
    const listener = this.#listener
    this.#listener = undefined
    if (listener) await listener.end().catch(() => undefined)
    await this.#draining
  }

  /** Handles every row this laptop should handle now; one pass at a time. */
  async drain(): Promise<void> {
    if (this.#draining) return this.#draining
    this.#draining = this.#drainOnce().finally(() => {
      this.#draining = undefined
    })
    return this.#draining
  }

  async #drainOnce(): Promise<void> {
    const binding = this.#binding
    const process = this.#process
    if (binding === undefined || process === undefined || this.#stopped || this.#paused) return
    try {
      if (Date.now() - this.#lastPrune > 3_600_000) {
        this.#lastPrune = Date.now()
        await pruneInbound(this.#deps.pool)
      }
      if (this.#listener === undefined && this.#deps.connectListener !== undefined) await this.#listen()
      for (const id of [...this.#held]) {
        // Kept until the claim succeeds, so a database error leaves it for the next pass.
        const row = await reclaimInbound(this.#deps.pool, id, this.#deps.host)
        this.#held.delete(id)
        if (row !== undefined) await this.#pickUp(row, binding, process)
      }
      for (;;) {
        const rows = await claimInbound(this.#deps.pool, binding.workspaceId, this.#deps.host, this.#heldBefore)
        if (rows.length === 0) return
        for (const row of rows) await this.#pickUp(row, binding, process)
      }
    } catch (error) {
      this.#deps.log.warn({ err: error }, 'could not pick up envelopes passed to this laptop; trying again shortly')
    }
  }

  async #pickUp(row: InboundRow, binding: RouterBinding, process: ProcessEnvelope): Promise<void> {
    if (row.payload === null) {
      await finishInbound(this.#deps.pool, row.id)
      return
    }
    let body: Record<string, unknown>
    try {
      body = joinSecret(row.payload, row.secret, this.#deps.forwardKey)
    } catch (error) {
      this.#deps.log.error({ err: error, inboundId: row.id }, 'a password popup passed from the other laptop could not be opened; check that relay-forward-key matches on both laptops')
      await finishInbound(this.#deps.pool, row.id)
      return
    }
    const guestHost = routeNoteOf(row.payload)?.guestHost
    // Passed to this laptop by name or by owner: it answers. Taken back from a laptop gone quiet: routed again.
    const meant = row.targetHost === this.#deps.host
    let decision: Decision
    if (meant) decision = { kind: 'here', ...(guestHost !== undefined ? { guestHost } : {}) }
    else if (row.explicit && row.targetHost !== null) decision = { kind: 'offline', name: row.targetHost }
    else decision = await this.decide(body, binding, row.id)
    const ack = async (response?: unknown): Promise<void> => {
      if (row.kind !== 'view' || response === undefined) return
      if (!(await answerInbound(this.#deps.pool, row.id, response))) await this.#lateAnswer(body, response, binding)
    }
    await this.#apply(row, { body, ack }, decision, binding, row.payload, false)
  }

  async #apply(row: InboundRow, event: ReceivedEnvelope, decision: Decision, binding: RouterBinding, payload: Record<string, unknown>, received: boolean): Promise<void> {
    const pool = this.#deps.pool
    const host = this.#deps.host
    if (decision.kind === 'forward') {
      const note: RouteNote = { inboundId: row.id, ...(decision.guestHost !== undefined ? { guestHost: decision.guestHost } : {}) }
      const passed = { ...stripName(payload, binding.botUserId, decision.explicit ? decision.target : undefined), [ROUTE_FIELD]: note }
      if (row.kind === 'view' && row.secret === null && isPasswordView(event.body) && received) {
        // No forward key: the password cannot be passed on, and it is not saved anywhere.
        await finishInbound(pool, row.id)
        await event.ack({ response_action: 'errors', errors: { [passwordBlock(event.body)]: `This popup belongs to ${decision.target}. Set the relay-forward-key keychain item on both laptops to answer it from here.` } })
        return
      }
      if (!(await forwardInbound(pool, row, host, decision.target, decision.explicit, passed))) return
      await pool.query('SELECT pg_notify($1, $2)', [INBOUND_CHANNEL, decision.target]).catch(() => undefined)
      if (!received) return
      if (row.kind !== 'view') {
        await event.ack()
        return
      }
      await event.ack(await this.#awaitAnswer(row.id))
      return
    }
    if (decision.kind === 'offline') {
      const message = messageOf(event.body)
      if (received) await event.ack()
      if (message === undefined) {
        await finishInbound(pool, row.id)
        return
      }
      // The mention and its plain message copy: only one of them answers.
      if ((await acceptInbound(pool, row, host, `${message.channel}:${message.ts}`)) === 'accepted') {
        await binding.post(message.channel, message.thread ?? message.ts, offlineText(decision.name))
        await finishInbound(pool, row.id)
      }
      return
    }
    // Here: the normal message path, with the route note for the adapter.
    const note: RouteNote = { inboundId: row.id, ...(decision.guestHost !== undefined ? { guestHost: decision.guestHost } : {}) }
    const named = decision.guestHost ?? (row.explicit ? host : namedLaptopIn(event.body, binding.botUserId, host))
    const body = { ...stripName(event.body, binding.botUserId, named), [ROUTE_FIELD]: note }
    if (row.kind !== 'event' && (await acceptInbound(pool, row, host)) !== 'accepted') {
      if (received) await event.ack()
      return
    }
    try {
      await (this.#process ?? (async () => undefined))({ ...event, body })
    } finally {
      await finishInbound(pool, row.id).catch((error: unknown) => this.#deps.log.warn({ err: error, inboundId: row.id }, 'could not mark an envelope handled'))
    }
  }

  /**
   * The adapter's duplicate check for one Slack message (`channel:ts`): true
   * when this row may handle it. Without a route note (failover off, or an
   * envelope that was not saved) the adapter's own memory decides alone.
   */
  async claimMessage(body: Record<string, unknown>, messageKey: string): Promise<boolean> {
    const note = routeNoteOf(body)
    if (note === undefined) return true
    const { rows } = await this.#deps.pool.query<{ claim_generation: string; workspace_id: string }>(
      `SELECT claim_generation, workspace_id FROM inbound_events WHERE id = $1 AND claimed_by = $2`,
      [note.inboundId, this.#deps.host],
    )
    const held = rows[0]
    if (!held) return false
    const row = { id: note.inboundId, workspaceId: held.workspace_id, claimGeneration: Number(held.claim_generation) } as InboundRow
    return (await acceptInbound(this.#deps.pool, row, this.#deps.host, messageKey)) === 'accepted'
  }

  async #awaitAnswer(id: string): Promise<unknown> {
    const deadline = Date.now() + (this.#deps.popupWaitMs ?? POPUP_WAIT_MS)
    while (Date.now() < deadline) {
      const response = await readInboundResponse(this.#deps.pool, id).catch(() => null)
      if (isAnswer(response)) return response
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const closed = await closeInboundWait(this.#deps.pool, id).catch(() => ({ answered: false, response: undefined }))
    return closed.answered && isAnswer(closed.response) ? closed.response : undefined
  }

  /** The popup closed before its owner answered: a refusal it would have shown goes to the thread instead. */
  async #lateAnswer(body: Record<string, unknown>, response: unknown, binding: RouterBinding): Promise<void> {
    const errors = obj(obj(response)?.errors)
    if (errors === undefined) return
    const meta = parseJson(str(obj(body.view)?.private_metadata))
    const channel = str(meta?.channel)
    const thread = str(meta?.messageTs)
    if (channel === undefined || thread === undefined) {
      this.#deps.log.warn('a popup answer came after the popup closed, with nowhere to post it')
      return
    }
    await binding.post(channel, thread, `That was not applied: ${Object.values(errors).map(String).join(' ')}`)
  }

  /** One note per outage of the owner, across both laptops: keyed on the thread and when the owner was last seen. */
  async #noteQueued(binding: RouterBinding, inboundId: string, threadRef: string, owner: string, channel: string, threadTs: string | undefined): Promise<void> {
    if (threadTs === undefined) return
    const { rows } = await this.#deps.pool.query<{ seen: string }>(
      `SELECT floor(extract(epoch FROM h.last_seen_at))::bigint::text AS seen
         FROM autonomous_tasks t JOIN sessions s ON s.id = t.session_id JOIN failover_hosts h ON h.name = t.worker_host
        WHERE s.workspace_id = $1 AND s.adapter = 'slack' AND s.thread_ref = $2 AND s.guest_host IS NULL AND s.state = 'active'
          AND t.worker_pgid IS NOT NULL AND t.worker_host = $3`,
      [binding.workspaceId, threadRef, owner],
    )
    const seen = rows[0]?.seen
    if (seen === undefined) return
    if (!(await claimNoteKey(this.#deps.pool, binding.workspaceId, `queued:${threadRef}:${seen}`, inboundId))) return
    await binding.post(channel, threadTs, queuedText(owner)).catch((error: unknown) => this.#deps.log.warn({ err: error }, 'could not post the queued note'))
  }

  async #listen(): Promise<void> {
    const connect = this.#deps.connectListener
    if (this.#stopped || connect === undefined) return
    let connection: ListenConnection | undefined
    try {
      connection = await connect()
      const held = connection
      held.on('notification', (message) => {
        if (message.channel === INBOUND_CHANNEL && message.payload === this.#deps.host) void this.drain()
      })
      held.on('error', (error) => {
        this.#deps.log.warn({ err: error }, 'the inbound listening connection failed; the 2 second poll carries on and it reconnects')
        if (this.#listener === held) this.#listener = undefined
        void held.end().catch(() => undefined)
      })
      await held.query(`LISTEN ${INBOUND_CHANNEL}`)
      if (this.#stopped) {
        await held.end().catch(() => undefined)
        return
      }
      this.#listener = held
    } catch (error) {
      await connection?.end().catch(() => undefined)
      this.#deps.log.warn({ err: error }, 'could not listen for envelopes passed to this laptop; polling every 2 seconds')
    }
  }
}

function isAnswer(response: unknown): boolean {
  return response !== null && response !== undefined && !(typeof response === 'object' && (response as { closed?: unknown }).closed === true)
}

function parseJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  try {
    return obj(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** The laptop a popup's hidden metadata names (src/chat/slack/api-client.ts adds it when the popup opens). */
export function popupHost(privateMetadata: string | undefined): string | undefined {
  return str(parseJson(privateMetadata)?.relay_host)
}

function passwordBlock(body: Record<string, unknown>): string {
  const values = obj(obj(obj(body.view)?.state)?.values)
  return Object.keys(values ?? {})[0] ?? 'shell_password'
}

function withoutRouteNote(body: Record<string, unknown>): Record<string, unknown> {
  if (!(ROUTE_FIELD in body)) return body
  const { [ROUTE_FIELD]: _dropped, ...rest } = body
  return rest
}

function messageOf(body: Record<string, unknown>): { channel: string; ts: string; thread?: string } | undefined {
  const event = obj(body.event)
  const channel = str(event?.channel)
  const ts = str(event?.ts)
  if (channel === undefined || ts === undefined) return undefined
  const thread = str(event?.thread_ts)
  return { channel, ts, ...(thread !== undefined ? { thread } : {}) }
}

function namedLaptopIn(body: Record<string, unknown>, botUserId: string, host: string): string | undefined {
  const text = str(obj(body.event)?.text)
  return text !== undefined && namedLaptop(text, botUserId, [host]) === host ? host : undefined
}

/** The event body with "@relay <name>" turned into "@relay", so the prompt starts after the name. */
function stripName(body: Record<string, unknown>, botUserId: string, name: string | undefined): Record<string, unknown> {
  const event = obj(body.event)
  const text = str(event?.text)
  if (name === undefined || event === undefined || text === undefined) return body
  return { ...body, event: { ...event, text: withoutLaptopName(text, botUserId, name) } }
}
