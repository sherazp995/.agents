/**
 * The `browser` capability: resolve a profile, establish a tier, enforce
 * the origin scope, and then, as of this milestone, actually drive the
 * page.
 *
 * WHAT CHANGED, AND WHY THE SHAPE IS A STEP LIST. Until now this capability
 * ended at a governed decision: it answered "may this profile navigate
 * there, and how firmly is that answer enforced," and no code in the
 * repository could open a page. `src/browser/tier2/` now can, so this file
 * composes the two halves.
 *
 * The call takes a LIST OF STEPS executed in one browser lifetime, rather
 * than a single action per call, and that is a deliberate design decision
 * with a real cost, stated here so nobody has to rediscover it:
 *
 *   - Why a list. A capability call is the unit the policy engine governs,
 *     the unit an approval covers, and the unit a budget counts. A browser
 *     that lived across calls would make each of those cover a fragment of
 *     a session while the session itself, the logged-in browser, the open
 *     page, went ungoverned in between. One call, one browser, one
 *     lifetime, means the thing being approved is the thing that happens.
 *   - What it costs. The browser is killed when the call returns, so
 *     non-persistent session cookies do not survive to the next call. A
 *     task that logs in and a later task that expects to still be logged in
 *     will not be, unless the site issued a persistent cookie, which does
 *     survive in the profile's own user-data directory. A cross-call
 *     session registry is the fix, and it is not in this milestone; a task
 *     that needs login-then-act must put both in one call's steps.
 *
 * WHAT THIS FILE STILL DOES NOT DO. There is no tier 1 driver and no tier 3
 * driver. A call that lands on either returns its governed decision and
 * says plainly that no provider executed the steps. It does not silently
 * return an "allowed" that a reader could mistake for "done".
 *
 * TYPED TEXT IS NEVER ECHOED BACK. A `type` step's text is very often a
 * credential. The step result names the selector and reports success; it
 * does not repeat what was typed, because this result is rendered into a
 * run report and a Slack thread, and the scrubber only redacts values Relay
 * itself brokered (it cannot catch a password the operator pasted into a
 * task).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfigPath, defaultPolicyPath, defaultProfilesPath } from '../../config/paths.js'

import { z } from 'zod'

import type { Capability } from '../loop.js'
import type { CapabilityDefinition } from '../../capabilities/registry.js'
import { loadPolicy, loadProfileRegistryIfPresent } from '../../config/load.js'
import type { Policy } from '../../config/schema.js'
import type { ProfileEntry, ProfileRegistry } from '../../profiles/schema.js'
import { resolveProfile } from '../../profiles/resolve.js'
import { establishProfileConnection } from '../../browser/launch.js'
import type {
  Clock,
  ExtensionConnectionProbe,
  LaunchLadderOutcome,
  ProfileConnectionResult,
  SpawnChromeFn,
} from '../../browser/launch.js'
import { ENFORCEMENT_MODES, enforceNavigation } from '../../browser/enforcement.js'
import type { BrowserTier } from '../../profiles/schema.js'
import { normalizeDestination } from '../../policy/engine.js'
import { destinationHost } from '../../browser/url.js'
import { openTier2Browser } from '../../browser/tier2/browser.js'
import type { DrivableBrowserOutcome, Tier2BrowserDependencies } from '../../browser/tier2/browser.js'
import type { DownloadTracker } from '../../browser/tier2/downloads.js'
import type { DrivablePage, ElementTarget, NavigationGuard } from '../../browser/tier2/page.js'
import { describeTarget } from '../../browser/tier2/page.js'
import { HUMAN_BLOCK_CONFIDENCE, HUMAN_BLOCK_KINDS, describeHumanBlock, detectHumanBlock } from '../../browser/tier2/blocked.js'

export const BROWSER_CAPABILITY_NAME = 'browser'

/** Matches the CLI's own defaults and src/doctor/checks/profiles.ts's DEFAULT_PROFILES_PATH; both files agree so a profile that resolves in `relay doctor` resolves the same way here. */
const DEFAULT_PROFILES_PATH = defaultProfilesPath()
const DEFAULT_POLICY_PATH = defaultPolicyPath()

/**
 * How many steps one call may carry. A bound, not a judgement about what a
 * task needs: an unbounded list is an unbounded browser lifetime holding a
 * profile lock, and a runaway plan should fail at submission rather than
 * halfway through a hundred clicks.
 */
export const MAX_BROWSER_STEPS = 40

// ---------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------

/**
 * How a step names the element it acts on, per FR-BR-7.
 *
 * `role` and `name` come first in the list because they are what a caller
 * should reach for first: they survive a restyle, and, unlike a CSS
 * selector, a model can learn them from a `read_elements` step instead of
 * guessing them. `selector` and `text` remain, as the ladder's lower rungs.
 *
 * At least one is required. A step naming no element at all would resolve
 * to whatever the resolver happened to find, which is the one behaviour
 * FR-BR-7's ladder exists to rule out.
 */
const targetFields = {
  role: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1).optional(),
  has_text: z.string().trim().min(1).optional(),
}

/**
 * The actions that act on an element and therefore must name one.
 *
 * Checked on the whole input rather than per option, because zod 3's
 * `discriminatedUnion` accepts only plain object schemas: a `superRefine`
 * on an option wraps it in `ZodEffects` and the union stops being
 * discriminable. Same rule, enforced one level up.
 */
const ACTIONS_REQUIRING_A_TARGET: ReadonlySet<string> = new Set(['click', 'type', 'select', 'exists', 'hover'])

const stepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal('click'), ...targetFields }).strict(),
  z
    .object({
      action: z.literal('type'),
      ...targetFields,
      text: z.string(),
      append: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal('select'), ...targetFields, value: z.string() }).strict(),
  z.object({ action: z.literal('press'), key: z.string().trim().min(1) }).strict(),
  z
    .object({
      action: z.literal('wait_for'),
      expression: z.string().trim().min(1),
      timeoutMs: z.number().int().positive().max(120_000).optional(),
    })
    .strict(),
  z.object({ action: z.literal('exists'), ...targetFields }).strict(),
  z
    .object({
      action: z.literal('wait_for_download'),
      timeoutMs: z.number().int().positive().max(300_000).optional(),
    })
    .strict(),
  z.object({ action: z.literal('read_text') }).strict(),
  z.object({ action: z.literal('read_html') }).strict(),
  z.object({ action: z.literal('read_elements') }).strict(),
  z.object({ action: z.literal('screenshot') }).strict(),
  z.object({ action: z.literal('export_pdf') }).strict(),
  z.object({ action: z.literal('back') }).strict(),
  z.object({ action: z.literal('forward') }).strict(),
  z.object({ action: z.literal('reload') }).strict(),
  z.object({ action: z.literal('hover'), ...targetFields }).strict(),
  z.object({ action: z.literal('scroll'), x: z.number().optional(), y: z.number() }).strict(),
])

/** Pulls the four target fields out of a step, dropping the absent ones so `exactOptionalPropertyTypes` stays satisfied. */
function targetOf(step: {
  role?: string | undefined
  name?: string | undefined
  selector?: string | undefined
  has_text?: string | undefined
}): ElementTarget {
  return {
    ...(step.role !== undefined ? { role: step.role } : {}),
    ...(step.name !== undefined ? { name: step.name } : {}),
    ...(step.selector !== undefined ? { selector: step.selector } : {}),
    ...(step.has_text !== undefined ? { hasText: step.has_text } : {}),
  }
}

export type BrowserStep = z.infer<typeof stepSchema>

/**
 * Every action a step may name, DERIVED from the schema rather than
 * hand-listed beside it.
 *
 * A hand-kept copy would be a second list to remember to update, which is
 * exactly the drift FR-CAP-1 exists to rule out. This one cannot fall
 * behind: adding an option to `stepSchema` adds it here, and the test that
 * checks this capability's description mentions every action then fails
 * until the description is updated too.
 */
export const BROWSER_STEP_ACTIONS: readonly string[] = stepSchema.options.map(
  (option) => option.shape.action.value,
)

export const browserCapabilityInputSchema = z
  .object({
    /**
     * The destination this call is bound to: a bare hostname or a full URL.
     * It is what the policy engine governs (via `destinationOf` below), what
     * FR-PRF-3 resolves a profile from, and what the profile's allowlist is
     * checked against. Every step's own URL is checked separately, so this
     * field cannot be used to smuggle a different destination past the seam.
     */
    destination: z.string().trim().min(1, 'a browser call must name a destination to navigate to'),
    steps: z.array(stepSchema).max(MAX_BROWSER_STEPS).default([]),
    explicitProfile: z.string().trim().min(1).optional(),
    project: z.string().trim().min(1).optional(),
    channelId: z.string().trim().min(1).optional(),
    channelBindings: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    // See ACTIONS_REQUIRING_A_TARGET. A step that acts on an element and
    // names none would resolve to whatever the resolver happened to find,
    // which is the one behaviour FR-BR-7's ladder exists to rule out.
    for (const [index, step] of input.steps.entries()) {
      if (!ACTIONS_REQUIRING_A_TARGET.has(step.action)) continue
      const targeted = step as { role?: string; name?: string; selector?: string; has_text?: string }
      if (
        targeted.role === undefined &&
        targeted.name === undefined &&
        targeted.selector === undefined &&
        targeted.has_text === undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index],
          message:
            `a "${step.action}" step must name the element it acts on: give role and/or name (preferred, and ` +
            'discoverable with a read_elements step), or a CSS selector, or its visible text',
        })
      }
    }
  })

export type BrowserCapabilityInput = z.infer<typeof browserCapabilityInputSchema>

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------

const browserTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)])
const enforcementModeSchema = z.enum(ENFORCEMENT_MODES)

const stepResultSchema = z
  .object({
    action: z.string(),
    ok: z.boolean(),
    /** What the step is addressed at: a selector, a url, a key. Never the text a `type` step typed; see this file's header comment. */
    target: z.string().optional(),
    detail: z.string().optional(),
    /** Present only for the steps that read something: page text, html, a screenshot's base64, or an existence answer. */
    value: z.string().optional(),
  })
  .strict()

const blockedRequestSchema = z
  .object({ url: z.string(), host: z.string(), resourceType: z.string(), reason: z.string() })
  .strict()
const dialogSchema = z.object({ type: z.string(), message: z.string(), accepted: z.boolean() }).strict()
const consoleSchema = z.object({ level: z.string(), text: z.string() }).strict()

export const browserCapabilityOutputSchema = z.discriminatedUnion('outcome', [
  /** FR-PRF-2: no profile could be bound to this call at all. Refused, never defaulted. */
  z.object({ outcome: z.literal('refused_no_profile'), reason: z.string() }).strict(),
  /** FR-PRF-3: more than one profile matched. Asks, by naming the candidates, rather than picking one. */
  z.object({ outcome: z.literal('ambiguous_profile'), reason: z.string(), candidates: z.array(z.string()) }).strict(),
  /** FR-PRF-7: the tier ladder could not land on any usable tier for the resolved profile. */
  z
    .object({
      outcome: z.literal('connection_escalated'),
      profile: z.string(),
      connection: z.unknown(),
      reason: z.string(),
    })
    .strict(),
  /**
   * FR-PRF-4: the destination was refused. `enforcement` is the field that
   * must never be flattened away: `prevented` at tiers 2 and 3 means the
   * navigation cannot happen; `refused_at_request` at tier 1 means only
   * that Relay declined to issue it.
   */
  z
    .object({
      outcome: z.literal('navigation_refused'),
      profile: z.string(),
      connection: z.unknown(),
      tier: browserTierSchema,
      enforcement: enforcementModeSchema,
      reason: z.string(),
    })
    .strict(),
  /**
   * The destination is permitted and a tier was established, but no driver
   * exists for that tier, so NOTHING WAS DONE. A separate outcome from
   * `completed` on purpose: reporting an allowed navigation as if the steps
   * had run is the exact false-success this project has shipped before.
   */
  z
    .object({
      outcome: z.literal('no_provider'),
      profile: z.string(),
      connection: z.unknown(),
      tier: browserTierSchema,
      destination: z.string(),
      reason: z.string(),
    })
    .strict(),
  /** The browser could not be started, or died. The steps did not run, or ran only in part; `steps` carries whatever completed first. */
  z
    .object({
      outcome: z.literal('driver_failed'),
      profile: z.string(),
      tier: browserTierSchema,
      reason: z.string(),
      steps: z.array(stepResultSchema),
    })
    .strict(),
  /** FR-ORC cancellation: the run was cancelled mid-call. Reports what had already happened rather than discarding it. */
  z
    .object({
      outcome: z.literal('cancelled'),
      profile: z.string(),
      tier: browserTierSchema,
      reason: z.string(),
      steps: z.array(stepResultSchema),
    })
    .strict(),
  /**
   * Every step ran. `ok` on each step says whether it succeeded; a step
   * that failed stops the sequence, so `steps` is a prefix of what was
   * asked for and its last entry is the one that failed.
   */
  z
    .object({
      outcome: z.literal('completed'),
      profile: z.string(),
      connection: z.unknown(),
      tier: browserTierSchema,
      destination: z.string(),
      finalUrl: z.string().optional(),
      allStepsSucceeded: z.boolean(),
      steps: z.array(stepResultSchema),
      /** FR-PRF-4's evidence: what the profile's scope actually kept out during this call. Empty is the normal case and is still reported, so "nothing was blocked" is a stated fact rather than an absence. */
      blockedRequests: z.array(blockedRequestSchema),
      /** FR-BR-6: dialogs the page raised and the driver answered. */
      dialogs: z.array(dialogSchema),
      consoleMessages: z.array(consoleSchema),
      /**
       * What the driver stopped capturing. Present on every completed
       * call, with zeroes in the normal case, so "nothing was dropped" is
       * a stated fact rather than an absence a reader has to infer.
       */
      captureLimits: z
        .object({ consoleDropped: z.number(), networkDropped: z.number(), textTruncated: z.boolean() })
        .strict(),
      /**
       * FR-BR-8 and FR-BR-10. Present only when the page appears to need a
       * person: a CAPTCHA, a bot wall, a 2FA prompt, a rate limit, or a
       * signed-out session. Absent is the normal case.
       *
       * `allStepsSucceeded` can be true alongside this, and that
       * combination is the reason this field exists at all: every step
       * "worked", in the sense that the driver did what it was told, while
       * the page it read was a bot wall rather than the content. A report
       * built from step outcomes alone would call that a success.
       */
      humanActionNeeded: z
        .object({
          kind: z.enum(HUMAN_BLOCK_KINDS),
          confidence: z.enum(HUMAN_BLOCK_CONFIDENCE),
          evidence: z.string(),
          action: z.string(),
          /** FR-PRF-8's own wording requirement: the request names the PROFILE that needs attention, not merely the site. */
          message: z.string(),
        })
        .strict()
        .optional(),
    })
    .strict(),
])

export type BrowserCapabilityResult = z.infer<typeof browserCapabilityOutputSchema>
export type BrowserStepResult = z.infer<typeof stepResultSchema>

// ---------------------------------------------------------------------------
// Dependencies.
// ---------------------------------------------------------------------------

export type BrowserCapabilityDependencies = {
  readonly profilesPath?: string
  readonly policyPath?: string
  readonly loadProfileRegistry?: (path: string) => ProfileRegistry
  readonly loadPolicyFile?: (path: string) => Policy
  readonly probeExtension?: ExtensionConnectionProbe
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
  readonly clock?: Clock
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly spawnChrome?: SpawnChromeFn
  readonly sleep?: (ms: number) => Promise<void>
  readonly executablePath?: string
  readonly readinessGraceMs?: number
  /** Seam for the tier 2 driver itself, so a test can drive this capability's own composition without a real Chrome. Production uses `openTier2Browser`. */
  readonly openBrowser?: (profile: ProfileEntry) => Promise<DrivableBrowserOutcome>
  readonly tier2?: Tier2BrowserDependencies
}

/** See this file's header comment on why "not connected" is the safe production default: FR-PRF-6's live discovery is not wired by anything yet. */
const UNVERIFIED_EXTENSION_PROBE: ExtensionConnectionProbe = () => Promise.resolve(false)

function tierFromLadder(ladder: LaunchLadderOutcome): BrowserTier | undefined {
  switch (ladder.outcome) {
    case 'tier1_connected':
      return 1
    case 'pinned':
      return ladder.tier
    case 'fell_back_to_tier2':
      return 2
    case 'escalate_to_operator':
      return undefined
  }
}

/**
 * The guard the tier 2 driver applies to EVERY request the page makes,
 * built from the same `enforceNavigation` the up-front check uses.
 *
 * Built once per call and closed over the profile and the hard-blocked
 * list, so a page cannot be handed a guard that drifts from the decision
 * this call was governed under.
 */
export function buildNavigationGuard(profile: ProfileEntry, hardBlockedOrigins: readonly string[], tier: BrowserTier): NavigationGuard {
  return (url: string) => {
    const host = normalizeDestination(destinationHost(url))
    const decision = enforceNavigation({ profile, tier, destination: host, hardBlockedOrigins })
    if (decision.outcome === 'allowed') return { allowed: true }
    return { allowed: false, reason: decision.reason }
  }
}

async function runSteps(
  page: DrivablePage,
  downloads: DownloadTracker,
  steps: readonly BrowserStep[],
  signal: AbortSignal,
): Promise<{ readonly results: BrowserStepResult[]; readonly cancelled: boolean }> {
  const results: BrowserStepResult[] = []

  for (const step of steps) {
    if (signal.aborted) return { results, cancelled: true }

    switch (step.action) {
      case 'navigate': {
        const result = await page.navigate(step.url)
        results.push({
          action: 'navigate',
          // A download IS a success: the URL was a file, not a page, and
          // the bytes are arriving. A `wait_for_download` step is what
          // collects it.
          ok: result.outcome === 'loaded' || result.outcome === 'download_started',
          target: step.url,
          detail:
            result.outcome === 'loaded'
              ? `loaded ${result.url}${result.status !== undefined ? ` (HTTP ${result.status})` : ''}`
              : result.outcome === 'download_started'
                ? 'this URL is a download rather than a page; add a wait_for_download step to collect it'
                : result.reason,
        })
        break
      }
      case 'click': {
        const target = targetOf(step)
        const result = await page.click(target)
        results.push({
          action: 'click',
          ok: result.clicked,
          target: describeTarget(target),
          ...(result.reason !== undefined ? { detail: result.reason } : {}),
        })
        break
      }
      case 'type': {
        const target = targetOf(step)
        const result = await page.type(target, step.text, {
          ...(step.append !== undefined ? { append: step.append } : {}),
        })
        results.push({
          action: 'type',
          ok: result.typed,
          target: describeTarget(target),
          // Deliberately not the text. See this file's header comment.
          detail: result.reason ?? `typed ${step.text.length} characters`,
        })
        break
      }
      case 'select': {
        const target = targetOf(step)
        const result = await page.selectOption(target, step.value)
        results.push({
          action: 'select',
          ok: result.selected,
          target: describeTarget(target),
          detail: result.reason ?? `selected "${step.value}"`,
        })
        break
      }
      case 'press': {
        const result = await page.pressKey(step.key)
        results.push({
          action: 'press',
          ok: result.pressed,
          target: step.key,
          ...(result.reason !== undefined ? { detail: result.reason } : {}),
        })
        break
      }
      case 'wait_for': {
        const result = await page.waitFor(step.expression, {
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
        })
        results.push({
          action: 'wait_for',
          ok: result.outcome === 'satisfied',
          target: step.expression,
          detail: result.outcome === 'satisfied' ? `satisfied after ${result.waitedMs}ms` : result.reason,
        })
        break
      }
      case 'exists': {
        const target = targetOf(step)
        const found = await page.exists(target)
        results.push({ action: 'exists', ok: true, target: describeTarget(target), value: String(found) })
        break
      }
      case 'wait_for_download': {
        const waited = await downloads.waitForDownload({
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
        })
        results.push(
          waited.outcome === 'downloaded'
            ? {
                action: 'wait_for_download',
                ok: true,
                target: waited.download.suggestedFilename,
                detail: `downloaded ${waited.download.receivedBytes} bytes to ${waited.download.path}`,
                value: waited.download.path,
              }
            : { action: 'wait_for_download', ok: false, detail: waited.reason },
        )
        break
      }
      case 'read_text': {
        const text = await page.readText()
        results.push({ action: 'read_text', ok: true, value: text })
        break
      }
      case 'read_html': {
        const html = await page.readHtml()
        results.push({ action: 'read_html', ok: true, value: html })
        break
      }
      case 'read_elements': {
        // FR-BR-7's discoverability half: the caller cannot see the page,
        // so this is how it learns which roles and names exist to target.
        const elements = await page.readElements()
        results.push({
          action: 'read_elements',
          ok: true,
          value: JSON.stringify(elements.map((element) => ({ role: element.role, name: element.name }))),
        })
        break
      }
      case 'screenshot': {
        const shot = await page.screenshot()
        results.push({
          action: 'screenshot',
          ok: shot.ok,
          ...(shot.ok ? { value: shot.data } : { detail: shot.reason }),
        })
        break
      }
      case 'export_pdf': {
        const pdf = await page.exportPdf()
        results.push({
          action: 'export_pdf',
          ok: pdf.ok,
          ...(pdf.ok ? { value: pdf.data } : { detail: pdf.reason }),
        })
        break
      }
      case 'back':
      case 'forward':
      case 'reload': {
        const moved =
          step.action === 'back' ? await page.goBack() : step.action === 'forward' ? await page.goForward() : await page.reload()
        results.push({
          action: step.action,
          ok: moved.outcome === 'loaded',
          detail:
            moved.outcome === 'loaded'
              ? `now at ${moved.url}`
              : moved.outcome === 'download_started'
                ? 'this history entry is a download rather than a page'
                : moved.reason,
        })
        break
      }
      case 'hover': {
        const target = targetOf(step)
        const result = await page.hover(target)
        results.push({
          action: 'hover',
          ok: result.hovered,
          target: describeTarget(target),
          ...(result.reason !== undefined ? { detail: result.reason } : {}),
        })
        break
      }
      case 'scroll': {
        await page.scrollBy(step.x ?? 0, step.y)
        results.push({ action: 'scroll', ok: true, target: `${step.x ?? 0},${step.y}` })
        break
      }
    }

    // A failed step stops the sequence. Continuing past one means every
    // later step acts on a page in a state nobody predicted, and the run
    // reports a pile of failures whose first cause is buried.
    const last = results[results.length - 1]
    if (last !== undefined && !last.ok) break
  }

  return { results, cancelled: false }
}

/**
 * Builds the browser capability's `run` function against the given
 * dependencies. Exported so a test registers a real capability definition,
 * built against fakes, and drives it exactly the way `src/agent/loop.ts`
 * would.
 */
export function createBrowserCapability(deps: BrowserCapabilityDependencies = {}): Capability {
  return async function browserCapability(rawInput: unknown, signal: AbortSignal): Promise<BrowserCapabilityResult> {
    const input = browserCapabilityInputSchema.parse(rawInput)
    const destination = normalizeDestination(destinationHost(input.destination))

    const loadProfileRegistry = deps.loadProfileRegistry ?? loadProfileRegistryIfPresent
    const loadPolicyFile = deps.loadPolicyFile ?? loadPolicy
    const registry = loadProfileRegistry(deps.profilesPath ?? DEFAULT_PROFILES_PATH)

    // Step 1: resolve the profile, or refuse. Per FR-PRF-2, this is the
    // very first thing that happens; nothing below it runs without a
    // resolved profile in hand.
    const resolution = resolveProfile(registry, {
      ...(input.explicitProfile !== undefined ? { explicitProfile: input.explicitProfile } : {}),
      ...(input.project !== undefined ? { project: input.project } : {}),
      destination,
      ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
      ...(input.channelBindings !== undefined ? { channelBindings: input.channelBindings } : {}),
    })

    if (resolution.outcome === 'unresolved') {
      return { outcome: 'refused_no_profile', reason: resolution.reason }
    }
    if (resolution.outcome === 'ambiguous') {
      return {
        outcome: 'ambiguous_profile',
        reason: resolution.reason,
        candidates: resolution.candidates.map((candidate) => candidate.name),
      }
    }

    const profile = resolution.profile

    // Step 2: establish a connection through the tier fallback ladder.
    const connection: ProfileConnectionResult = await establishProfileConnection(profile, {
      ...deps,
      probeExtension: deps.probeExtension ?? UNVERIFIED_EXTENSION_PROBE,
    })

    const tier = tierFromLadder(connection.ladder)
    if (tier === undefined) {
      return {
        outcome: 'connection_escalated',
        profile: profile.name,
        connection,
        reason:
          connection.ladder.outcome === 'escalate_to_operator'
            ? connection.ladder.reason
            : 'no browser tier could be resolved for this profile',
      }
    }

    // Step 3: enforce the origin allowlist for the tier actually reached,
    // before any navigation is permitted.
    const policy = loadPolicyFile(deps.policyPath ?? DEFAULT_POLICY_PATH)
    const decision = enforceNavigation({
      profile,
      tier,
      destination,
      hardBlockedOrigins: policy.hard_blocked_origins,
    })

    if (decision.outcome === 'no_profile') {
      // Unreachable in practice: an unresolved profile already returned
      // above. Handled the same way regardless, so a change to that
      // invariant elsewhere fails the same safe way.
      return { outcome: 'refused_no_profile', reason: decision.reason }
    }

    if (decision.outcome === 'refused') {
      return {
        outcome: 'navigation_refused',
        profile: profile.name,
        connection,
        tier,
        enforcement: decision.enforcement,
        reason: decision.reason,
      }
    }

    // Step 4: drive, where a driver exists for the tier the ladder landed
    // on. Tiers 1 and 3 have none, and say so rather than returning an
    // "allowed" a reader could mistake for "done".
    if (tier !== 2) {
      return {
        outcome: 'no_provider',
        profile: profile.name,
        connection,
        tier,
        destination,
        reason:
          tier === 1
            ? 'the navigation is permitted, but Relay has no tier 1 driver: the Claude-in-Chrome extension owns ' +
              'navigation and nothing in this build issues instructions to it, so no step was executed (FR-BR-1).'
            : 'the navigation is permitted, but Relay has no tier 3 vision driver in this build, so no step was ' +
              'executed (FR-BR-3).',
      }
    }

    /**
     * A download directory this CALL owns, created only when the plan
     * actually contains a download step.
     *
     * The ownership matters, and getting it wrong shipped a lie in an
     * earlier version of this file: the download tracker deletes the
     * directory it created when the browser closes, and the browser closes
     * when this call returns, so a `wait_for_download` step reported
     * `ok: true` alongside the path of a file that no longer existed by the
     * time anyone read the result. Supplying the directory here transfers
     * that ownership: the tracker leaves it alone, and the file is still
     * there afterwards, which is the entire point of downloading it.
     *
     * The cost, stated because nothing yet pays it: these directories are
     * not cleaned up. There is no artifact store in this build, so the
     * alternative to leaking a file is deleting one the operator asked
     * for. The path is reported, so a leaked file is at least a findable
     * one.
     */
    const wantsDownloads = input.steps.some((step) => step.action === 'wait_for_download')
    const downloadDirectory = wantsDownloads ? mkdtempSync(join(tmpdir(), 'relay-run-downloads-')) : undefined

    const openBrowser =
      deps.openBrowser ??
      ((entry: ProfileEntry) =>
        openTier2Browser(entry, {
          headless: true,
          ...deps.tier2,
          ...(downloadDirectory !== undefined
            ? { downloads: { directory: downloadDirectory, ...deps.tier2?.downloads } }
            : {}),
        }))
    const opened = await openBrowser(profile)
    if (opened.outcome === 'failed') {
      return { outcome: 'driver_failed', profile: profile.name, tier, reason: opened.reason, steps: [] }
    }

    const browser = opened.browser

    /**
     * FR-ORC's five second cancellation bound, which checking `signal`
     * BETWEEN steps alone does not deliver: a single `navigate` step can
     * legitimately sit for thirty seconds waiting on a load, and a
     * between-steps check cannot interrupt it. Closing the browser on
     * abort does: it closes the CDP connection, which rejects every
     * in-flight command immediately (see src/browser/cdp/connection.ts's
     * own header comment), so the step in progress returns at once rather
     * than waiting out its timeout.
     */
    const abortListener = (): void => {
      void browser.close()
    }
    signal.addEventListener('abort', abortListener, { once: true })

    try {
      if (signal.aborted) {
        return { outcome: 'cancelled', profile: profile.name, tier, reason: 'the run was cancelled before any step ran', steps: [] }
      }

      const page = await browser.newPage(buildNavigationGuard(profile, policy.hard_blocked_origins, tier))
      const { results, cancelled } = await runSteps(page, browser.downloads, input.steps, signal)

      if (cancelled) {
        return {
          outcome: 'cancelled',
          profile: profile.name,
          tier,
          reason: `the run was cancelled after ${results.length} of ${input.steps.length} steps`,
          steps: results,
        }
      }

      // FR-BR-8 / FR-BR-10: read the page one last time and ask whether it
      // needs a person. Done here, once, after the steps, rather than after
      // every step: it costs two round trips, and what matters is the state
      // the run actually ended in.
      const observation = await page.observe()
      const block = detectHumanBlock(observation)

      return {
        outcome: 'completed',
        profile: profile.name,
        connection,
        tier,
        destination,
        finalUrl: observation.url,
        allStepsSucceeded: results.every((result) => result.ok) && results.length === input.steps.length,
        steps: results,
        // The BROWSER's blocked requests, not the page's: a popup the page
        // opened is a separate page, and its refusals are exactly the ones
        // worth reporting.
        blockedRequests: [...browser.blockedRequests],
        dialogs: [...page.dialogs],
        consoleMessages: [...page.consoleMessages],
        captureLimits: page.captureLimits,
        ...(block !== undefined
          ? {
              humanActionNeeded: {
                ...block,
                message: describeHumanBlock(block, profile.name, destinationHost(observation.url)),
              },
            }
          : {}),
      }
    } catch (error) {
      return {
        outcome: 'driver_failed',
        profile: profile.name,
        tier,
        reason: `the tier 2 driver failed: ${error instanceof Error ? error.message : String(error)}`,
        steps: [],
      }
    } finally {
      signal.removeEventListener('abort', abortListener)
      // Unconditional: a browser left running holds this profile's
      // user-data directory lock and makes every later run on it fail with
      // an error that does not point at the cause. `close()` is idempotent,
      // so the abort listener having already called it is not a problem.
      await browser.close()
    }
  }
}

/**
 * FR-CAP-1's definition for `browser`. Risk tier `sensitive`, not `write`:
 * this call drives the operator's own browser, carrying whatever live
 * logged-in sessions the resolved profile has, which is a materially
 * different exposure than a call that only touches Relay's own data.
 * Idempotency class `mutating`: a navigation can trigger a real,
 * non-repeatable effect on the destination (a one-click confirmation, an
 * unsubscribe link, a magic-link login), so this capability makes no claim
 * that repeating the same call is safe.
 *
 * `requiresMachineLock` is `true`, per FR-CAP-3. FR-CAP-3's own example
 * says a headless browser action does NOT need the lock, and this build's
 * tier 2 browser is headless, so this could arguably be `false`. It stays
 * `true` because a tier 1 call drives the operator's visible browser and
 * this one definition covers both tiers; a per-tier lock declaration is a
 * change to the registry's own contract, not something to fake here by
 * declaring the weaker of the two.
 */
export const BROWSER_CAPABILITY_DEFINITION: CapabilityDefinition = {
  name: BROWSER_CAPABILITY_NAME,
  /**
   * Read by the model, not by a person, so it states the input shape as
   * well as the purpose. Its list of step actions is checked against the
   * schema's own action literals by a test, so the two cannot drift: a new
   * action that is not described here fails that test rather than shipping
   * as a capability the model does not know it has.
   */
  description:
    'Drives a web browser in one of the operator\'s registered Chrome profiles. Resolves which profile to use, ' +
    'establishes a connection, enforces that profile\'s origin allowlist on every request the page makes, and runs ' +
    'an ordered list of steps in one browser lifetime. Input: { destination, steps }, where destination is the ' +
    'hostname or URL the task is for, and steps is an ordered array. Every step has an "action" field, one of: ' +
    'navigate { url }, click, type { text, append? }, select { value }, press { key }, ' +
    'wait_for { expression, timeoutMs? }, exists, wait_for_download { timeoutMs? }, read_text {}, read_html {}, ' +
    'read_elements {}, screenshot {}, export_pdf {}, back {}, forward {}, reload {}, hover, scroll { y, x? }. ' +
    'ADDRESSING ELEMENTS: click, type, select and exists must say WHICH element, using any of role, name, ' +
    'selector, has_text. Prefer role and name (for example role "button", name "Sign in"): they survive a ' +
    'redesign that breaks a CSS selector, and you can discover them with a read_elements step, which lists every ' +
    'named interactive element on the page. Use selector (a CSS selector) when you already know the page. If more ' +
    'than one element matches, the step is refused rather than guessed at, so make it specific. ' +
    'Put the whole task in ONE call\'s steps, including any login: the browser is closed when the call ' +
    'returns, so a later call may not still be signed in. Read steps return the page content in the result, which ' +
    'is how you find out what the page said. To fetch a file, navigate to it or click its link, then add a ' +
    'wait_for_download step: it reports where the file was saved and how large it is. If the result carries humanActionNeeded, the page wants a person (a ' +
    'CAPTCHA, a bot wall, a signed-out session): report that to the operator and do not retry.',
  inputSchema: browserCapabilityInputSchema,
  outputSchema: browserCapabilityOutputSchema,
  riskTier: 'sensitive',
  idempotencyClass: 'mutating',
  requiredRunnerFeatures: [],
  costHint: 'free',
  requiresMachineLock: true,
  /**
   * Hands the destination to the policy engine BEFORE this capability runs,
   * so the hard-blocked list, the denylist, and first-contact escalation
   * apply at the mediation seam rather than only here.
   *
   * This capability enforcing its own origins is defence in depth, not a
   * substitute for the seam. Relying on it alone would mean every future
   * capability could opt out of governance simply by not implementing the
   * check, and nothing would report that it had.
   *
   * The host is extracted from a URL first (`destinationHost`), because
   * `normalizeDestination` alone reduces `https://admin.acme.com/x` to the
   * hostname `https`; see src/browser/url.ts's own header comment for why
   * that went unnoticed until this capability could navigate.
   *
   * Parsed rather than read off the object, so a malformed input yields no
   * destination instead of a half-trusted one.
   */
  destinationOf: (input: unknown): string | undefined => {
    const parsed = browserCapabilityInputSchema.safeParse(input)
    return parsed.success ? destinationHost(parsed.data.destination) : undefined
  },
  /**
   * Two worked examples: the simple read, and the authenticated read that
   * UC-1 actually asks for. Both are parsed against
   * `browserCapabilityInputSchema` at registration (see
   * src/capabilities/registry.ts), so neither can rot into a lie about the
   * input shape.
   */
  /**
   * FR-PRF-10: "Every run record and audit entry names the profile used,
   * and the final Slack report states it, so the operator can always see
   * which account acted." And FR-BR-8 / FR-BR-10: a page that needs a
   * person must be reported as needing one.
   *
   * Both were true of this capability's RESULT already, and both reached
   * the model. Neither reached the operator unless the model chose to
   * mention it. These lines are what make the requirement hold without
   * depending on that.
   *
   * Deliberately short and few. This goes into a chat message on a phone,
   * so it states the profile, anything that needs a human, and anything the
   * origin scope kept out; everything else stays on the run record.
   */
  reportLines: (output: unknown): readonly string[] => {
    const parsed = browserCapabilityOutputSchema.safeParse(output)
    if (!parsed.success) return []
    const result = parsed.data
    const lines: string[] = []

    if ('profile' in result && typeof result.profile === 'string') {
      const tier = 'tier' in result ? ` on tier ${String(result.tier)}` : ''
      lines.push(`Acted in the "${result.profile}" browser profile${tier}.`)
    }

    if (result.outcome === 'completed') {
      // The one line an operator must not miss.
      if (result.humanActionNeeded !== undefined) lines.push(result.humanActionNeeded.message)

      if (result.blockedRequests.length > 0) {
        const hosts = [...new Set(result.blockedRequests.map((request) => request.host))]
        lines.push(
          `The profile's origin scope blocked ${result.blockedRequests.length} request(s) to ${hosts.join(', ')}.`,
        )
      }
      if (!result.allStepsSucceeded) {
        const failed = result.steps.find((step) => !step.ok)
        lines.push(`A step did not succeed: ${failed?.action ?? 'unknown'}${failed?.detail !== undefined ? ` (${failed.detail})` : ''}.`)
      }
      if (result.captureLimits.textTruncated) {
        lines.push('A page read was truncated, so any conclusion drawn from it is drawn from a partial page.')
      }
    }

    if (result.outcome === 'navigation_refused') {
      lines.push(
        result.enforcement === 'prevented'
          ? `The navigation was PREVENTED by the profile's origin scope: ${result.reason}`
          : `Relay refused to issue the navigation, but cannot guarantee the browser did not reach it: ${result.reason}`,
      )
    }
    if (result.outcome === 'no_provider') lines.push(result.reason)
    if (result.outcome === 'driver_failed') lines.push(`The browser could not be driven: ${result.reason}`)

    return lines
  },
  inputExamples: [
    {
      destination: 'https://status.example.com/incidents',
      steps: [{ action: 'navigate', url: 'https://status.example.com/incidents' }, { action: 'read_text' }],
    },
    {
      // The authenticated read UC-1 asks for, addressed by accessible role
      // and name rather than by CSS selector, because that is what a caller
      // that has not seen the page should reach for first.
      destination: 'https://admin.example.com/invoices',
      steps: [
        { action: 'navigate', url: 'https://admin.example.com/login' },
        { action: 'read_elements' },
        { action: 'type', role: 'textbox', name: 'Username', text: 'the-username' },
        { action: 'type', role: 'textbox', name: 'Password', text: 'the-password' },
        { action: 'click', role: 'button', name: 'Sign in' },
        { action: 'wait_for', expression: "location.pathname === '/invoices'", timeoutMs: 15000 },
        { action: 'read_text' },
        { action: 'screenshot' },
      ],
    },
  ],
  run: createBrowserCapability(),
}
