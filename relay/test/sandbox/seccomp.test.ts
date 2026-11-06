import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SUPPORTED_FILTER_ARCHES, unixSocketFilter } from '../../src/sandbox/seccomp.js'

/**
 * The filter is a security boundary written as raw BPF, so its bytes are
 * pinned to a listing checked by hand, and then the kernel is asked whether
 * it really refuses what the listing says.
 */

/** struct sock_filter rows: [code, jt, jf, k]. */
function rows(buffer: Buffer): number[][] {
  const out: number[][] = []
  for (let at = 0; at < buffer.length; at += 8) {
    out.push([buffer.readUInt16LE(at), buffer.readUInt8(at + 2), buffer.readUInt8(at + 3), buffer.readUInt32LE(at + 4)])
  }
  return out
}

describe('unixSocketFilter, the program bytes', () => {
  it('matches the checked x86_64 listing, including the x32 kill', () => {
    expect(rows(unixSocketFilter('x64')!)).toEqual([
      [0x20, 0, 0, 4], // load arch
      [0x15, 0, 8, 0xc000003e], // not x86_64: kill
      [0x20, 0, 0, 0], // load nr
      [0x35, 6, 0, 0x40000000], // x32 call: kill
      [0x15, 4, 0, 425], // io_uring_setup: deny
      [0x15, 0, 2, 41], // not socket(): allow
      [0x20, 0, 0, 16], // load domain (low 32 bits)
      [0x15, 1, 0, 1], // AF_UNIX: deny, else allow
      [0x06, 0, 0, 0x7fff0000], // allow
      [0x06, 0, 0, 0x00050001], // EPERM
      [0x06, 0, 0, 0x80000000], // kill process
    ])
  })

  it('matches the checked arm64 listing, which has no x32 table', () => {
    expect(rows(unixSocketFilter('arm64')!)).toEqual([
      [0x20, 0, 0, 4],
      [0x15, 0, 7, 0xc00000b7],
      [0x20, 0, 0, 0],
      [0x15, 4, 0, 425],
      [0x15, 0, 2, 198],
      [0x20, 0, 0, 16],
      [0x15, 1, 0, 1],
      [0x06, 0, 0, 0x7fff0000],
      [0x06, 0, 0, 0x00050001],
      [0x06, 0, 0, 0x80000000],
    ])
  })

  it('has no program for an architecture it was not written for', () => {
    expect(unixSocketFilter('ia32')).toBeUndefined()
    expect(SUPPORTED_FILTER_ARCHES).toEqual(['x64', 'arm64'])
  })
})

const BWRAP = '/usr/bin/bwrap'
const canRun =
  process.platform === 'linux' &&
  unixSocketFilter() !== undefined &&
  existsSync(BWRAP) &&
  spawnSync(BWRAP, ['--ro-bind', '/', '/', '--unshare-user', '--', '/bin/true']).status === 0
const describeIfBwrap = canRun ? describe : describe.skip

describeIfBwrap('unixSocketFilter, loaded by bwrap on this machine', () => {
  it('refuses a new Unix socket while socketpair and child processes still work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-seccomp-'))
    const filter = join(dir, 'filter.bpf')
    writeFileSync(filter, unixSocketFilter()!)
    const probe = [
      "const net = require('node:net'), cp = require('node:child_process')",
      "const s = net.connect('/run/relay-seccomp-test-nonexistent.sock')",
      "s.on('error', (e) => { console.log('unix:' + e.code); console.log(cp.execFileSync('/bin/echo', ['child-ok']).toString().trim()) })",
    ].join('\n')
    try {
      const result = spawnSync(
        '/bin/sh',
        ['-c', 'exec 9<"$0" && exec "$@"', filter, BWRAP, '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
          '--unshare-user', '--unshare-pid', '--die-with-parent', '--seccomp', '9', '--', process.execPath, '-e', probe],
        { encoding: 'utf8', timeout: 20_000 },
      )
      // EPERM, not ENOENT: the socket is refused before any path is looked up.
      expect(result.stdout).toContain('unix:EPERM')
      expect(result.stdout).toContain('child-ok')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
