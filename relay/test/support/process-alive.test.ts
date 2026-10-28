import { describe, expect, it } from 'vitest'
import { isProcessAlive } from './process-alive.js'

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('returns true for a live process owned by another user (EPERM), not just ESRCH', () => {
    // pid 1 is launchd, owned by root. Signalling it from an unprivileged
    // user raises EPERM, not ESRCH: the process is alive, this user is just
    // not allowed to signal it. Before the fix, the bare catch collapsed
    // that into "dead", which is exactly the bug this test guards against.
    expect(isProcessAlive(1)).toBe(true)
  })

  it('returns false for a pid that does not exist (ESRCH)', () => {
    expect(isProcessAlive(999999)).toBe(false)
  })
})
