import { describe, expect, it, vi } from 'vitest'

import {
  BROWSER_CAPABILITY_DEFINITION,
  BROWSER_CAPABILITY_NAME,
  BROWSER_STEP_ACTIONS,
  browserCapabilityInputSchema,
  createBrowserCapability,
} from '../../../src/agent/capabilities/browser.js'
import type { BrowserCapabilityDependencies } from '../../../src/agent/capabilities/browser.js'
import { CapabilityRegistry, listCapabilities, unregisterCapability } from '../../../src/capabilities/registry.js'
import { registerBuiltinCapabilities } from '../../../src/capabilities/wiring.js'
import { profileEntrySchema, profileRegistrySchema } from '../../../src/profiles/schema.js'
import type { ProfileEntry, ProfileRegistry } from '../../../src/profiles/schema.js'
import type { Policy } from '../../../src/config/schema.js'
import type { ChromeLaunchHandle, SpawnChromeFn } from '../../../src/browser/launch.js'
import type { DrivablePage, NavigationGuard } from '../../../src/browser/tier2/page.js'
import type { DrivableBrowserOutcome } from '../../../src/browser/tier2/browser.js'

/**
 * This file proves every FR-PRF-2/4/7 outcome through the REGISTERED
 * capability, per this task's own instruction: each test builds a
 * `CapabilityDefinition` from `createBrowserCapability` with fakes, hands
 * it to a private `CapabilityRegistry` (never the shared process-wide
 * one), and calls it the same way `src/agent/loop.ts`'s `runCapability`
 * does, through `toCapabilityMap()`. No test in this file calls
 * `resolveProfile`, `establishProfileConnection`, or `enforceNavigation`
 * directly.
 */

const HOME = '/Users/test-operator'
const SIGNAL = new AbortController().signal

function buildProfile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return profileEntrySchema.parse({
    name: 'acme',
    description: 'Acme client work',
    user_data_dir: '/Users/test-operator/chrome-relay-acme',
    profile_directory: 'Profile 1',
    classification: 'client',
    allowed_origins: ['*.acme.com'],
    ...overrides,
  })
}

function buildRegistry(profiles: readonly Partial<ProfileEntry>[]): ProfileRegistry {
  return profileRegistrySchema.parse({ version: 1, profiles: profiles.map((profile) => buildProfile(profile)) })
}

function buildPolicy(hardBlockedOrigins: readonly string[] = ['*.hard-blocked.invalid']): Policy {
  return {
    version: 1,
    defaults: { unmatched: 'ask' },
    hard_blocked_origins: [...hardBlockedOrigins],
  }
}

/** A spawnChrome fake that never exits and never errors, so a `launched` outcome depends only on the (instant, faked) readiness grace elapsing. */
function neverSettlingSpawnChrome(): SpawnChromeFn {
  return () => {
    const handle: ChromeLaunchHandle = {
      pid: 4242,
      onExit: () => {},
      onSpawnError: () => {},
    }
    return handle
  }
}

/**
 * A tier 2 driver that answers without a browser.
 *
 * The real driver is proven against a real Chrome in
 * test/browser/tier2/*.integration.test.ts. What this fake is for is the
 * COMPOSITION this file owns: which outcome the capability returns, what it
 * puts in a step result, whether it closes the browser, whether it stops on
 * cancellation. Driving a real Chrome to answer those would make each of
 * these tests seconds long and would couple them to page behaviour they are
 * not about.
 */
function fakeDriver(
  options: {
    readonly clickResult?: { readonly clicked: boolean; readonly reason?: string }
    readonly onStep?: (action: string) => void
  } = {},
) {
  let closeCount = 0
  let openCount = 0
  let browserClosed = false
  let capturedGuard: NavigationGuard | undefined

  const note = (action: string): void => options.onStep?.(action)

  // Typed as DrivablePage, NOT cast past the compiler. This double has
  // drifted from the real page three times in one milestone (screenshot's
  // return shape, captureLimits, observe), and each time the failure showed
  // up as a confusing assertion elsewhere instead of a type error here. The
  // annotation is what makes the next addition to that surface break the
  // build in this file.
  const page: DrivablePage = {
    navigate: async (url: string) => {
      note('navigate')
      return { outcome: 'loaded' as const, url, status: 200 }
    },
    click: async () => {
      note('click')
      return options.clickResult ?? { clicked: true }
    },
    type: async () => {
      note('type')
      return { typed: true }
    },
    selectOption: async () => {
      note('select')
      return { selected: true }
    },
    pressKey: async () => {
      note('press')
      return { pressed: true }
    },
    waitFor: async () => {
      note('wait_for')
      return { outcome: 'satisfied' as const, waitedMs: 1 }
    },
    exists: async () => {
      note('exists')
      return true
    },
    readText: async () => {
      note('read_text')
      return 'page text'
    },
    readHtml: async () => {
      note('read_html')
      return '<html></html>'
    },
    screenshot: async () => {
      note('screenshot')
      return { ok: true as const, data: 'BASE64' }
    },
    exportPdf: async () => {
      note('export_pdf')
      return { ok: true as const, data: 'PDFBASE64' }
    },
    goBack: async () => {
      note('back')
      return { outcome: 'loaded' as const, url: 'https://app.acme.com/', status: 200 }
    },
    goForward: async () => {
      note('forward')
      return { outcome: 'loaded' as const, url: 'https://app.acme.com/next', status: 200 }
    },
    reload: async () => {
      note('reload')
      return { outcome: 'loaded' as const, url: 'https://app.acme.com/', status: 200 }
    },
    hover: async () => {
      note('hover')
      return { hovered: true }
    },
    scrollBy: async () => {
      note('scroll')
    },
    currentUrl: async () => 'https://app.acme.com/invoices',
    title: async () => 'Invoices',
    readElements: async () => [{ role: 'button', name: 'Sign in', backendNodeId: 1 }],
    evaluate: async <T,>() => undefined as T | undefined,
    observe: async () => ({
      url: 'https://app.acme.com/invoices',
      title: 'Invoices',
      text: 'page text',
      html: '<html></html>',
      status: 200,
    }),
    blockedRequests: [],
    dialogs: [],
    consoleMessages: [],
    networkRequests: [],
    captureLimits: { consoleDropped: 0, networkDropped: 0, textTruncated: false },
    close: async () => {},
  }

  // Typed as DrivableBrowserOutcome, not cast past the compiler. The
  // browser double drifted exactly the way the page double did: when the
  // capability started reading `blockedRequests`, three tests failed with
  // "driver_failed" instead of a type error naming the missing member.
  const openBrowser = async (): Promise<DrivableBrowserOutcome> => {
      openCount++
      return {
        outcome: 'ready' as const,
        browser: {
          profile: 'acme',
          blockedRequests: [],
          downloads: {
            directory: '/tmp/fake-downloads',
            downloads: [],
            waitForDownload: async () => ({ outcome: 'none' as const, reason: 'no download started' }),
            dispose: () => {},
          },
          newPage: async (guard) => {
            capturedGuard = guard
            return page
          },
          // Idempotent, because `Tier2Browser.close()` documents itself as
          // idempotent and the capability relies on that: its abort
          // listener and its `finally` block both call it. A fake that
          // counted two closes for one shutdown would be testing the fake.
          close: async () => {
            if (browserClosed) return
            browserClosed = true
            closeCount++
          },
        },
      }
  }

  return {
    openBrowser,
    closeCalls: () => closeCount,
    openCalls: () => openCount,
    lastGuard: () => capturedGuard,
  }
}

/** Registers `definition` into a fresh registry and returns the callable the engine would actually invoke, mirroring src/agent/loop.ts's own dispatch path (registry -> toCapabilityMap() -> the function by name). */
function registerAndDispatch(deps: BrowserCapabilityDependencies) {
  const registry = new CapabilityRegistry()
  registry.register({ ...BROWSER_CAPABILITY_DEFINITION, run: createBrowserCapability(deps) })
  return { registry, run: registry.toCapabilityMap()[BROWSER_CAPABILITY_NAME]! }
}

/** Common fakes so a test that never reaches the connection ladder does not need to restate them, and a test that DOES reach it opts into the instant-clock versions explicitly. */
function baseDeps(overrides: Partial<BrowserCapabilityDependencies> = {}): BrowserCapabilityDependencies {
  return {
    home: HOME,
    platform: 'darwin',
    sleep: () => Promise.resolve(),
    spawnChrome: neverSettlingSpawnChrome(),
    clock: { now: () => 0, sleep: () => Promise.resolve() },
    ...overrides,
  }
}

describe('the browser capability, registered and dispatched through the registry', () => {
  it('refuses a call with no resolved profile, and names why, per FR-PRF-2', async () => {
    const loadPolicyFile = vi.fn()
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'] }]),
        loadPolicyFile,
        probeExtension: vi.fn(),
      }),
    )

    const result = (await run({ destination: 'not-acme.example' }, SIGNAL)) as { outcome: string; reason: string }

    expect(result.outcome).toBe('refused_no_profile')
    expect(result.reason.length).toBeGreaterThan(0)
    // Nothing past profile resolution ran: no policy load, no connection
    // attempt. A refusal here is a refusal, not a partial action.
    expect(loadPolicyFile).not.toHaveBeenCalled()
  })

  it('asks rather than acting on an ambiguous resolution, naming the candidates', async () => {
    const loadPolicyFile = vi.fn()
    const probeExtension = vi.fn()
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () =>
          buildRegistry([
            { name: 'acme-one', project: 'acme', allowed_origins: ['*.acme.com'] },
            { name: 'acme-two', project: 'acme', allowed_origins: ['*.acme.net'] },
          ]),
        loadPolicyFile,
        probeExtension,
      }),
    )

    const result = (await run({ destination: 'app.acme.com', project: 'acme' }, SIGNAL)) as {
      outcome: string
      candidates: string[]
    }

    expect(result.outcome).toBe('ambiguous_profile')
    expect(result.candidates.sort()).toEqual(['acme-one', 'acme-two'])
    // "Asks rather than acting": no connection was attempted and no policy
    // was consulted for either candidate.
    expect(loadPolicyFile).not.toHaveBeenCalled()
    expect(probeExtension).not.toHaveBeenCalled()
  })

  it('prevents an off-allowlist navigation outright on tier 2 (pinned), per FR-PRF-4', async () => {
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], pinned_tier: 2 }]),
        loadPolicyFile: () => buildPolicy(),
        probeExtension: vi.fn(),
      }),
    )

    const result = (await run({ destination: 'not-acme.example', explicitProfile: 'acme' }, SIGNAL)) as {
      outcome: string
      tier: number
      enforcement: string
    }

    expect(result.outcome).toBe('navigation_refused')
    expect(result.tier).toBe(2)
    expect(result.enforcement).toBe('prevented')
  })

  it('drives the tier 2 browser for an on-allowlist call and reports every step', async () => {
    const driver = fakeDriver()
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], pinned_tier: 2 }]),
        loadPolicyFile: () => buildPolicy(),
        probeExtension: vi.fn(),
        openBrowser: driver.openBrowser,
      }),
    )

    const result = (await run(
      {
        destination: 'https://app.acme.com/invoices',
        explicitProfile: 'acme',
        steps: [{ action: 'navigate', url: 'https://app.acme.com/invoices' }, { action: 'read_text' }],
      },
      SIGNAL,
    )) as { outcome: string; tier: number; allStepsSucceeded: boolean; steps: Array<{ action: string; value?: string }> }

    expect(result.outcome).toBe('completed')
    expect(result.tier).toBe(2)
    expect(result.allStepsSucceeded).toBe(true)
    expect(result.steps.map((step) => step.action)).toEqual(['navigate', 'read_text'])
    expect(result.steps[1]?.value).toBe('page text')
    // The browser is always closed: a leaked one holds the profile's
    // user-data directory lock and breaks every later run on that profile.
    expect(driver.closeCalls()).toBe(1)
  })

  it('runs nothing and says so plainly when the tier that was established has no driver', async () => {
    const driver = fakeDriver()
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], extension: true }]),
        loadPolicyFile: () => buildPolicy(),
        probeExtension: () => Promise.resolve(true),
        openBrowser: driver.openBrowser,
      }),
    )

    const result = (await run(
      { destination: 'app.acme.com', explicitProfile: 'acme', steps: [{ action: 'read_text' }] },
      SIGNAL,
    )) as { outcome: string; tier: number; reason: string }

    expect(result.outcome).toBe('no_provider')
    expect(result.tier).toBe(1)
    expect(result.reason).toContain('no tier 1 driver')
    // The point of a distinct outcome: nothing was driven, and nothing
    // pretended to be.
    expect(driver.openCalls()).toBe(0)
  })

  it('reports a browser that could not be started as a driver failure, not as a completed call', async () => {
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], pinned_tier: 2 }]),
        loadPolicyFile: () => buildPolicy(),
        probeExtension: vi.fn(),
        openBrowser: () => Promise.resolve({ outcome: 'failed', reason: 'chrome would not start' } as const),
      }),
    )

    const result = (await run({ destination: 'app.acme.com', explicitProfile: 'acme' }, SIGNAL)) as {
      outcome: string
      reason: string
    }

    expect(result.outcome).toBe('driver_failed')
    expect(result.reason).toContain('chrome would not start')
  })

  it('stops at the first failing step rather than driving a page whose state nobody predicted', async () => {
    const driver = fakeDriver({ clickResult: { clicked: false, reason: 'no such button' } })
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], pinned_tier: 2 }]),
        loadPolicyFile: () => buildPolicy(),
        probeExtension: vi.fn(),
        openBrowser: driver.openBrowser,
      }),
    )

    const result = (await run(
      {
        destination: 'app.acme.com',
        explicitProfile: 'acme',
        steps: [{ action: 'click', selector: '#go' }, { action: 'read_text' }, { action: 'screenshot' }],
      },
      SIGNAL,
    )) as { outcome: string; allStepsSucceeded: boolean; steps: Array<{ action: string; ok: boolean }> }

    expect(result.outcome).toBe('completed')
    expect(result.allStepsSucceeded).toBe(false)
    expect(result.steps.map((step) => step.action)).toEqual(['click'])
    expect(result.steps[0]?.ok).toBe(false)
  })

  it('never echoes typed text back, because a type step very often carries a credential', async () => {
    const driver = fakeDriver()
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], pinned_tier: 2 }]),
        loadPolicyFile: () => buildPolicy(),
        probeExtension: vi.fn(),
        openBrowser: driver.openBrowser,
      }),
    )

    const result = await run(
      {
        destination: 'app.acme.com',
        explicitProfile: 'acme',
        steps: [{ action: 'type', selector: '#password', text: 'hunter2-super-secret' }],
      },
      SIGNAL,
    )

    expect(JSON.stringify(result)).not.toContain('hunter2-super-secret')
  })

  it('stops on cancellation and reports how far it got, rather than finishing the plan', async () => {
    const controller = new AbortController()
    const driver = fakeDriver({
      onStep: (action) => {
        if (action === 'navigate') controller.abort()
      },
    })
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], pinned_tier: 2 }]),
        loadPolicyFile: () => buildPolicy(),
        probeExtension: vi.fn(),
        openBrowser: driver.openBrowser,
      }),
    )

    const result = (await run(
      {
        destination: 'app.acme.com',
        explicitProfile: 'acme',
        steps: [
          { action: 'navigate', url: 'https://app.acme.com/' },
          { action: 'read_text' },
          { action: 'screenshot' },
        ],
      },
      controller.signal,
    )) as { outcome: string; steps: unknown[]; reason: string }

    expect(result.outcome).toBe('cancelled')
    expect(result.steps).toHaveLength(1)
    expect(result.reason).toContain('1 of 3 steps')
    expect(driver.closeCalls()).toBe(1)
  })

  it('hands the page a guard that refuses a host outside the profile allowlist, so interception enforces the same rule the up-front check did', async () => {
    const driver = fakeDriver()
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], pinned_tier: 2 }]),
        loadPolicyFile: () => buildPolicy(),
        probeExtension: vi.fn(),
        openBrowser: driver.openBrowser,
      }),
    )

    await run({ destination: 'app.acme.com', explicitProfile: 'acme' }, SIGNAL)

    const guard = driver.lastGuard()
    expect(guard).toBeDefined()
    expect(guard?.('https://app.acme.com/invoices')).toEqual({ allowed: true })
    expect(guard?.('https://tracker.evil.test/beacon.gif').allowed).toBe(false)
  })

  it('returns a result that satisfies its own declared output schema, so the registered contract and the real return cannot drift apart', async () => {
    const driver = fakeDriver()
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], pinned_tier: 2 }]),
        loadPolicyFile: () => buildPolicy(),
        probeExtension: vi.fn(),
        openBrowser: driver.openBrowser,
      }),
    )

    // Every step kind, in one call, so no branch of the step-result union
    // escapes the schema check.
    const result = await run(
      {
        destination: 'app.acme.com',
        explicitProfile: 'acme',
        steps: [
          { action: 'navigate', url: 'https://app.acme.com/' },
          { action: 'type', selector: '#a', text: 'x' },
          { action: 'select', selector: '#b', value: 'v' },
          { action: 'press', key: 'Enter' },
          { action: 'wait_for', expression: 'true' },
          { action: 'wait_for_download', timeoutMs: 1000 },
          { action: 'exists', selector: '#c' },
          { action: 'click', selector: '#d' },
          { action: 'scroll', y: 100 },
          { action: 'read_text' },
          { action: 'read_html' },
          { action: 'read_elements' },
          { action: 'screenshot' },
        ],
      },
      SIGNAL,
    )

    // Nothing validates a capability's output against its own declared
    // schema at runtime, so without this the two could diverge silently:
    // the driver's screenshot return shape changed once already and no
    // test noticed, because the fake had been updated to the old shape.
    const parsed = BROWSER_CAPABILITY_DEFINITION.outputSchema.safeParse(result)
    expect(parsed.success ? null : parsed.error.issues).toBeNull()

    const completed = result as { outcome: string; allStepsSucceeded: boolean; steps: Array<{ action: string; ok: boolean }> }
    expect(completed.outcome).toBe('completed')
    // A wait_for_download with nothing downloading fails, which stops the
    // sequence: this list is deliberately the prefix up to and including it.
    expect(completed.steps.map((step) => step.action)).toContain('wait_for_download')
  })

  describe('what the model is told about this capability', () => {
    it('describes every step action the schema actually accepts, so a new action cannot ship unmentioned', () => {
      // The drift this catches: adding a twelfth action to the schema and
      // forgetting the description means the model never learns the
      // capability grew, and nothing else would notice.
      expect(BROWSER_STEP_ACTIONS.length).toBeGreaterThan(5)
      for (const action of BROWSER_STEP_ACTIONS) {
        expect(BROWSER_CAPABILITY_DEFINITION.description).toContain(action)
      }
    })

    it('ships input examples that are themselves valid inputs, checked by the registry at registration', () => {
      expect(BROWSER_CAPABILITY_DEFINITION.inputExamples?.length).toBeGreaterThan(0)
      for (const example of BROWSER_CAPABILITY_DEFINITION.inputExamples ?? []) {
        expect(browserCapabilityInputSchema.safeParse(example).success).toBe(true)
      }
    })

    it('reports the profile it acted in, so FR-PRF-10 does not depend on the model mentioning it', () => {
      const lines = BROWSER_CAPABILITY_DEFINITION.reportLines?.({
        outcome: 'completed',
        profile: 'westside',
        connection: {},
        tier: 2,
        destination: 'app.westside.test',
        allStepsSucceeded: true,
        steps: [],
        blockedRequests: [],
        dialogs: [],
        consoleMessages: [],
        captureLimits: { consoleDropped: 0, networkDropped: 0, textTruncated: false },
      })

      expect(lines?.some((line) => line.includes('"westside"'))).toBe(true)
    })

    it('reports a page that needs a human, and what the origin scope kept out', () => {
      const lines =
        BROWSER_CAPABILITY_DEFINITION.reportLines?.({
          outcome: 'completed',
          profile: 'acme',
          connection: {},
          tier: 2,
          destination: 'admin.acme.test',
          allStepsSucceeded: true,
          steps: [],
          blockedRequests: [{ url: 'https://tracker.evil.test/b.gif', host: 'tracker.evil.test', resourceType: 'Image', reason: 'not permitted' }],
          dialogs: [],
          consoleMessages: [],
          captureLimits: { consoleDropped: 0, networkDropped: 0, textTruncated: false },
          humanActionNeeded: {
            kind: 'captcha',
            confidence: 'likely',
            evidence: 'reCAPTCHA markup',
            action: 'Complete it yourself.',
            message: 'Human action needed on admin.acme.test, in the "acme" profile: captcha.',
          },
        }) ?? []

      expect(lines.some((line) => line.includes('Human action needed'))).toBe(true)
      expect(lines.some((line) => line.includes('tracker.evil.test'))).toBe(true)
    })

    it('returns nothing at all for an output that is not one of its own results, rather than guessing', () => {
      expect(BROWSER_CAPABILITY_DEFINITION.reportLines?.({ unrelated: true })).toEqual([])
      expect(BROWSER_CAPABILITY_DEFINITION.reportLines?.(null)).toEqual([])
    })

    it('is refused registration outright if an example stops matching the input schema', () => {
      const registry = new CapabilityRegistry()

      expect(() => {
        registry.register({
          ...BROWSER_CAPABILITY_DEFINITION,
          // No `destination`, which the schema requires.
          inputExamples: [{ steps: [{ action: 'read_text' }] }],
        })
      }).toThrow(/inputExamples\[0\] does not satisfy its own inputSchema/)
    })
  })

  it('extracts the host from a full URL for the policy seam, rather than the scheme', () => {
    // The bug src/browser/url.ts exists for: normalizeDestination alone
    // reduces this URL to the hostname "https", which matches no allowlist
    // and names a destination that does not exist.
    expect(BROWSER_CAPABILITY_DEFINITION.destinationOf?.({ destination: 'https://admin.acme.com/invoices' })).toBe(
      'admin.acme.com',
    )
    expect(BROWSER_CAPABILITY_DEFINITION.destinationOf?.({ destination: 'admin.acme.com' })).toBe('admin.acme.com')
  })

  describe('tier 1: refused-at-request, never claimed as prevented', () => {
    it('distinguishes refused_at_request (tier 1) from prevented (tier 2/3) for an equivalent off-allowlist call', async () => {
      const { run: runTier1 } = registerAndDispatch(
        baseDeps({
          loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], extension: true }]),
          loadPolicyFile: () => buildPolicy(),
          probeExtension: () => Promise.resolve(true),
        }),
      )
      const { run: runTier2 } = registerAndDispatch(
        baseDeps({
          loadProfileRegistry: () => buildRegistry([{ name: 'acme', allowed_origins: ['*.acme.com'], pinned_tier: 2 }]),
          loadPolicyFile: () => buildPolicy(),
          probeExtension: vi.fn(),
        }),
      )

      const tier1Result = (await runTier1({ destination: 'not-acme.example', explicitProfile: 'acme' }, SIGNAL)) as {
        outcome: string
        tier: number
        enforcement: string
      }
      const tier2Result = (await runTier2({ destination: 'not-acme.example', explicitProfile: 'acme' }, SIGNAL)) as {
        outcome: string
        tier: number
        enforcement: string
      }

      expect(tier1Result.outcome).toBe('navigation_refused')
      expect(tier1Result.tier).toBe(1)
      expect(tier1Result.enforcement).toBe('refused_at_request')
      expect(tier1Result.enforcement).not.toBe('prevented')

      expect(tier2Result.outcome).toBe('navigation_refused')
      expect(tier2Result.enforcement).toBe('prevented')

      // The load-bearing assertion for the whole task: the same shape of
      // refusal at two different tiers must not collapse to one value.
      expect(tier1Result.enforcement).not.toBe(tier2Result.enforcement)
    })
  })

  it('escalates to the operator when the tier ladder lands on none, without attempting enforcement', async () => {
    const loadPolicyFile = vi.fn()
    // Not pinned, no extension declared, and tier 2 unavailable (the
    // profile's own user_data_dir is Chrome's default for this platform):
    // FR-PRF-7's own "there is no fallback" case.
    const { run } = registerAndDispatch(
      baseDeps({
        loadProfileRegistry: () =>
          buildRegistry([
            {
              name: 'acme',
              allowed_origins: ['*.acme.com'],
              user_data_dir: `${HOME}/Library/Application Support/Google/Chrome`,
              extension: false,
            },
          ]),
        loadPolicyFile,
        probeExtension: vi.fn(),
      }),
    )

    const result = (await run({ destination: 'app.acme.com', explicitProfile: 'acme' }, SIGNAL)) as {
      outcome: string
      reason: string
    }

    expect(result.outcome).toBe('connection_escalated')
    expect(result.reason.length).toBeGreaterThan(0)
    // Enforcement was never even consulted: there is no tier to enforce at.
    expect(loadPolicyFile).not.toHaveBeenCalled()
  })

  it('appears in the registry\'s derived tool list once registered, so the engine can actually see it', () => {
    const registry = new CapabilityRegistry()
    registry.register(BROWSER_CAPABILITY_DEFINITION)

    expect(registry.names()).toContain(BROWSER_CAPABILITY_NAME)
    expect(registry.toCapabilityMap()[BROWSER_CAPABILITY_NAME]).toBe(BROWSER_CAPABILITY_DEFINITION.run)
  })

  it('is registered by registerBuiltinCapabilities(), the one production wiring path, alongside echo', () => {
    registerBuiltinCapabilities()
    try {
      const names = listCapabilities().map((definition) => definition.name)
      expect(names).toContain(BROWSER_CAPABILITY_NAME)
      expect(names).toContain('echo')
    } finally {
      unregisterCapability(BROWSER_CAPABILITY_NAME)
    }
  })
})
