/**
 * One tier 2 page, and the primitives a run drives it with.
 *
 * WHERE ORIGIN SCOPING IS ACTUALLY ENFORCED. FR-PRF-4 says that on tiers 2
 * and 3 "navigation to an off-allowlist origin is prevented outright." A
 * check performed only in `navigate()` would not deliver that, and it is
 * worth being precise about why, because the weaker version looks
 * identical from the outside:
 *
 *   - A page can navigate itself. A meta refresh, a `location.assign`, a
 *     301 to another host, a link the driver clicked. None of those pass
 *     through `navigate()`.
 *   - A page can fetch. An image, a script, an XHR to a third party. Those
 *     never pass through `navigate()` either, and they carry the profile's
 *     cookies just the same.
 *
 * So enforcement lives in the CDP `Fetch` domain instead: every request the
 * page makes, of any kind, is paused before it leaves the browser, checked
 * against the guard, and either continued or failed with
 * `BlockedByClient`. That is prevention by the driver Relay owns, which is
 * exactly what the requirement distinguishes from tier 1's
 * refuse-at-request-time. `navigate()` ALSO checks up front, which is not
 * redundant: it produces a clear refusal naming the profile, before a
 * browser-level error text has to be reverse-engineered into one.
 *
 * EVERY PAUSED REQUEST MUST BE ANSWERED. An intercepted request that is
 * neither continued nor failed hangs that request forever, and a page
 * waiting on it never finishes loading. The handler therefore has no path
 * that returns without answering, including its own error paths: if the
 * guard itself throws, the request is failed, not dropped. This is the one
 * invariant in this file worth re-reading a change against.
 *
 * DIALOGS (FR-BR-6). `alert`, `confirm`, `prompt` and `beforeunload` block
 * the renderer until something answers them, and nothing in a headless
 * browser will. Every dialog is answered automatically and RECORDED, so a
 * run report can say "this page asked something and Relay dismissed it"
 * rather than silently swallowing a question that may have mattered.
 */

import { CdpProtocolError, CdpTransportError } from '../cdp/connection.js'
import type { CdpConnection } from '../cdp/connection.js'
import { destinationHost, isNavigableUrl } from '../url.js'
import type { PageObservation } from './blocked.js'
import { buildRedactionCleanupScript, buildRedactionScript, decideRedaction } from './redact.js'
import type { RedactionReport, ScreenshotRedaction } from './redact.js'

/**
 * The decision this page asks about every request. Supplied by the caller,
 * which is what keeps the policy layer out of the driver: this file knows
 * only that some requests are refused and that a refusal has a reason.
 */
export type NavigationGuard = (url: string) => NavigationGuardVerdict
export type NavigationGuardVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: string }

/** A request the guard refused, recorded so the run report can list what was actually kept out rather than claiming enforcement in the abstract. */
export type BlockedRequest = {
  readonly url: string
  readonly host: string
  readonly resourceType: string
  readonly reason: string
}

/** A dialog the page opened and this driver answered. FR-BR-6's "detected and handled rather than blocking", with the evidence kept. */
export type DialogRecord = {
  readonly type: string
  readonly message: string
  readonly accepted: boolean
}

export type ConsoleRecord = {
  readonly level: string
  readonly text: string
}

export type NetworkRecord = {
  readonly url: string
  readonly method: string
  readonly status: number | undefined
  readonly resourceType: string | undefined
}

/**
 * What a page stopped capturing, and why.
 *
 * A busy page can emit thousands of console lines and network events, and
 * every one of them would otherwise end up in a capability result, a step
 * row in Postgres, and eventually a model's context. So capture is
 * bounded, and the bound is REPORTED rather than applied quietly: a report
 * listing 200 requests when 4,000 were made is a more damaging lie than
 * one that says so.
 */
export type CaptureLimits = {
  readonly consoleDropped: number
  readonly networkDropped: number
  readonly textTruncated: boolean
}

/** How many console messages and network records one page keeps. Chosen to be far more than a task ever reads and far less than a runaway page can produce. */
export const MAX_CAPTURED_RECORDS = 200

/** The cap on a single text or HTML read, in characters. A page over this is truncated with a marker naming the original size, never silently cut. */
export const MAX_READ_CHARACTERS = 100_000

/**
 * The cap on a screenshot, in base64 characters (roughly 3 MB of PNG).
 * Over it, the screenshot is REFUSED with its size rather than truncated:
 * half a base64 PNG is not a smaller image, it is a corrupt one, and
 * handing a caller a corrupt image labelled as a screenshot is worse than
 * handing it a stated refusal.
 */
export const MAX_SCREENSHOT_BASE64_CHARACTERS = 4_000_000

export type ScreenshotResult =
  | { readonly ok: true; readonly data: string }
  | { readonly ok: false; readonly reason: string }

/**
 * How a caller names the element it wants, per FR-BR-7.
 *
 * Every field is optional and at least one must be given; the ladder in
 * `resolveTarget` tries them in the requirement's own order. A caller may
 * supply more than one, and that is the useful case rather than a
 * contradiction: role and name for the page as it is today, a selector as
 * the fallback for when the accessible name changes.
 */
export type ElementTarget = {
  readonly role?: string
  readonly name?: string
  readonly selector?: string
  /** Visible text the element contains. Named for what it matches, not just `text`, so it can never be confused with the text a `type` step types. */
  readonly hasText?: string
}

/** One thing on the page a task could act on. `backendNodeId` is Chrome's own stable handle for the node, which every interaction below acts through. */
export type PageElement = {
  readonly role: string
  readonly name: string
  readonly backendNodeId: number
}

type ResolvedTarget =
  | { readonly ok: true; readonly ambiguous: false; readonly backendNodeId: number }
  /** `ambiguous` stops the ladder: more than one element matched this rung, and falling through to a weaker rung would quietly resolve something the caller did not ask for. */
  | { readonly ok: false; readonly ambiguous: boolean; readonly reason: string }

/**
 * The accessibility roles worth showing a caller, which is to say the ones
 * a task can act on.
 *
 * An allowlist rather than "everything that is not a heading", because a
 * real page's accessibility tree is mostly structure (generic, group,
 * paragraph, LineBreak) and a list dominated by those is a list nobody
 * reads.
 */
const INTERACTIVE_AX_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
])

/** How many elements `readElements` reports. A bound on what reaches a step result and a model's context, not a claim that a page has no more. */
export const MAX_REPORTED_ELEMENTS = 200

/** An AX property's value, which CDP wraps in a `{ type, value }` object rather than giving plainly. */
function axValue(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = (raw as Record<string, unknown>)['value']
  return typeof value === 'string' ? value : undefined
}

/** How a target is named in a reason string, so a failure says what was asked for rather than "the element". */
export function describeTarget(target: ElementTarget): string {
  const parts: string[] = []
  if (target.role !== undefined) parts.push(`role "${target.role}"`)
  if (target.name !== undefined) parts.push(`name "${target.name}"`)
  if (target.selector !== undefined) parts.push(`selector "${target.selector}"`)
  if (target.hasText !== undefined) parts.push(`text "${target.hasText}"`)
  return parts.length > 0 ? parts.join(' + ') : 'an unspecified element'
}

export type NavigateResult =
  /** The navigation completed and the document loaded. `status` is the main document's HTTP status where one was observed. */
  | { readonly outcome: 'loaded'; readonly url: string; readonly status: number | undefined }
  /**
   * The URL turned out to be a download rather than a page.
   *
   * Its own outcome because the alternative is a bug that looks like a
   * hang: a download fires no load event, so waiting for one means waiting
   * out the full navigation timeout and then reporting "did not finish
   * loading" about a file that downloaded perfectly well. Chrome says so in
   * the `Page.navigate` reply, and this reads it.
   */
  | { readonly outcome: 'download_started'; readonly url: string }
  /** Refused before it was issued, by the guard. No request left the browser. */
  | { readonly outcome: 'refused'; readonly url: string; readonly reason: string }
  /** Issued, and the browser could not complete it: a blocked request, a DNS failure, a reset connection. */
  | { readonly outcome: 'failed'; readonly url: string; readonly reason: string }

export type WaitResult =
  | { readonly outcome: 'satisfied'; readonly waitedMs: number }
  | { readonly outcome: 'timed_out'; readonly waitedMs: number; readonly reason: string }

export type Tier2PageOptions = {
  readonly guard: NavigationGuard
  readonly navigationTimeoutMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 100

/** How long a back or forward is given to arrive. Much shorter than a fresh navigation, because a history entry is usually already in the back-forward cache and arrives in milliseconds. */
export const HISTORY_NAVIGATION_TIMEOUT_MS = 5_000

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * The keys `pressKey` can dispatch, with the four fields Chrome needs to
 * treat the event as real: the DOM key name, the physical code, the legacy
 * keyCode, and, for keys that produce a character, the text they insert.
 *
 * An allowlist rather than a computed mapping, because getting `keyCode`
 * wrong produces an event that looks right in the protocol and does
 * nothing in the page, which is a maddening thing to debug. A key that is
 * not here is refused with the list, rather than dispatched with a guessed
 * code.
 */
const KEY_DESCRIPTORS: Readonly<Record<string, Record<string, unknown>>> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
}

function errorText(error: unknown): string {
  if (error instanceof CdpProtocolError || error instanceof CdpTransportError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * The page surface a caller drives, as an interface rather than only as a
 * class.
 *
 * WHY THIS EXISTS, and it is not abstraction for its own sake. `Tier2Page`
 * is a class with private fields, which makes it nominal: no structural
 * object can satisfy its type, so a test double has to be cast past the
 * compiler with `as unknown as Tier2Page`. That cast is a hole, and it
 * cost real time three separate times in one milestone: the double kept
 * being correct for a version of this class that no longer existed
 * (`screenshot` changed its return shape, `captureLimits` was added,
 * `observe` was added), and each time the failure surfaced as a confusing
 * test failure somewhere else rather than as a type error here.
 *
 * A double typed as `DrivablePage` is checked by the compiler against the
 * real surface, so the next method added to that surface breaks the build
 * where the double is written, which is where the fix belongs.
 */
export interface DrivablePage {
  navigate(url: string): Promise<NavigateResult>
  currentUrl(): Promise<string>
  title(): Promise<string>
  readText(): Promise<string>
  readHtml(): Promise<string>
  evaluate<T>(expression: string): Promise<T | undefined>
  waitFor(
    expression: string,
    options?: { readonly timeoutMs?: number; readonly pollIntervalMs?: number },
  ): Promise<WaitResult>
  exists(target: ElementTarget): Promise<boolean>
  readElements(): Promise<readonly PageElement[]>
  click(target: ElementTarget): Promise<{ readonly clicked: boolean; readonly reason?: string }>
  type(
    target: ElementTarget,
    text: string,
    options?: { readonly append?: boolean },
  ): Promise<{ readonly typed: boolean; readonly reason?: string }>
  selectOption(target: ElementTarget, value: string): Promise<{ readonly selected: boolean; readonly reason?: string }>
  pressKey(key: string): Promise<{ readonly pressed: boolean; readonly reason?: string }>
  scrollBy(x: number, y: number): Promise<void>
  screenshot(): Promise<ScreenshotResult>
  exportPdf(): Promise<ScreenshotResult>
  goBack(): Promise<NavigateResult>
  goForward(): Promise<NavigateResult>
  reload(): Promise<NavigateResult>
  hover(target: ElementTarget): Promise<{ readonly hovered: boolean; readonly reason?: string }>
  observe(): Promise<PageObservation>
  close(): Promise<void>
  readonly blockedRequests: readonly BlockedRequest[]
  readonly dialogs: readonly DialogRecord[]
  readonly consoleMessages: readonly ConsoleRecord[]
  readonly networkRequests: readonly NetworkRecord[]
  readonly captureLimits: CaptureLimits
}

/**
 * A page Relay drives over CDP.
 *
 * Constructed by `attachTier2Page` below rather than directly, because a
 * page is only safe to hand to a caller once its interception, dialog, and
 * capture handlers are installed: a page object that existed before them
 * could make an unguarded request.
 */
export class Tier2Page implements DrivablePage {
  private readonly connection: CdpConnection
  readonly sessionId: string
  readonly targetId: string
  private readonly guard: NavigationGuard
  private readonly navigationTimeoutMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly unsubscribes: Array<() => void> = []
  private readonly blocked: BlockedRequest[] = []
  private readonly dialogRecords: DialogRecord[] = []
  private readonly consoleRecords: ConsoleRecord[] = []
  private readonly networkRecords: NetworkRecord[] = []
  /** Request id to its index in `networkRecords`, so a response can fill in the status of the request it answers rather than appending a second, method-less entry for the same exchange. */
  private readonly networkIndexById = new Map<string, number>()
  private readonly documentStatuses = new Map<string, number>()
  private consoleDropped = 0
  private networkDropped = 0
  private textTruncated = false
  private closedState = false

  constructor(connection: CdpConnection, sessionId: string, targetId: string, options: Tier2PageOptions) {
    this.connection = connection
    this.sessionId = sessionId
    this.targetId = targetId
    this.guard = options.guard
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? realSleep
  }

  /** Requests the guard refused, in the order they were refused. FR-PRF-4's evidence that prevention actually happened. */
  get blockedRequests(): readonly BlockedRequest[] {
    return this.blocked
  }

  /** Dialogs this page opened and the driver answered, per FR-BR-6. */
  get dialogs(): readonly DialogRecord[] {
    return this.dialogRecords
  }

  /** FR-BR-5: read console. */
  get consoleMessages(): readonly ConsoleRecord[] {
    return this.consoleRecords
  }

  /** FR-BR-5: read network requests. */
  get networkRequests(): readonly NetworkRecord[] {
    return this.networkRecords
  }

  /** What capture this page had to drop, so a caller reports the bound rather than presenting a truncated list as complete. */
  get captureLimits(): CaptureLimits {
    return {
      consoleDropped: this.consoleDropped,
      networkDropped: this.networkDropped,
      textTruncated: this.textTruncated,
    }
  }

  get closed(): boolean {
    return this.closedState
  }

  /**
   * Installs every handler this page needs before any request can be made.
   * Called by `attachTier2Page`; not part of the public surface, because a
   * page that had it called twice would answer each paused request twice
   * and the second answer would fail.
   */
  async install(): Promise<void> {
    this.subscribe('Fetch.requestPaused', (params) => {
      void this.handlePausedRequest(params)
    })
    this.subscribe('Page.javascriptDialogOpening', (params) => {
      void this.handleDialog(params)
    })
    this.subscribe('Runtime.consoleAPICalled', (params) => {
      this.recordConsole(params)
    })
    this.subscribe('Network.requestWillBeSent', (params) => {
      this.recordRequest(params)
    })
    this.subscribe('Network.responseReceived', (params) => {
      this.recordResponse(params)
    })

    // Order matters: Fetch.enable last of the three domains that can cause
    // traffic, so nothing races ahead of interception being live. In
    // practice the page is about:blank at this point and makes no requests
    // at all, but the ordering costs nothing and removes the question.
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.send('DOM.enable')
    // FR-BR-7's top rung needs the accessibility tree, and the tree is not
    // computed until this domain is on.
    await this.send('Accessibility.enable')
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  }

  private subscribe(method: string, listener: (params: Record<string, unknown>) => void): void {
    this.unsubscribes.push(
      this.connection.on(method, (params, sessionId) => {
        // Every page on this connection sees every event; a page acts only
        // on its own. Without this, two concurrent pages would each answer
        // the other's paused requests, and the second answer would error.
        if (sessionId !== this.sessionId) return
        listener(params)
      }),
    )
  }

  private send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.connection.send(method, params, this.sessionId, timeoutMs)
  }

  // -------------------------------------------------------------------------
  // Interception: the enforcement point.
  // -------------------------------------------------------------------------

  private async handlePausedRequest(params: Record<string, unknown>): Promise<void> {
    const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : undefined
    // The one return without an answer, and it is not an exception to this
    // file's invariant: with no request id there is no request to answer.
    // Every path below this line answers.
    if (requestId === undefined) return

    const request = params['request']
    const url =
      typeof request === 'object' && request !== null && typeof (request as { url?: unknown }).url === 'string'
        ? (request as { url: string }).url
        : ''
    const resourceType = typeof params['resourceType'] === 'string' ? params['resourceType'] : 'Other'

    let verdict: NavigationGuardVerdict
    try {
      verdict = this.guard(url)
    } catch (error) {
      // A guard that throws must not become a request that sails through.
      // Failing closed here is the whole point: an exception in the
      // decision is treated as a refusal, with the exception as the reason.
      verdict = { allowed: false, reason: `the navigation guard threw while deciding ${url}: ${errorText(error)}` }
    }

    if (verdict.allowed) {
      await this.answer(requestId, { continue: true })
      return
    }

    this.blocked.push({ url, host: destinationHost(url), resourceType, reason: verdict.reason })
    await this.answer(requestId, { continue: false })
  }

  /**
   * Answers a paused request, exactly once, and never throws.
   *
   * A `Fetch.continueRequest` or `Fetch.failRequest` can legitimately fail:
   * the request may already be gone because the page navigated away. That
   * is not an error worth propagating into an event handler with no caller
   * to catch it, and there is nothing left to answer at that point anyway.
   */
  private async answer(requestId: string, decision: { readonly continue: boolean }): Promise<void> {
    try {
      if (decision.continue) {
        await this.send('Fetch.continueRequest', { requestId })
      } else {
        await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      }
    } catch {
      // See this method's doc comment.
    }
  }

  private async handleDialog(params: Record<string, unknown>): Promise<void> {
    const type = typeof params['type'] === 'string' ? params['type'] : 'unknown'
    const message = typeof params['message'] === 'string' ? params['message'] : ''
    // Which dialogs are accepted, and why the two cases genuinely differ.
    //
    //   `alert` has only one answer, so accepting it is the only way to
    //   clear it and let the page carry on.
    //
    //   `beforeunload` asks "do you really want to leave this page?" It is
    //   raised in response to a navigation THIS DRIVER just issued, so the
    //   answer is already known: yes. Dismissing it instead would cancel
    //   Relay's own navigation and leave the run stranded on a page it
    //   explicitly asked to leave, which is a deadlock in slow motion
    //   rather than the absence of one FR-BR-6 requires.
    //
    //   `confirm` and `prompt` are the page asking the operator a question
    //   Relay was never given the authority to answer ("delete these
    //   records?"). Those are dismissed, and recorded, so the run can
    //   report that something was asked and left unanswered.
    const accept = type === 'alert' || type === 'beforeunload'
    this.dialogRecords.push({ type, message, accepted: accept })
    try {
      await this.send('Page.handleJavaScriptDialog', { accept })
    } catch {
      // A dialog that has already gone away (the page navigated) cannot be
      // answered; the record above is what the report needs either way.
    }
  }

  /**
   * Records a request as it is sent, which is the ONLY place its HTTP
   * method is available: `Network.responseReceived` does not carry one.
   * An earlier version of this file filled the field with a literal 'GET'
   * for every entry, which meant a report could state that a POST was a
   * GET. A fabricated field in a report an operator relies on is worse
   * than an absent one, so the method now comes from the event that
   * actually knows it.
   */
  private recordRequest(params: Record<string, unknown>): void {
    const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : undefined
    const request = params['request']
    if (requestId === undefined || typeof request !== 'object' || request === null) return
    if (this.networkRecords.length >= MAX_CAPTURED_RECORDS) {
      this.networkDropped++
      return
    }

    const record = request as Record<string, unknown>
    this.networkIndexById.set(requestId, this.networkRecords.length)
    this.networkRecords.push({
      url: typeof record['url'] === 'string' ? record['url'] : '',
      method: typeof record['method'] === 'string' ? record['method'] : 'UNKNOWN',
      status: undefined,
      resourceType: typeof params['type'] === 'string' ? params['type'] : undefined,
    })
  }

  private recordConsole(params: Record<string, unknown>): void {
    if (this.consoleRecords.length >= MAX_CAPTURED_RECORDS) {
      this.consoleDropped++
      return
    }
    const level = typeof params['type'] === 'string' ? params['type'] : 'log'
    const args = Array.isArray(params['args']) ? (params['args'] as Array<Record<string, unknown>>) : []
    const text = args
      .map((arg) => {
        if (arg === null || typeof arg !== 'object') return String(arg)
        if ('value' in arg) return String(arg['value'])
        if (typeof arg['description'] === 'string') return arg['description']
        return typeof arg['type'] === 'string' ? `[${arg['type']}]` : '[object]'
      })
      .join(' ')
    this.consoleRecords.push({ level, text })
  }

  private recordResponse(params: Record<string, unknown>): void {
    const response = params['response']
    if (typeof response !== 'object' || response === null) return
    const record = response as Record<string, unknown>
    const url = typeof record['url'] === 'string' ? record['url'] : ''
    const status = typeof record['status'] === 'number' ? record['status'] : undefined
    const resourceType = typeof params['type'] === 'string' ? params['type'] : undefined

    if (resourceType === 'Document' && status !== undefined) {
      this.documentStatuses.set(url, status)
    }

    // Fills in the status on the request this answers, rather than
    // appending a second entry for one exchange.
    const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : undefined
    const index = requestId === undefined ? undefined : this.networkIndexById.get(requestId)
    const existing = index === undefined ? undefined : this.networkRecords[index]
    if (index !== undefined && existing !== undefined) {
      this.networkRecords[index] = { ...existing, status, ...(resourceType !== undefined ? { resourceType } : {}) }
      return
    }

    // A response with no matching request: the request was dropped by the
    // cap above, or arrived before this page subscribed. Recorded with an
    // honest 'UNKNOWN' method rather than a guessed one.
    if (this.networkRecords.length >= MAX_CAPTURED_RECORDS) {
      this.networkDropped++
      return
    }
    this.networkRecords.push({ url, method: 'UNKNOWN', status, resourceType })
  }

  /** Applies MAX_READ_CHARACTERS, appending a marker that names the original size. Never a silent cut. */
  private boundText(value: string): string {
    if (value.length <= MAX_READ_CHARACTERS) return value
    this.textTruncated = true
    return (
      `${value.slice(0, MAX_READ_CHARACTERS)}\n\n[Relay truncated this read: the page produced ${value.length} ` +
      `characters, over this driver's ${MAX_READ_CHARACTERS} character bound. Only the beginning is shown.]`
    )
  }

  // -------------------------------------------------------------------------
  // Primitives.
  // -------------------------------------------------------------------------

  /**
   * FR-BR-5's navigate, with the guard applied before the instruction is
   * issued as well as by interception once it is.
   *
   * Waits for the load event rather than returning as soon as CDP accepts
   * the command: a caller that reads the page immediately after an
   * un-awaited navigation reads the previous document, which is the kind of
   * flake that gets diagnosed as "the extraction is unreliable".
   */
  async navigate(url: string): Promise<NavigateResult> {
    if (!isNavigableUrl(url)) {
      return {
        outcome: 'refused',
        url,
        reason: `"${url}" is not an http or https URL with a host, so no origin allowlist can bound it and it is refused`,
      }
    }

    const verdict = this.guard(url)
    if (!verdict.allowed) {
      return { outcome: 'refused', url, reason: verdict.reason }
    }

    const loaded = this.oncePageEvent('Page.loadEventFired')
    let navigation: Record<string, unknown>
    try {
      navigation = await this.send('Page.navigate', { url })
    } catch (error) {
      loaded.cancel()
      return { outcome: 'failed', url, reason: `navigation to ${url} could not be issued: ${errorText(error)}` }
    }

    if (navigation['isDownload'] === true) {
      loaded.cancel()
      return { outcome: 'download_started', url }
    }

    const browserError = navigation['errorText']
    if (typeof browserError === 'string' && browserError.length > 0) {
      loaded.cancel()
      return { outcome: 'failed', url, reason: `the browser refused to load ${url}: ${browserError}` }
    }

    const settled = await loaded.wait(this.navigationTimeoutMs)
    if (!settled) {
      return {
        outcome: 'failed',
        url,
        reason: `${url} did not finish loading within ${this.navigationTimeoutMs}ms`,
      }
    }

    const finalUrl = await this.currentUrl()
    return { outcome: 'loaded', url: finalUrl, status: this.documentStatuses.get(finalUrl) }
  }

  /**
   * FR-BR-8 and FR-BR-10: everything `detectHumanBlock` needs, gathered
   * from the page as it is right now.
   *
   * Deliberately a separate call rather than something `navigate()` does
   * automatically. Reading the text and HTML of a page costs two round
   * trips, and a caller that has just navigated somewhere it does not
   * intend to read should not pay for them. The capability calls it once,
   * after the steps have run, which is where a report is actually built.
   */
  async observe(): Promise<PageObservation> {
    const url = await this.currentUrl()
    return {
      url,
      title: await this.title(),
      text: await this.readText(),
      html: await this.readHtml(),
      status: this.documentStatuses.get(url),
    }
  }

  /** FR-BR-5: the URL actually reached, which is not necessarily the one asked for once redirects are involved. */
  async currentUrl(): Promise<string> {
    const result = await this.evaluate<string>('window.location.href')
    return result ?? ''
  }

  async title(): Promise<string> {
    const result = await this.evaluate<string>('document.title')
    return result ?? ''
  }

  /** FR-BR-5: read page as text. `innerText` rather than `textContent`, because it reflects what is actually visible: hidden elements and script bodies are excluded. */
  async readText(): Promise<string> {
    const result = await this.evaluate<string>('document.body ? document.body.innerText : ""')
    return this.boundText(result ?? '')
  }

  /** FR-BR-5: read page as HTML, for extraction that needs structure text has thrown away. */
  async readHtml(): Promise<string> {
    const result = await this.evaluate<string>('document.documentElement ? document.documentElement.outerHTML : ""')
    return this.boundText(result ?? '')
  }

  /**
   * FR-BR-5's gated "execute page script".
   *
   * Returns `undefined` where the expression threw or produced something
   * that cannot cross the protocol by value, rather than throwing: every
   * caller in this file treats a failed read as "no value", and an
   * exception here would turn a page quirk into a run failure.
   */
  async evaluate<T>(expression: string): Promise<T | undefined> {
    let result: Record<string, unknown>
    try {
      result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    } catch {
      return undefined
    }
    if (result['exceptionDetails'] !== undefined) return undefined
    const remote = result['result']
    if (typeof remote !== 'object' || remote === null) return undefined
    const value = (remote as Record<string, unknown>)['value']
    return value === undefined ? undefined : (value as T)
  }

  /**
   * FR-BR-5: wait for condition. Polls a JavaScript expression until it is
   * truthy, or the timeout elapses.
   *
   * Polling rather than a CDP event subscription because the conditions a
   * task actually waits for ("the row count stopped changing", "the spinner
   * went away") are page-state questions with no corresponding protocol
   * event. A timeout is a stated outcome, never an exception.
   */
  async waitFor(
    expression: string,
    options: { readonly timeoutMs?: number; readonly pollIntervalMs?: number } = {},
  ): Promise<WaitResult> {
    const timeoutMs = options.timeoutMs ?? this.navigationTimeoutMs
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS
    const start = this.now()

    for (;;) {
      const value = await this.evaluate<unknown>(`Boolean(${expression})`)
      if (value === true) return { outcome: 'satisfied', waitedMs: this.now() - start }
      const elapsed = this.now() - start
      if (elapsed >= timeoutMs) {
        return {
          outcome: 'timed_out',
          waitedMs: elapsed,
          reason: `the condition "${expression}" was still not true after ${timeoutMs}ms`,
        }
      }
      await this.sleep(Math.min(pollIntervalMs, timeoutMs - elapsed))
    }
  }

  // -------------------------------------------------------------------------
  // Element interaction, and FR-BR-7's resolution ladder.
  //
  // FR-BR-7: "element resolution prefers accessible ROLE AND NAME, then
  // stable attributes, then TEXT, then position. Failures record the full
  // accessibility snapshot for later learning."
  //
  // The order is not a preference about tidiness. A CSS selector encodes
  // how a page is BUILT: a class name, a generated id, a nesting depth, all
  // of which change when someone restyles a page that still does exactly
  // the same thing. An accessible role and name encode what an element IS
  // and what it SAYS, which is the part a task actually depends on. "The
  // button called Sign in" survives a redesign that breaks
  // "button.btn-primary.mt-4 > span".
  //
  // There is a second reason, specific to this system: a model choosing a
  // step has not seen the page. Asking it to invent CSS selectors is asking
  // it to guess. Asking it for a role and a name is asking it for something
  // `read_elements` can show it first.
  //
  // AMBIGUITY IS REFUSED, NOT RESOLVED. Where a role and name match more
  // than one element, this file does not pick the first: it reports the
  // count and refuses, matching how FR-PRF-3 handles an ambiguous profile.
  // Clicking the wrong "Delete" is exactly the failure that rule exists to
  // prevent.
  //
  // ON FAILURE, THE SNAPSHOT IS RECORDED, per the requirement's second
  // sentence: a failed resolution returns the page's own interactive
  // elements in its reason, so the caller (and the operator reading the
  // report) can see what WAS there instead.
  //
  // EVENTS ARE DISPATCHED THROUGH THE INPUT DOMAIN, not through
  // `element.click()` in page script. A synthetic click made from page
  // script is `isTrusted: false`, which real applications legitimately
  // reject, and it bypasses hit testing entirely: an element covered by a
  // modal overlay would be "clicked" even though a person could not click
  // it. Dispatching a real mouse event at the element's own coordinates
  // means an obscured element genuinely does not get clicked, which is the
  // truthful answer.
  // -------------------------------------------------------------------------

  /** The document's root node id, needed as the scope for every DOM and accessibility query below. */
  private async documentRootNodeId(): Promise<number | undefined> {
    try {
      const document = await this.send('DOM.getDocument', { depth: 0 })
      const root = document['root']
      if (typeof root !== 'object' || root === null) return undefined
      const rootNodeId = (root as Record<string, unknown>)['nodeId']
      return typeof rootNodeId === 'number' ? rootNodeId : undefined
    } catch {
      return undefined
    }
  }

  /**
   * FR-BR-5's "read page (accessibility tree)", and the thing that makes
   * role-and-name targeting usable by a caller that cannot see the page.
   *
   * Only INTERACTIVE elements, and only those with a name. A full
   * accessibility tree of a real page runs to thousands of nodes, most of
   * them structural, and putting that in front of a model costs a great
   * deal of context to say very little. What a task needs is the list of
   * things it could act on.
   */
  async readElements(): Promise<readonly PageElement[]> {
    let nodes: unknown
    try {
      const tree = await this.send('Accessibility.getFullAXTree')
      nodes = tree['nodes']
    } catch {
      return []
    }
    if (!Array.isArray(nodes)) return []

    const elements: PageElement[] = []
    for (const raw of nodes as Array<Record<string, unknown>>) {
      if (elements.length >= MAX_REPORTED_ELEMENTS) break
      const role = axValue(raw['role'])
      if (role === undefined || !INTERACTIVE_AX_ROLES.has(role)) continue
      // An element the accessibility tree marks as ignored is not visible
      // to a person either, so acting on it would be acting on something
      // nobody could have clicked.
      if (raw['ignored'] === true) continue
      const backendNodeId = raw['backendDOMNodeId']
      if (typeof backendNodeId !== 'number') continue
      // An interactive element with NO accessible name is still listed,
      // with an empty name. It cannot be targeted by name, but it can be
      // targeted by role where the role is unique on the page, and hiding
      // it would make an unlabelled control invisible to a caller that
      // cannot see the page. The empty name is also honest feedback: a
      // control with no accessible name is an accessibility defect in the
      // page, and a reader of this list can see that.
      elements.push({ role, name: (axValue(raw['name']) ?? '').trim(), backendNodeId })
    }
    return elements
  }

  /**
   * A one-line summary of what the page offered, for the reason string of a
   * failed resolution. FR-BR-7's "failures record the full accessibility
   * snapshot", bounded: the full snapshot of a real page would not fit in a
   * step result, and a caller that needs all of it can run `read_elements`.
   */
  private async describeAvailableElements(): Promise<string> {
    const elements = await this.readElements()
    if (elements.length === 0) return 'the page reports no named interactive elements at all'
    const shown = elements
      .slice(0, 20)
      .map((element) => (element.name.length > 0 ? `${element.role} "${element.name}"` : `${element.role} (unnamed)`))
    const suffix = elements.length > shown.length ? `, and ${elements.length - shown.length} more` : ''
    return `the page offers: ${shown.join(', ')}${suffix}`
  }

  /**
   * FR-BR-7's ladder, in its stated order: role and name, then a CSS
   * selector, then visible text.
   *
   * Every rung ends in a backend node id, which is what every interaction
   * below acts on, so a caller never has to know which rung answered.
   */
  private async resolveTarget(target: ElementTarget): Promise<ResolvedTarget> {
    if (target.role !== undefined || target.name !== undefined) {
      const byRole = await this.resolveByRoleAndName(target.role, target.name)
      if (byRole.ok || byRole.ambiguous) return byRole
    }
    if (target.selector !== undefined) {
      const bySelector = await this.resolveBySelector(target.selector)
      if (bySelector.ok) return bySelector
    }
    if (target.hasText !== undefined) {
      const byText = await this.resolveByText(target.hasText)
      if (byText.ok) return byText
    }
    return {
      ok: false,
      ambiguous: false,
      reason: `nothing on the page matched ${describeTarget(target)}. ${await this.describeAvailableElements()}`,
    }
  }

  private async resolveByRoleAndName(role: string | undefined, name: string | undefined): Promise<ResolvedTarget> {
    const elements = await this.readElements()
    const matches = elements.filter(
      (element) =>
        (role === undefined || element.role === role) &&
        (name === undefined || element.name.toLowerCase() === name.toLowerCase()),
    )
    const first = matches[0]
    if (matches.length === 1 && first !== undefined) return { ok: true, ambiguous: false, backendNodeId: first.backendNodeId }
    if (matches.length > 1) {
      // Refused, not resolved. See this section's own header comment: the
      // wrong "Delete" is precisely what picking the first would risk.
      return {
        ok: false,
        ambiguous: true,
        reason:
          `${matches.length} elements match ${describeTarget({ ...(role !== undefined ? { role } : {}), ...(name !== undefined ? { name } : {}) })}, ` +
          'so Relay refused rather than guessing which one was meant. Narrow it with a selector, or name it exactly.',
      }
    }
    return { ok: false, ambiguous: false, reason: 'no element matched by role and name' }
  }

  private async resolveBySelector(selector: string): Promise<ResolvedTarget> {
    const rootNodeId = await this.documentRootNodeId()
    if (rootNodeId === undefined) return { ok: false, ambiguous: false, reason: 'the document could not be read' }
    try {
      const found = await this.send('DOM.querySelector', { nodeId: rootNodeId, selector })
      const nodeId = found['nodeId']
      // CDP answers 0 for "matched nothing" rather than erroring.
      if (typeof nodeId !== 'number' || nodeId === 0) {
        return { ok: false, ambiguous: false, reason: `no element matched the selector "${selector}"` }
      }
      const described = await this.send('DOM.describeNode', { nodeId })
      const node = described['node']
      const backendNodeId =
        typeof node === 'object' && node !== null ? (node as Record<string, unknown>)['backendNodeId'] : undefined
      if (typeof backendNodeId !== 'number') {
        return { ok: false, ambiguous: false, reason: `the element matching "${selector}" could not be addressed` }
      }
      return { ok: true, ambiguous: false, backendNodeId }
    } catch (error) {
      // An invalid selector is a caller error worth naming, not a silent miss.
      return { ok: false, ambiguous: false, reason: `the selector "${selector}" could not be used: ${errorText(error)}` }
    }
  }

  private async resolveByText(text: string): Promise<ResolvedTarget> {
    const elements = await this.readElements()
    const needle = text.toLowerCase()
    const matches = elements.filter((element) => element.name.toLowerCase().includes(needle))
    const first = matches[0]
    if (matches.length === 1 && first !== undefined) return { ok: true, ambiguous: false, backendNodeId: first.backendNodeId }
    if (matches.length > 1) {
      return {
        ok: false,
        ambiguous: true,
        reason: `${matches.length} elements contain the text "${text}", so Relay refused rather than guessing which one was meant`,
      }
    }
    return { ok: false, ambiguous: false, reason: `no element contains the text "${text}"` }
  }

  /** Whether anything on the page matches `target` right now. FR-BR-5's "find element". */
  async exists(target: ElementTarget): Promise<boolean> {
    return (await this.resolveTarget(target)).ok
  }

  /**
   * The centre point of a resolved node's box, in viewport coordinates, or
   * `undefined` where the element has no box at all, which is what an
   * element with `display: none` or zero size reports.
   */
  private async centreOf(backendNodeId: number): Promise<{ readonly x: number; readonly y: number } | undefined> {
    try {
      await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
    } catch {
      // Not every node type supports it, and failing to scroll is not
      // failing to click: the box model below still answers.
    }
    try {
      const box = await this.send('DOM.getBoxModel', { backendNodeId })
      const model = box['model']
      if (typeof model !== 'object' || model === null) return undefined
      const content = (model as Record<string, unknown>)['content']
      if (!Array.isArray(content) || content.length < 8) return undefined
      const points = content as number[]
      // The quad is four (x, y) pairs; the centre is their mean. Summed
      // rather than indexed so that `noUncheckedIndexedAccess` does not
      // need eight separate non-null assertions to express "there are
      // eight numbers here", which the filter below has already checked.
      const xs = points.filter((_value, index) => index % 2 === 0).filter((value) => typeof value === 'number')
      const ys = points.filter((_value, index) => index % 2 === 1).filter((value) => typeof value === 'number')
      if (xs.length < 4 || ys.length < 4) return undefined
      const mean = (values: readonly number[]): number => values.slice(0, 4).reduce((total, value) => total + value, 0) / 4
      return { x: mean(xs), y: mean(ys) }
    } catch {
      return undefined
    }
  }

  /** FR-BR-5: click. Reports whether the element was found and clicked, rather than throwing, so a caller can escalate a miss to the next tier or to the operator. */
  async click(target: ElementTarget): Promise<{ readonly clicked: boolean; readonly reason?: string }> {
    const resolved = await this.resolveTarget(target)
    if (!resolved.ok) return { clicked: false, reason: resolved.reason }

    const centre = await this.centreOf(resolved.backendNodeId)
    if (centre === undefined) {
      return {
        clicked: false,
        reason: `${describeTarget(target)} resolved to an element with no visible box, so there was nothing to click`,
      }
    }
    try {
      const common = { x: centre.x, y: centre.y, button: 'left', clickCount: 1 }
      await this.send('Input.dispatchMouseEvent', { ...common, type: 'mousePressed' })
      await this.send('Input.dispatchMouseEvent', { ...common, type: 'mouseReleased' })
      return { clicked: true }
    } catch (error) {
      return { clicked: false, reason: `clicking ${describeTarget(target)} failed: ${errorText(error)}` }
    }
  }

  /**
   * FR-BR-5: type. Focuses the element, clears whatever is in it, and
   * inserts `text`.
   *
   * Clearing first because "type the company name into this field" means
   * the field ends up containing the company name, not the company name
   * appended to whatever a previous step left there. A caller who wants to
   * append passes `append: true` and says so.
   */
  async type(
    target: ElementTarget,
    text: string,
    options: { readonly append?: boolean } = {},
  ): Promise<{ readonly typed: boolean; readonly reason?: string }> {
    const resolved = await this.resolveTarget(target)
    if (!resolved.ok) return { typed: false, reason: resolved.reason }
    try {
      await this.send('DOM.focus', { backendNodeId: resolved.backendNodeId })
      if (options.append !== true) {
        // Selecting all then inserting replaces the selection, which is
        // what a person does, and fires the same input events an
        // application listens for. Setting `.value` from script would fire
        // none of them.
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] })
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
      }
      await this.send('Input.insertText', { text })
      return { typed: true }
    } catch (error) {
      return { typed: false, reason: `typing into ${describeTarget(target)} failed: ${errorText(error)}` }
    }
  }

  /**
   * FR-BR-5: select. Sets a `<select>` to `value` and fires the `change`
   * event applications listen for.
   *
   * This one primitive genuinely does run page script, because there is no
   * input-level way to drive a native select popup that works headlessly
   * and cross-platform. The event is dispatched explicitly, with
   * `bubbles: true`, so a framework listening on an ancestor still sees it.
   */
  async selectOption(target: ElementTarget, value: string): Promise<{ readonly selected: boolean; readonly reason?: string }> {
    const resolved = await this.resolveTarget(target)
    if (!resolved.ok) return { selected: false, reason: resolved.reason }

    // Called ON the resolved node rather than by re-querying a selector in
    // page script, so this primitive works for a target that was resolved
    // by role and name, and so it cannot act on a different element than
    // the one the ladder chose.
    let objectId: string
    try {
      const object = await this.send('DOM.resolveNode', { backendNodeId: resolved.backendNodeId })
      const remote = object['object']
      const id = typeof remote === 'object' && remote !== null ? (remote as Record<string, unknown>)['objectId'] : undefined
      if (typeof id !== 'string') {
        return { selected: false, reason: `${describeTarget(target)} could not be addressed in the page` }
      }
      objectId = id
    } catch (error) {
      return { selected: false, reason: `${describeTarget(target)} could not be addressed in the page: ${errorText(error)}` }
    }

    let outcome: string | undefined
    try {
      const called = await this.send('Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        functionDeclaration: `function (value) {
          const options = Array.from(this.options || [])
          if (options.length === 0) return 'not-a-select'
          if (!options.some((option) => option.value === value)) return 'no-such-option'
          this.value = value
          this.dispatchEvent(new Event('input', { bubbles: true }))
          this.dispatchEvent(new Event('change', { bubbles: true }))
          return 'ok'
        }`,
        arguments: [{ value }],
      })
      const remote = called['result']
      const returned = typeof remote === 'object' && remote !== null ? (remote as Record<string, unknown>)['value'] : undefined
      outcome = typeof returned === 'string' ? returned : undefined
    } catch (error) {
      return { selected: false, reason: `selecting "${value}" failed: ${errorText(error)}` }
    }

    if (outcome === 'ok') return { selected: true }
    if (outcome === 'not-a-select') {
      return { selected: false, reason: `${describeTarget(target)} is not a select element, so it has no options` }
    }
    if (outcome === 'no-such-option') {
      return { selected: false, reason: `${describeTarget(target)} has no option with value "${value}"` }
    }
    return { selected: false, reason: `selecting "${value}" in ${describeTarget(target)} did not complete` }
  }

  /** FR-BR-5: press key. `key` is a DOM key name ("Enter", "Tab", "Escape"). */
  async pressKey(key: string): Promise<{ readonly pressed: boolean; readonly reason?: string }> {
    const descriptor = KEY_DESCRIPTORS[key]
    if (descriptor === undefined) {
      return {
        pressed: false,
        reason: `"${key}" is not a key this driver knows how to dispatch; known keys: ${Object.keys(KEY_DESCRIPTORS).join(', ')}`,
      }
    }
    try {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...descriptor })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...descriptor })
      return { pressed: true }
    } catch (error) {
      return { pressed: false, reason: `pressing "${key}" failed: ${errorText(error)}` }
    }
  }

  /**
   * FR-BR-5: back, forward, reload.
   *
   * All three go through `Page.getNavigationHistory` rather than through
   * `history.back()` in page script, because page script cannot tell the
   * difference between "there is nowhere to go back to" and "the back
   * happened": both leave the page where it is. The history API knows, so
   * "there is no previous page" is reported as an outcome instead of
   * looking like a silent no-op.
   */
  async goBack(): Promise<NavigateResult> {
    return this.moveInHistory(-1, 'back')
  }

  async goForward(): Promise<NavigateResult> {
    return this.moveInHistory(1, 'forward')
  }

  private async moveInHistory(offset: number, direction: string): Promise<NavigateResult> {
    let history: Record<string, unknown>
    try {
      history = await this.send('Page.getNavigationHistory')
    } catch (error) {
      return { outcome: 'failed', url: '', reason: `the navigation history could not be read: ${errorText(error)}` }
    }
    const entries = history['entries']
    const currentIndex = history['currentIndex']
    if (!Array.isArray(entries) || typeof currentIndex !== 'number') {
      return { outcome: 'failed', url: '', reason: 'the browser returned no usable navigation history' }
    }

    const target = entries[currentIndex + offset] as Record<string, unknown> | undefined
    const entryId = target?.['id']
    if (typeof entryId !== 'number') {
      return { outcome: 'failed', url: '', reason: `there is no ${direction} entry in this page's history` }
    }

    // The destination is checked like any other navigation: a back button
    // is still a navigation, and the allowlist could have changed since the
    // page was first visited.
    const url = typeof target?.['url'] === 'string' ? (target['url'] as string) : ''
    if (isNavigableUrl(url)) {
      const verdict = this.guard(url)
      if (!verdict.allowed) return { outcome: 'refused', url, reason: verdict.reason }
    }

    try {
      await this.send('Page.navigateToHistoryEntry', { entryId })
    } catch (error) {
      return { outcome: 'failed', url, reason: `going ${direction} failed: ${errorText(error)}` }
    }

    // Waits for the URL to become the history entry's, NOT for a load
    // event. Chrome restores a back-forward navigation from its own
    // back-forward cache without firing `Page.loadEventFired` at all, so
    // waiting for one meant waiting out the entire navigation timeout on a
    // navigation that had already completed. The URL is the thing actually
    // being asserted anyway.
    const arrived = await this.waitFor(`window.location.href === ${JSON.stringify(url)}`, {
      timeoutMs: Math.min(this.navigationTimeoutMs, HISTORY_NAVIGATION_TIMEOUT_MS),
    })
    const finalUrl = await this.currentUrl()
    if (arrived.outcome !== 'satisfied') {
      return {
        outcome: 'failed',
        url: finalUrl,
        reason: `going ${direction} did not reach ${url} within ${HISTORY_NAVIGATION_TIMEOUT_MS}ms; the page is at ${finalUrl}`,
      }
    }
    return { outcome: 'loaded', url: finalUrl, status: this.documentStatuses.get(finalUrl) }
  }

  /** FR-BR-5: reload. */
  async reload(): Promise<NavigateResult> {
    const loaded = this.oncePageEvent('Page.loadEventFired')
    try {
      await this.send('Page.reload')
    } catch (error) {
      loaded.cancel()
      return { outcome: 'failed', url: '', reason: `the page could not be reloaded: ${errorText(error)}` }
    }
    const settled = await loaded.wait(this.navigationTimeoutMs)
    const finalUrl = await this.currentUrl()
    return settled
      ? { outcome: 'loaded', url: finalUrl, status: this.documentStatuses.get(finalUrl) }
      : { outcome: 'failed', url: finalUrl, reason: `the reload did not finish within ${this.navigationTimeoutMs}ms` }
  }

  /**
   * FR-BR-5: hover.
   *
   * A real mouse move to the element's own coordinates, for the same reason
   * clicking is: a hover is what reveals a dropdown menu on a great many
   * sites, and a synthetic `mouseover` event dispatched from page script
   * does not trigger CSS `:hover` at all.
   */
  async hover(target: ElementTarget): Promise<{ readonly hovered: boolean; readonly reason?: string }> {
    const resolved = await this.resolveTarget(target)
    if (!resolved.ok) return { hovered: false, reason: resolved.reason }
    const centre = await this.centreOf(resolved.backendNodeId)
    if (centre === undefined) {
      return { hovered: false, reason: `${describeTarget(target)} resolved to an element with no visible box` }
    }
    try {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y })
      return { hovered: true }
    } catch (error) {
      return { hovered: false, reason: `hovering ${describeTarget(target)} failed: ${errorText(error)}` }
    }
  }

  /**
   * FR-BR-5: PDF export.
   *
   * Bounded by the same rule as a screenshot, and refused rather than
   * truncated for the same reason: half a base64 PDF is not a smaller
   * document, it is a corrupt one.
   */
  async exportPdf(): Promise<ScreenshotResult> {
    let result: Record<string, unknown>
    try {
      result = await this.send('Page.printToPDF', { printBackground: true })
    } catch (error) {
      return { ok: false, reason: `the page could not be exported as a PDF: ${errorText(error)}` }
    }
    const data = result['data']
    if (typeof data !== 'string' || data.length === 0) {
      return { ok: false, reason: 'the browser returned no PDF data' }
    }
    if (data.length > MAX_SCREENSHOT_BASE64_CHARACTERS) {
      return {
        ok: false,
        reason:
          `the PDF is ${data.length} base64 characters, over this driver's ${MAX_SCREENSHOT_BASE64_CHARACTERS} ` +
          'character bound, so it was dropped rather than truncated into a corrupt document',
      }
    }
    return { ok: true, data }
  }

  /**
   * FR-SEC-6: covers credential fields, and reports a view it cannot vouch
   * for.
   *
   * A failure to run the script at all is treated as UNMASKABLE rather than
   * as "nothing to mask". The distinction matters: an evaluate that throws
   * tells us nothing about what is on the page, and reading "no result" as
   * "no credentials" is precisely the fail-open behaviour this requirement
   * exists to prevent.
   */
  async redactCredentialFields(): Promise<ScreenshotRedaction> {
    const report = await this.evaluate<RedactionReport>(buildRedactionScript())
    if (report === undefined || typeof report.masked !== 'number') {
      return {
        outcome: 'unmaskable',
        report: { masked: 0, unmaskableFrames: 0 },
        reason:
          'the credential-masking step could not run on this page, so Relay cannot confirm no credential field is ' +
          'visible, and the screenshot was NOT persisted (FR-SEC-6).',
      }
    }
    return decideRedaction(report)
  }

  /** FR-BR-5: scroll. Positive `y` scrolls down. */
  async scrollBy(x: number, y: number): Promise<void> {
    await this.evaluate<null>(`(() => { window.scrollBy(${x}, ${y}); return null })()`)
  }

  /**
   * FR-BR-5: screenshot, base64 PNG. Returned rather than written to disk:
   * where an artifact is stored is the artifact layer's decision, not the
   * driver's.
   *
   * FR-SEC-6 happens HERE rather than in the artifact layer, and that is the
   * whole point: credential fields are covered in the DOM before the capture,
   * so the bytes never contain the value. Masking afterwards would leave a
   * window in which a readable password exists in memory as an image, and
   * would fail open if the masking step were ever skipped.
   */
  async screenshot(): Promise<ScreenshotResult> {
    // Applied before capture, removed after, so the page is left as found.
    const redaction = await this.redactCredentialFields()
    if (redaction.outcome === 'unmaskable') {
      await this.evaluate<boolean>(buildRedactionCleanupScript())
      return { ok: false, reason: redaction.reason }
    }

    let result: Record<string, unknown>
    try {
      result = await this.send('Page.captureScreenshot', { format: 'png' })
    } catch (error) {
      return { ok: false, reason: `the screenshot could not be captured: ${errorText(error)}` }
    } finally {
      await this.evaluate<boolean>(buildRedactionCleanupScript()).catch(() => undefined)
    }
    const data = result['data']
    if (typeof data !== 'string' || data.length === 0) {
      return { ok: false, reason: 'the browser returned no screenshot data' }
    }
    if (data.length > MAX_SCREENSHOT_BASE64_CHARACTERS) {
      return {
        ok: false,
        reason:
          `the screenshot is ${data.length} base64 characters, over this driver's ` +
          `${MAX_SCREENSHOT_BASE64_CHARACTERS} character bound, so it was dropped rather than truncated into a ` +
          'corrupt image',
      }
    }
    return { ok: true, data }
  }

  /**
   * Closes this page's target and detaches every handler.
   *
   * Idempotent, and never throws: closing a page whose browser has already
   * gone is the ordinary teardown order, not an error.
   */
  async close(): Promise<void> {
    if (this.closedState) return
    this.closedState = true
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes.length = 0
    try {
      await this.connection.send('Target.closeTarget', { targetId: this.targetId }, undefined, 5_000)
    } catch {
      // See this method's doc comment.
    }
  }

  /**
   * A one-shot wait for a page event, armed BEFORE the action that causes
   * it. Arming after would race: a fast load can fire before a listener
   * registered afterwards exists, and the wait would then time out on an
   * event that already happened.
   *
   * Resolves `false` on timeout rather than rejecting, because a
   * navigation that did not finish loading is an outcome `navigate()`
   * reports, not an exception it has to translate.
   */
  private oncePageEvent(method: string): { wait: (timeoutMs: number) => Promise<boolean>; cancel: () => void } {
    let fired = false
    let onFired: (() => void) | undefined
    const unsubscribe = this.connection.on(method, (_params, sessionId) => {
      if (sessionId !== this.sessionId) return
      fired = true
      onFired?.()
    })

    return {
      cancel: unsubscribe,
      wait: (timeoutMs: number): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          if (fired) {
            unsubscribe()
            resolve(true)
            return
          }
          const timer = setTimeout(() => {
            unsubscribe()
            resolve(false)
          }, timeoutMs)
          onFired = () => {
            clearTimeout(timer)
            unsubscribe()
            resolve(true)
          }
        }),
    }
  }
}
