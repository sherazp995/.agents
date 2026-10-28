/**
 * The shared setup a golden task needs to drive the REGISTERED browser
 * capability against the local fixture site.
 *
 * Every golden task in §16.5 that touches the browser needs the same four
 * things: a fixture server, a temporary profile registry pointing at a
 * throwaway Chrome user-data directory, a temporary policy file, and the
 * capability registered and dispatched the way `src/agent/loop.ts`
 * dispatches it. Written once here so a new golden task is the assertions
 * and nothing else, and so every one of them exercises the same production
 * path rather than each inventing its own.
 *
 * THE ONLY PRODUCTION DEFAULTS REPLACED are the two config file paths. The
 * capability, its profile resolution, its tier ladder, its origin
 * enforcement, and its driver are all the real ones.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BROWSER_CAPABILITY_DEFINITION,
  BROWSER_CAPABILITY_NAME,
  createBrowserCapability,
} from '../../src/agent/capabilities/browser.js'
import type { Capability } from '../../src/agent/loop.js'
import { CapabilityRegistry } from '../../src/capabilities/registry.js'
import { startFixtureSite } from './fixture-site.js'
import type { FixtureSite } from './fixture-site.js'

export type GoldenBrowserHarness = {
  readonly site: FixtureSite
  readonly profileName: string
  /** The capability, dispatched exactly as the agent loop dispatches it: through a registry, by name. */
  readonly run: Capability
  dispose(): Promise<void>
}

export type GoldenBrowserOptions = {
  /** The profile's short name, which a golden task then names in its own `explicitProfile`. */
  readonly profileName?: string
  /** Origin patterns the profile permits. Defaults to the loopback host the fixture serves from. */
  readonly allowedOrigins?: readonly string[]
}

/**
 * Starts the fixture site and returns the registered capability bound to a
 * throwaway client profile pinned to tier 2.
 *
 * Pinned to tier 2 deliberately: FR-PRF-4a recommends pinning a `client`
 * profile to an enforcing tier, so a golden task runs under the
 * configuration the requirement actually recommends rather than a
 * convenient one.
 */
export async function startGoldenBrowserHarness(
  options: GoldenBrowserOptions = {},
): Promise<GoldenBrowserHarness> {
  const profileName = options.profileName ?? 'client-admin'
  const allowedOrigins = options.allowedOrigins ?? ['127.0.0.1']

  const site = await startFixtureSite()
  const configDir = mkdtempSync(join(tmpdir(), 'relay-golden-config-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'relay-golden-profile-'))
  const profilesPath = join(configDir, 'profiles.yaml')
  const policyPath = join(configDir, 'policy.yaml')

  writeFileSync(
    profilesPath,
    [
      'version: 1',
      'profiles:',
      `  - name: ${profileName}`,
      '    description: The client admin dashboard automation profile',
      '    project: fixture-client',
      `    user_data_dir: ${userDataDir}`,
      '    profile_directory: Default',
      '    classification: client',
      '    allowed_origins:',
      ...allowedOrigins.map((origin) => `      - '${origin}'`),
      '    extension: false',
      '    pinned_tier: 2',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    policyPath,
    ['version: 1', 'defaults:', '  unmatched: ask', 'hard_blocked_origins:', "  - '*.chase.com'", ''].join('\n'),
    'utf8',
  )

  const registry = new CapabilityRegistry()
  registry.register({
    ...BROWSER_CAPABILITY_DEFINITION,
    run: createBrowserCapability({ profilesPath, policyPath }),
  })
  const run = registry.toCapabilityMap()[BROWSER_CAPABILITY_NAME]
  if (run === undefined) throw new Error('the browser capability did not register into the golden-task registry')

  return {
    site,
    profileName,
    run,
    dispose: async () => {
      await site.close()
      for (const dir of [configDir, userDataDir]) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        } catch {
          // A leaked temp directory is not a golden-task failure.
        }
      }
    },
  }
}
