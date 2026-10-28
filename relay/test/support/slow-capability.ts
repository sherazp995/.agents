/**
 * Two deliberately slow capabilities, for src/runs/cancel.test.ts's GT-14
 * proof only. Neither is registered as a production capability: the Task 6
 * brief ships exactly one real capability, src/agent/capabilities/echo.ts,
 * and these exist purely to be far slower than the five second cancellation
 * bound so a test can prove that bound against something that would
 * otherwise run much longer, per FR-ORC-4.
 *
 * Two, not one, because they exercise two DIFFERENT mechanisms that both
 * happen to produce the same observable bound, and the self-attack in this
 * task's report only breaks one of them:
 *
 *   - `obliviousSlowCapability` never looks at the AbortSignal it is given
 *     at all, the worst case Capability's own doc comment in
 *     src/agent/loop.ts anticipates ("a well-behaved capability should
 *     check it, but the loop's own timeout race... makes the timeout
 *     binding even if the capability itself never looks at the signal").
 *     The ONLY thing that can make a run using this capability stop within
 *     five seconds is src/agent/loop.ts's own runCapability racing the
 *     capability's promise against the signal and abandoning it. This is
 *     what src/runs/cancel.test.ts's required timing test uses, and it is
 *     the one the self-attack (removing that race) breaks.
 *   - `slowCapability` mirrors runClaudeEngine's own pattern exactly:
 *     it wires the given AbortSignal directly into child_process.spawn's
 *     `signal` option, so cancellation genuinely kills a real OS process.
 *     Removing runCapability's race would NOT break this one, because the
 *     capability cooperates on its own; it exists to prove the "no leaked
 *     child process" requirement against a real subprocess, not to be the
 *     self-attack's target.
 */

import { spawn } from 'node:child_process'
import type { Capability } from '../../src/agent/loop.js'

export type SlowCapabilityInput = { readonly seconds: number }

/**
 * A side channel, not part of `input`. `input` round-trips through the
 * engine's JSON response and through src/runs/store.ts's persisted jsonb
 * column, both of which would silently drop a function reference or a pid
 * captured only in a closure. Recording every real pid slowCapability
 * spawns here, module-scope, lets a test observe the actual OS process id
 * without needing either round trip to carry it. Call
 * resetSpawnedChildPids() between tests that share this module.
 */
export const spawnedChildPids: number[] = []

export function resetSpawnedChildPids(): void {
  spawnedChildPids.length = 0
}

export class SlowCapabilityAbortedError extends Error {
  constructor(detail: string) {
    super(`slowCapability was aborted before its sleep finished: ${detail}`)
    this.name = 'SlowCapabilityAbortedError'
  }
}

function isSlowCapabilityInput(input: unknown): input is SlowCapabilityInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'seconds' in input &&
    typeof (input as { seconds: unknown }).seconds === 'number'
  )
}

/**
 * input: `{ seconds: number }`. Never inspects `signal`: represents a
 * capability author who did not wire cancellation at all. Its internal
 * timer is created with `.unref()`, so it never keeps the Vitest worker
 * process alive on its own; it is genuinely abandoned in the background
 * exactly the way src/agent/loop.ts's runCapability comment describes, and
 * naturally stops mattering once the process running it exits, rather than
 * needing anyone to clean it up. This is the honest shape of "termination,
 * not cooperation" applied to a capability rather than the engine: nothing
 * about calling cancel() makes this timer fire any sooner, only the loop
 * moving on regardless of it.
 */
export const obliviousSlowCapability: Capability = (input) =>
  new Promise((resolve, reject) => {
    if (!isSlowCapabilityInput(input)) {
      reject(new Error('obliviousSlowCapability requires input shaped { seconds: number }'))
      return
    }
    const timer = setTimeout(() => resolve({ slept: input.seconds }), input.seconds * 1000)
    timer.unref()
  })

/** input: `{ seconds: number }`. Resolves `{ slept: seconds, exitCode }` if the sleep runs to completion, which a well-behaved test must never actually wait for. */
export const slowCapability: Capability = (input, signal) =>
  new Promise((resolve, reject) => {
    if (!isSlowCapabilityInput(input)) {
      reject(new Error('slowCapability requires input shaped { seconds: number }'))
      return
    }

    const child = spawn('sleep', [String(input.seconds)], { stdio: 'ignore', signal })
    if (typeof child.pid === 'number') spawnedChildPids.push(child.pid)

    child.on('error', (error: Error) => {
      if (signal.aborted) {
        reject(new SlowCapabilityAbortedError(error.message))
        return
      }
      reject(error)
    })

    child.on('close', (code: number | null) => {
      if (signal.aborted) {
        reject(new SlowCapabilityAbortedError(`process closed with exit code ${String(code)}`))
        return
      }
      resolve({ slept: input.seconds, exitCode: code })
    })
  })
