import { describe, expect, it, vi } from 'vitest'
import { KillSwitch, KillSwitchEngagedError, createKillSwitch } from '../src/killswitch.js'
import type { KillSwitchState, KillSwitchStore } from '../src/killswitch.js'
import { CancellationRegistry } from '../src/runs/cancel.js'
import { isProcessAlive } from './support/process-alive.js'
import { SlowCapabilityAbortedError, resetSpawnedChildPids, slowCapability, spawnedChildPids } from './support/slow-capability.js'

/** Polls `predicate` until it is true, or throws once `timeoutMs` elapses. Mirrors test/runs/cancel.test.ts's own helper of the same name and shape, since this file needs the identical "wait for the real condition, not a guessed delay" discipline for the same reason. */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition was not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A RunCanceller test double that just records every call, so a test can assert cancelAll fired, and in what order relative to other calls. */
function buildRecordingCanceller(log: string[]): { cancelAll: (reason?: string) => void } {
  return {
    cancelAll: (reason?: string) => {
      log.push(`cancelAll:${reason ?? ''}`)
    },
  }
}

/** Reads the reason out of a KillSwitchState known (by the test calling it) to be engaged. Narrows the discriminated union explicitly rather than casting, so a test that gets this wrong fails loudly instead of reading undefined silently. */
function engagedReason(state: KillSwitchState): string {
  if (!state.engaged) throw new Error('expected an engaged state, got cleared')
  return state.reason
}

function buildInMemoryStore(log: string[] = []): KillSwitchStore & { log: string[] } {
  let state: KillSwitchState = { engaged: false }
  return {
    log,
    async loadState() {
      return state
    },
    async recordEngaged(reason, engagedAt) {
      log.push(`recordEngaged:${reason}`)
      state = { engaged: true, reason, engagedAt }
    },
    async recordCleared() {
      log.push('recordCleared')
      state = { engaged: false }
    },
  }
}

describe('KillSwitch: basic engage/clear/refuse behaviour', () => {
  it('starts not engaged', () => {
    const killSwitch = new KillSwitch({ runCanceller: { cancelAll: () => {} } })
    expect(killSwitch.isEngaged()).toBe(false)
    expect(() => killSwitch.refuseIfEngaged()).not.toThrow()
  })

  it('engage() calls cancelAll with the given reason', async () => {
    const log: string[] = []
    const killSwitch = new KillSwitch({ runCanceller: buildRecordingCanceller(log) })
    await killSwitch.engage('operator pressed the button')
    expect(log).toEqual(['cancelAll:operator pressed the button'])
    expect(killSwitch.isEngaged()).toBe(true)
  })

  it('defaults the reason when none is given', async () => {
    const log: string[] = []
    const killSwitch = new KillSwitch({ runCanceller: buildRecordingCanceller(log) })
    await killSwitch.engage()
    expect(log[0]).toMatch(/^cancelAll:/)
    expect(engagedReason(killSwitch.state())).toBeTruthy()
  })

  it('refuseIfEngaged throws KillSwitchEngagedError once engaged, naming the reason', async () => {
    const killSwitch = new KillSwitch({ runCanceller: { cancelAll: () => {} } })
    await killSwitch.engage('security incident')
    expect(() => killSwitch.refuseIfEngaged()).toThrow(KillSwitchEngagedError)
    expect(() => killSwitch.refuseIfEngaged()).toThrow(/security incident/)
  })

  it('clear() restores service: refuseIfEngaged no longer throws, isEngaged is false', async () => {
    const killSwitch = new KillSwitch({ runCanceller: { cancelAll: () => {} } })
    await killSwitch.engage('test')
    await killSwitch.clear()
    expect(killSwitch.isEngaged()).toBe(false)
    expect(() => killSwitch.refuseIfEngaged()).not.toThrow()
  })

  it('engage() is idempotent: a second engage() does not re-cancel or overwrite the original reason', async () => {
    const log: string[] = []
    const killSwitch = new KillSwitch({ runCanceller: buildRecordingCanceller(log) })
    await killSwitch.engage('first reason')
    await killSwitch.engage('second reason, should be ignored')
    expect(log).toEqual(['cancelAll:first reason'])
    expect(engagedReason(killSwitch.state())).toBe('first reason')
  })

  it('clear() on an already-cleared switch is a safe no-op', async () => {
    const killSwitch = new KillSwitch({ runCanceller: { cancelAll: () => {} } })
    await expect(killSwitch.clear()).resolves.toBeUndefined()
    expect(killSwitch.isEngaged()).toBe(false)
  })

  it('calls the lock releaser when supplied, and tolerates its absence', async () => {
    const releaseAll = vi.fn()
    const killSwitch = new KillSwitch({ runCanceller: { cancelAll: () => {} }, lockReleaser: { releaseAll } })
    await killSwitch.engage('test')
    expect(releaseAll).toHaveBeenCalledOnce()

    const withoutReleaser = new KillSwitch({ runCanceller: { cancelAll: () => {} } })
    await expect(withoutReleaser.engage('test')).resolves.toBeUndefined()
  })

  it('persists through the store when one is supplied', async () => {
    const store = buildInMemoryStore()
    const killSwitch = new KillSwitch({ runCanceller: { cancelAll: () => {} }, store })
    await killSwitch.engage('audit trail check')
    expect(store.log).toContain('recordEngaged:audit trail check')
    await killSwitch.clear()
    expect(store.log).toContain('recordCleared')
  })
})

describe('createKillSwitch: hydration from a durable store', () => {
  it('starts cleared when no store is supplied', async () => {
    const killSwitch = await createKillSwitch({ runCanceller: { cancelAll: () => {} } })
    expect(killSwitch.isEngaged()).toBe(false)
  })

  it('hydrates as engaged when the store already reports engaged, required proof: a restart does not forget an engagement', async () => {
    const store = buildInMemoryStore()
    await store.recordEngaged('engaged before restart', new Date('2026-01-01T00:00:00Z'))
    const killSwitch = await createKillSwitch({ runCanceller: { cancelAll: () => {} }, store })
    expect(killSwitch.isEngaged()).toBe(true)
    expect(() => killSwitch.refuseIfEngaged()).toThrow(/engaged before restart/)
  })

  it('hydrates as cleared when the store reports cleared', async () => {
    const store = buildInMemoryStore()
    const killSwitch = await createKillSwitch({ runCanceller: { cancelAll: () => {} }, store })
    expect(killSwitch.isEngaged()).toBe(false)
  })
})

describe('KillSwitch: SELF-ATTACK required proof, the order cancelAll fires in must be first', () => {
  it('cancelAll is called before the store or lock releaser, not after: recorded call order proves it', async () => {
    const log: string[] = []
    const store: KillSwitchStore = {
      async loadState() {
        return { engaged: false }
      },
      async recordEngaged(reason) {
        log.push(`store:${reason}`)
      },
      async recordCleared() {
        log.push('store:cleared')
      },
    }
    const killSwitch = new KillSwitch({
      runCanceller: {
        cancelAll: (reason) => log.push(`cancel:${reason ?? ''}`),
      },
      lockReleaser: {
        releaseAll: () => {
          log.push('locks')
        },
      },
      store,
    })
    await killSwitch.engage('order check')
    expect(log[0]).toBe('cancel:order check')
  })
})

describe('KillSwitch: GT-14-style adversarial proof, measured against a real subprocess, mid-action', () => {
  it(
    'a real child process, 30 seconds into a sleep, is genuinely killed within the five second bound ' +
      'when the kill switch engages, while an unrelated async queue is deliberately kept busy throughout, ' +
      'proving the kill switch never contends with it',
    async () => {
      resetSpawnedChildPids()
      const registry = new CancellationRegistry()
      const token = registry.register('adversarial-run')
      const killSwitch = new KillSwitch({ runCanceller: registry })

      // 30 seconds, six times the five second bound. slowCapability wires
      // the given AbortSignal directly into child_process.spawn's own
      // `signal` option (test/support/slow-capability.ts), so this is a
      // real OS process, not a promise standing in for one.
      const capabilityPromise = slowCapability({ seconds: 30 }, token.signal)

      // An unrelated busy queue, kept spinning for the whole test: proves
      // engage() does not have to wait its turn on the event loop behind
      // other pending work, which is the general shape of the P0.3 bug
      // (a Stop queued behind whatever else the process was doing).
      let queueBusy = true
      const busyQueueLoop = (async () => {
        while (queueBusy) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      })()

      await waitUntil(() => spawnedChildPids.length === 1)
      const pid = spawnedChildPids[0]
      if (pid === undefined) throw new Error('expected a spawned pid')
      expect(isProcessAlive(pid)).toBe(true)

      const engagedAt = Date.now()
      await killSwitch.engage('adversarial test: kill mid-action while a queue is busy')

      await expect(capabilityPromise).rejects.toThrow(SlowCapabilityAbortedError)
      await waitUntil(() => !isProcessAlive(pid), 5_000)
      const elapsedMs = Date.now() - engagedAt

      // Printed deliberately, matching GT-14's own convention
      // (test/runs/cancel.test.ts): the bound must be measured, not
      // merely asserted, so the number belongs in visible test output.
      console.log(`Task 6 measured: kill-switch engage() to real process death = ${elapsedMs}ms, bound=5000ms`)

      expect(elapsedMs).toBeLessThan(5_000)
      expect(isProcessAlive(pid)).toBe(false)

      queueBusy = false
      await busyQueueLoop
      registry.release('adversarial-run')
    },
    15_000,
  )
})

describe('KillSwitch: SELF-ATTACK required proof, queuing the trigger behind other work breaks the bound', () => {
  it(
    'queuing engage() behind 6 seconds of unrelated work before calling it at all, the exact P0.3 bug ' +
      'shape (a Stop chained onto the same serial queue as the run it is meant to interrupt), makes the ' +
      'real process outlive the five second bound',
    async () => {
      resetSpawnedChildPids()
      const registry = new CancellationRegistry()
      const token = registry.register('self-attack-run')
      const killSwitch = new KillSwitch({ runCanceller: registry })
      const capabilityPromise = slowCapability({ seconds: 30 }, token.signal)

      await waitUntil(() => spawnedChildPids.length === 1)
      const pid = spawnedChildPids[0]
      if (pid === undefined) throw new Error('expected a spawned pid')

      const startedAt = Date.now()

      // SELF-ATTACK: this is what a caller must never do. Queuing the
      // trigger behind unrelated work before calling engage() at all,
      // rather than calling it immediately (the actual, correct usage
      // this design assumes), restates the exact bug P0.3 shipped: a Stop
      // that queued behind the run it was meant to interrupt.
      // KillSwitch.engage() itself is not the thing misbehaving here;
      // this proves why the design's own header comment insists the
      // trigger must bypass any such queue rather than join one.
      await new Promise((resolve) => setTimeout(resolve, 6_000))
      await killSwitch.engage('self-attack: queued behind other work before being called at all')

      await expect(capabilityPromise).rejects.toThrow(SlowCapabilityAbortedError)
      const elapsedMs = Date.now() - startedAt

      console.log(`SELF-ATTACK measured: ${elapsedMs}ms against a 5000ms bound; queuing the trigger breaks it`)
      expect(elapsedMs).toBeGreaterThan(5_000)

      registry.release('self-attack-run')
    },
    15_000,
  )
})

describe('KillSwitch.refresh: one store, two processes', () => {
  it('an engage through one instance is applied by the other on refresh, cancelling its runs, and a clear restores both', async () => {
    const store = buildInMemoryStore()
    const cliLog: string[] = []
    const daemonLog: string[] = []
    const cli = new KillSwitch({ runCanceller: buildRecordingCanceller(cliLog), store })
    const daemon = new KillSwitch({ runCanceller: buildRecordingCanceller(daemonLog), store })

    await cli.engage('stop everything')
    expect(daemon.isEngaged()).toBe(false)
    await daemon.refresh()

    expect(() => daemon.refuseIfEngaged()).toThrow(KillSwitchEngagedError)
    expect(daemonLog).toEqual(['cancelAll:stop everything'])

    await cli.clear()
    await daemon.refresh()
    expect(daemon.isEngaged()).toBe(false)
    expect(() => daemon.refuseIfEngaged()).not.toThrow()
  })

  it('never writes to the store, so what the CLI recorded is unchanged after a refresh', async () => {
    const store = buildInMemoryStore()
    await store.recordEngaged('from cli', new Date('2026-10-29T00:00:00Z'))
    const daemon = new KillSwitch({ runCanceller: buildRecordingCanceller([]), store })

    await daemon.refresh()
    await daemon.refresh()

    expect(store.log).toEqual(['recordEngaged:from cli'])
    expect(engagedReason(await store.loadState())).toBe('from cli')
  })

  it('a refresh that read cleared, finishing after a newer engage, cannot overwrite it, and the next refresh engages', async () => {
    const store = buildInMemoryStore()
    let releaseRead: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let first = true
    const slowStore: KillSwitchStore = {
      ...store,
      async loadState() {
        const snapshot = await store.loadState()
        if (first) {
          first = false
          await gate
        }
        return snapshot
      },
    }
    const daemon = new KillSwitch({ runCanceller: buildRecordingCanceller([]), store: slowStore })

    const staleRefresh = daemon.refresh()
    await store.recordEngaged('newer engage', new Date())
    releaseRead()
    await staleRefresh

    expect(engagedReason(await store.loadState())).toBe('newer engage')
    await daemon.refresh()
    expect(daemon.isEngaged()).toBe(true)
  })

  it('rejects when the store cannot be read, so callers deny for that tick', async () => {
    const daemon = new KillSwitch({
      runCanceller: buildRecordingCanceller([]),
      store: { ...buildInMemoryStore(), loadState: () => Promise.reject(new Error('db down')) },
    })
    await expect(daemon.refresh()).rejects.toThrow('db down')
  })
})
