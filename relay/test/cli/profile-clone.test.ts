import { describe, expect, it, vi } from 'vitest'

import {
  chromeProcessNames,
  formatChromeProfiles,
  isSafeProfileName,
  listChromeProfiles,
  minimalLocalState,
  runProfileClone,
} from '../../src/cli/profile-clone.js'

/**
 * Cloning a profile copies live credential material, so most of this file
 * is about the refusals.
 *
 * The one that matters most is the running-Chrome guard. Copying a live
 * cookie store does not fail: it SUCCEEDS, and produces a clone that is
 * silently signed out, with nothing explaining why. The operator would then
 * conclude the whole mechanism does not work.
 */

const HOME = '/Users/op'
const CHROME = `${HOME}/Library/Application Support/Google/Chrome`

function clone(overrides: Partial<Parameters<typeof runProfileClone>[0]> = {}) {
  return runProfileClone({
    from: 'Profile 10',
    to: 'cohabit',
    home: HOME,
    platform: 'darwin',
    chromeRunningCheck: () => 'not_running' as const,
    copyProfile: () => {},
    makeDirectory: () => {},
    readLocalState: () => JSON.stringify({ os_crypt: { encrypted_key: 'KEY' }, profile: { info_cache: {} } }),
    writeLocalState: () => {},
    pathExists: (path) => path === `${CHROME}/Profile 10`,
    ...overrides,
  })
}

describe('runProfileClone refuses before it can do harm', () => {
  it('REFUSES while Chrome is running, because the copy would succeed and be silently signed out', () => {
    const copyProfile = vi.fn()

    const result = clone({ chromeRunningCheck: () => 'running' as const, copyProfile })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('Quit Chrome')
    expect(result.report).toContain('silently')
    expect(copyProfile).not.toHaveBeenCalled()
  })

  it('refuses a source profile that does not exist, and says the name is the FOLDER name', () => {
    // "Profile 10" and "hasan@cohabit.com.au" are the same profile, and
    // Chrome only ever shows the second. Getting this wrong means driving
    // the wrong account.
    const result = clone({ from: 'hasan@cohabit.com.au', pathExists: () => false })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('FOLDER name')
    expect(result.report).toContain('relay profile-list')
  })

  it('REFUSES a destination inside Chrome\'s own directory, which would reproduce the exact problem', () => {
    const copyProfile = vi.fn()

    const result = clone({ root: CHROME, to: 'cohabit', copyProfile })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('FR-PRF-6a')
    expect(copyProfile).not.toHaveBeenCalled()
  })

  it('refuses to overwrite an existing destination unless forced, because its cookies may be newer', () => {
    const copyProfile = vi.fn()
    const result = clone({ pathExists: () => true, copyProfile })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('--force')
    expect(copyProfile).not.toHaveBeenCalled()
  })

  it('proceeds with --force, since that is what it is for', () => {
    const copyProfile = vi.fn()
    const result = clone({ pathExists: () => true, force: true, copyProfile })

    expect(result.exitCode).toBe(0)
    expect(copyProfile).toHaveBeenCalledTimes(1)
  })
})

describe('runProfileClone on the happy path', () => {
  it('copies into <destination>/Default, which is what the written config points at', () => {
    const copies: Array<[string, string]> = []

    const result = clone({ copyProfile: (from, to) => copies.push([from, to]) })

    expect(result.exitCode).toBe(0)
    expect(copies).toEqual([[`${CHROME}/Profile 10`, `${HOME}/chrome-profiles/cohabit/Default`]])
    expect(result.report).toContain(`user_data_dir: ${HOME}/chrome-profiles/cohabit`)
    expect(result.report).toContain('profile_directory: Default')
  })

  it('states plainly that this duplicates credentials, and how to revoke it', () => {
    // An operator should make that trade knowingly rather than discover it.
    const result = clone()

    expect(result.report).toContain('second copy')
    expect(result.report).toContain('saved passwords')
    expect(result.report).toContain('Delete the directory')
  })

  it('says the allowlist PREVENTS rather than discourages, so the origins get filled in properly', () => {
    const result = clone()

    expect(result.report).toContain('PREVENTED')
    expect(result.report).toContain('relay doctor')
  })
})

describe('minimalLocalState', () => {
  it('carries os_crypt across and leaves every other profile\'s account list behind', () => {
    // Local State lists every OTHER profile's display name and signed-in
    // email. Copying it wholesale would scatter the operator's full account
    // list into each automation directory for no benefit.
    const source = JSON.stringify({
      os_crypt: { encrypted_key: 'KEY' },
      profile: { info_cache: { 'Profile 9': { user_name: 'someone@example.com' } } },
      other_settings: { lots: 'of things' },
    })

    const written = minimalLocalState(source)

    expect(JSON.parse(written)).toEqual({ os_crypt: { encrypted_key: 'KEY' } })
    expect(written).not.toContain('someone@example.com')
    expect(written).not.toContain('other_settings')
  })

  it('writes a valid, empty os_crypt when the source cannot be read', () => {
    // On macOS the key lives in the Keychain, so an empty section still
    // yields a working clone. Writing valid JSON beats writing nothing.
    expect(JSON.parse(minimalLocalState(undefined))).toEqual({ os_crypt: {} })
    expect(JSON.parse(minimalLocalState('{ not json'))).toEqual({ os_crypt: {} })
  })
})

describe('listChromeProfiles', () => {
  it('maps each folder name to its display name and account, which is the mapping Chrome never shows', () => {
    const state = JSON.stringify({
      profile: {
        info_cache: {
          'Profile 10': { name: 'hasan@cohabit.com.au', user_name: 'hassan@cohabit.com.au' },
          'Profile 1': { name: 'Your Chrome' },
        },
      },
    })

    const profiles = listChromeProfiles(HOME, 'darwin', () => state)

    expect(profiles).toEqual([
      { directory: 'Profile 1', name: 'Your Chrome' },
      { directory: 'Profile 10', name: 'hasan@cohabit.com.au', account: 'hassan@cohabit.com.au' },
    ])
  })

  it('returns nothing, rather than throwing, when Local State is absent or unreadable', () => {
    expect(listChromeProfiles(HOME, 'darwin', () => undefined)).toEqual([])
    expect(listChromeProfiles(HOME, 'darwin', () => '{ not json')).toEqual([])
  })

  it('formats an empty list as an explanation rather than a blank screen', () => {
    expect(formatChromeProfiles([])).toContain('No Chrome profiles were found')
  })
})

describe('the guard must work on the platforms this file claims to support', () => {
  it('detects a running chrome on LINUX, where the process is not called "Google Chrome"', () => {
    // The defect this pins down failed OPEN, which is the worst direction.
    // The first version matched only the macOS name, so on Linux the guard
    // saw no Chrome, allowed the copy, and produced exactly the silently
    // signed-out clone it exists to prevent.
    const names = chromeProcessNames('linux')

    expect(names).toContain('google-chrome')
    expect(names).toContain('/chrome')
    // And the macOS name is not what Linux looks for.
    expect(names).not.toContain('google chrome')
  })

  it('looks for the macOS process name on darwin', () => {
    expect(chromeProcessNames('darwin')).toContain('google chrome')
  })

  it('DECLINES on windows rather than guessing, since ps does not exist there', () => {
    // The first version hardcoded /bin/ps, whose ENOENT was caught and read
    // as "Chrome is running", so the command refused forever with a reason
    // that was not true.
    const copyProfile = vi.fn()
    // The REAL check, not a stub: this asserts what the production default
    // does on win32, which is where the defect was.
    const result = runProfileClone({
      from: 'Profile 10',
      to: 'cohabit',
      home: HOME,
      platform: 'win32',
      copyProfile,
      makeDirectory: () => {},
      pathExists: () => true,
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('cannot tell whether Chrome is running')
    expect(copyProfile).not.toHaveBeenCalled()
  })
})

describe('names are pasted into paths, so they are validated', () => {
  it('refuses a --from that escapes Chrome\'s own directory', () => {
    const copyProfile = vi.fn()
    const result = clone({ from: '../../../etc', copyProfile })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('path separator')
    expect(copyProfile).not.toHaveBeenCalled()
  })

  it('refuses a --to that escapes the clone root', () => {
    const copyProfile = vi.fn()
    const result = clone({ to: '../../elsewhere', copyProfile })

    expect(result.exitCode).toBe(1)
    expect(copyProfile).not.toHaveBeenCalled()
  })

  it('refuses a hidden --to, so a clone cannot hide from whoever has to delete it', () => {
    expect(clone({ to: '.hidden' }).exitCode).toBe(1)
  })

  it('accepts an ordinary name', () => {
    expect(isSafeProfileName('cohabit')).toBe(true)
    expect(isSafeProfileName('Profile 10')).toBe(true)
    expect(isSafeProfileName('a/b')).toBe(false)
    expect(isSafeProfileName('..')).toBe(false)
  })
})

describe('containment is checked by path segment, not by string prefix', () => {
  it('allows a SIBLING of Chrome\'s directory whose name merely starts the same way', () => {
    // A bare startsWith wrongly refused ".../Google/Chrome-automation",
    // because it starts with ".../Google/Chrome".
    const result = clone({ root: `${HOME}/Library/Application Support/Google/Chrome-automation` })

    expect(result.exitCode).toBe(0)
  })
})

describe('--force replaces rather than merges', () => {
  it('removes the destination profile first, so no stale files survive the re-clone', () => {
    // `cp -r` overwrites what it copies and leaves everything else, so a
    // merged profile is half one snapshot and half another.
    const removed: string[] = []
    const result = clone({
      pathExists: () => true,
      force: true,
      removeDirectory: (path) => removed.push(path),
    })

    expect(result.exitCode).toBe(0)
    expect(removed).toEqual([`${HOME}/chrome-profiles/cohabit/Default`])
  })

  it('does not remove anything when not forced', () => {
    const removed: string[] = []
    clone({ removeDirectory: (path) => removed.push(path) })

    expect(removed).toEqual([])
  })
})

describe('a copy that fails is reported, not swallowed', () => {
  it('reports the underlying error rather than claiming success', () => {
    const result = clone({
      copyProfile: () => {
        throw new Error('EACCES: permission denied')
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('EACCES')
  })
})
