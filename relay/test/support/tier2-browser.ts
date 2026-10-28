/**
 * A disposable tier 2 browser for integration tests.
 *
 * WHY THE PROFILE IS A THROWAWAY DIRECTORY. A tier 2 browser takes an
 * exclusive lock on its user-data directory (FR-PRF-6a), so a suite that
 * shared one directory across files could not run two browser tests at
 * once, and vitest runs test files in parallel by default. Each call here
 * gets its own `mkdtemp` directory, which also means every test starts
 * logged out, with no cookies, no cache, and no state from any other test.
 *
 * WHY CLEANUP RETRIES. Chrome is killed with SIGKILL, and its own writes to
 * the profile directory can land microseconds afterwards. A plain `rmSync`
 * loses that race often enough to turn a passing test red with
 * `ENOTEMPTY`, which says nothing about the code under test. `maxRetries`
 * makes the removal wait the process out. A directory that still cannot be
 * removed is left behind rather than failing the test: it is in the OS
 * temp directory, and a leaked temp directory must not be reported as a
 * driver defect.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openTier2Browser } from '../../src/browser/tier2/browser.js'
import type { Tier2Browser } from '../../src/browser/tier2/browser.js'
import { defaultChromeExecutablePath } from '../../src/browser/launch.js'
import { profileEntrySchema } from '../../src/profiles/schema.js'
import type { ProfileEntry } from '../../src/profiles/schema.js'

/**
 * Whether a real Chrome exists to drive.
 *
 * Exported so a suite can say out loud that it skipped, rather than
 * quietly reporting success for tests that never ran. A silent skip is the
 * failure mode this project has already been bitten by: twenty smoke tests
 * passed while the thing they tested could never be true.
 */
export function chromeIsAvailable(): boolean {
  return existsSync(defaultChromeExecutablePath())
}

export function buildTestProfile(userDataDir: string, overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return profileEntrySchema.parse({
    name: 'fixture',
    description: 'Disposable automation profile for integration tests',
    user_data_dir: userDataDir,
    profile_directory: 'Default',
    classification: 'work',
    allowed_origins: ['127.0.0.1'],
    pinned_tier: 2,
    ...overrides,
  })
}

export type DisposableTier2Browser = {
  readonly browser: Tier2Browser
  readonly profile: ProfileEntry
  readonly userDataDir: string
  dispose(): Promise<void>
}

/**
 * Launches a headless tier 2 browser against a fresh throwaway profile.
 *
 * Throws on failure rather than returning an outcome: a test that could not
 * start a browser has nothing to assert, and the launch failure's own
 * reason is the most useful thing to put in the error.
 */
export async function openDisposableTier2Browser(
  overrides: Partial<ProfileEntry> = {},
): Promise<DisposableTier2Browser> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'relay-tier2-'))
  const profile = buildTestProfile(userDataDir, overrides)

  const result = await openTier2Browser(profile, { headless: true })
  if (result.outcome === 'failed') {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw new Error(`could not start a tier 2 browser for the integration suite: ${result.reason}`)
  }

  return {
    browser: result.browser,
    profile,
    userDataDir,
    dispose: async () => {
      await result.browser.close()
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        // See this file's header comment: a leaked temp directory is not a
        // test failure.
      }
    },
  }
}

/** A guard that permits everything. For tests about a primitive other than enforcement, so a scoping refusal cannot silently be the reason a primitive test fails. */
export const permissiveGuard = () => ({ allowed: true }) as const
