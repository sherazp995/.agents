import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CONFIG_MARKER, resolveMigrationsDirectory, resolveRelayHome } from '../../src/config/paths.js'

/**
 * Before this existed every default path was relative, so `relay doctor` run
 * anywhere but the repository root reported "config/relay.config.yaml: file
 * could not be read" and told the operator to fix a path that, from where
 * they were standing, did not exist. Fine for a project you develop in;
 * fatal for one you install.
 */

describe('resolveRelayHome', () => {
  it('honours RELAY_HOME above everything else', () => {
    const home = resolveRelayHome({
      env: { RELAY_HOME: '/opt/relay-a' },
      cwd: '/somewhere/with/config',
      home: '/Users/op',
      pathExists: () => true,
    })

    expect(home.path).toBe('/opt/relay-a')
    expect(home.source).toBe('RELAY_HOME')
  })

  it('resolves a relative RELAY_HOME against the working directory rather than leaving it relative', () => {
    const home = resolveRelayHome({ env: { RELAY_HOME: 'installs/one' }, cwd: '/work', home: '/Users/op', pathExists: () => false })

    expect(home.path).toBe('/work/installs/one')
  })

  it('uses the current directory when the CONFIG is actually there', () => {
    // Judged by the config file's presence, not by a directory name: the
    // question is "is the configuration here", and nothing else answers it.
    const home = resolveRelayHome({
      env: {},
      cwd: '/checkout',
      home: '/Users/op',
      pathExists: (path) => path === join('/checkout', CONFIG_MARKER),
    })

    expect(home.path).toBe('/checkout')
    expect(home.source).toBe('current directory')
  })

  it('PREFERS the current directory over the home directory, so a checkout is never shadowed', () => {
    // The failure this prevents: developing inside a checkout while silently
    // reading an unrelated installed copy's configuration.
    const home = resolveRelayHome({
      env: {},
      cwd: '/checkout',
      home: '/Users/op',
      pathExists: (path) => path.startsWith('/checkout') || path.startsWith('/Users/op/.relay'),
    })

    expect(home.path).toBe('/checkout')
  })

  it('falls back to ~/.relay, which is where an installed copy lives', () => {
    const home = resolveRelayHome({ env: {}, cwd: '/anywhere', home: '/Users/op', pathExists: () => false })

    expect(home.path).toBe('/Users/op/.relay')
    expect(home.source).toBe('home directory')
  })

  it('ignores an empty RELAY_HOME rather than resolving to nothing', () => {
    const home = resolveRelayHome({ env: { RELAY_HOME: '   ' }, cwd: '/anywhere', home: '/Users/op', pathExists: () => false })

    expect(home.source).toBe('home directory')
  })

  it('names which rule chose the path, so doctor can say where it looked', () => {
    // A message that says only "fix this path" gives the operator no way to
    // know Relay CHOSE that path rather than being told it.
    expect(resolveRelayHome({ env: {}, cwd: '/x', home: '/h', pathExists: () => false }).source).toBe('home directory')
  })
})

describe('resolveMigrationsDirectory', () => {
  it('finds the migrations that actually shipped with this build', () => {
    // Not relative to the working directory: migrations ship WITH the code,
    // and a set that moved with the cwd would mean the schema applied
    // depended on where the command was typed.
    const directory = resolveMigrationsDirectory()

    expect(existsSync(join(directory, '0001_init.sql'))).toBe(true)
  })

  it('THROWS rather than returning a path that does not exist', () => {
    // A migration runner pointed at a missing directory applies nothing and
    // reports success, which reads exactly like "already up to date" while
    // the schema is never created. Failing loudly is the only safe answer.
    expect(() => resolveMigrationsDirectory(() => false)).toThrow(/incomplete/)
  })
})
