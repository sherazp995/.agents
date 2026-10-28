import { describe, expect, it } from 'vitest'
import {
  IllegalTransitionError,
  countTrailingIdenticalSteps,
  isTerminalRunState,
  isTerminalStepState,
  transitionRun,
  transitionStep,
} from '../../src/runs/state.js'
import type { RunState, StepState } from '../../src/runs/state.js'

describe('transitionRun', () => {
  it('walks queued -> running -> succeeded', () => {
    expect(transitionRun('queued', 'start')).toBe('running')
    expect(transitionRun('running', 'succeed')).toBe('succeeded')
  })

  it('walks running -> failed', () => {
    expect(transitionRun('running', 'fail')).toBe('failed')
  })

  it('allows cancel from queued or running', () => {
    expect(transitionRun('queued', 'cancel')).toBe('cancelled')
    expect(transitionRun('running', 'cancel')).toBe('cancelled')
  })

  it('allows dead_letter only from running', () => {
    expect(transitionRun('running', 'dead_letter')).toBe('dead_letter')
    expect(() => transitionRun('queued', 'dead_letter')).toThrow(IllegalTransitionError)
  })

  it.each(['succeeded', 'failed', 'cancelled', 'dead_letter'] as const)(
    'refuses every event from the terminal state %s',
    (state: RunState) => {
      for (const event of ['start', 'succeed', 'fail', 'cancel', 'dead_letter'] as const) {
        expect(() => transitionRun(state, event)).toThrow(IllegalTransitionError)
      }
    },
  )

  it('refuses succeed directly from queued: a run must start before it can finish', () => {
    expect(() => transitionRun('queued', 'succeed')).toThrow(IllegalTransitionError)
  })

  it.each(['succeeded', 'failed', 'cancelled', 'dead_letter'] as const)(
    'marks %s as terminal',
    (state: RunState) => {
      expect(isTerminalRunState(state)).toBe(true)
    },
  )

  it.each(['queued', 'running'] as const)('marks %s as non-terminal', (state: RunState) => {
    expect(isTerminalRunState(state)).toBe(false)
  })
})

describe('transitionStep', () => {
  it('walks pending -> running -> succeeded', () => {
    expect(transitionStep('pending', 'start')).toBe('running')
    expect(transitionStep('running', 'succeed')).toBe('succeeded')
  })

  it('walks running -> timed_out on a timeout event, per FR-ORC-8', () => {
    expect(transitionStep('running', 'timeout')).toBe('timed_out')
  })

  it('refuses a timeout event from pending: nothing times out before it starts', () => {
    expect(() => transitionStep('pending', 'timeout')).toThrow(IllegalTransitionError)
  })

  it('allows cancel from pending or running', () => {
    expect(transitionStep('pending', 'cancel')).toBe('cancelled')
    expect(transitionStep('running', 'cancel')).toBe('cancelled')
  })

  it.each(['succeeded', 'failed', 'timed_out', 'cancelled'] as const)(
    'refuses every event from the terminal state %s',
    (state: StepState) => {
      for (const event of ['start', 'succeed', 'fail', 'timeout', 'cancel'] as const) {
        expect(() => transitionStep(state, event)).toThrow(IllegalTransitionError)
      }
    },
  )

  it.each(['succeeded', 'failed', 'timed_out', 'cancelled'] as const)(
    'marks %s as terminal',
    (state: StepState) => {
      expect(isTerminalStepState(state)).toBe(true)
    },
  )
})

describe('countTrailingIdenticalSteps', () => {
  it('returns 0 for zero or one steps: nothing to compare yet', () => {
    expect(countTrailingIdenticalSteps([])).toBe(0)
    expect(countTrailingIdenticalSteps([{ capability: 'echo', input: 'a' }])).toBe(0)
  })

  it('counts a run of identical trailing steps by capability and input', () => {
    const steps = [
      { capability: 'echo', input: 'a' },
      { capability: 'echo', input: 'a' },
      { capability: 'echo', input: 'a' },
    ]
    expect(countTrailingIdenticalSteps(steps)).toBe(3)
  })

  it('stops counting at the first divergence, walking from the end backwards', () => {
    const steps = [
      { capability: 'echo', input: 'a' },
      { capability: 'echo', input: 'b' },
      { capability: 'echo', input: 'b' },
    ]
    // The oldest step ("a") differs from the trailing run of "b"s, so it
    // must not inflate the count: only the two "b"s trail.
    expect(countTrailingIdenticalSteps(steps)).toBe(2)
  })

  it('treats a different capability with the same input as non-identical', () => {
    const steps = [
      { capability: 'echo', input: 'a' },
      { capability: 'other', input: 'a' },
    ]
    expect(countTrailingIdenticalSteps(steps)).toBe(1)
  })

  it('compares input by deep JSON equality, not by reference', () => {
    const steps = [
      { capability: 'echo', input: { nested: [1, 2, 3] } },
      { capability: 'echo', input: { nested: [1, 2, 3] } },
    ]
    expect(countTrailingIdenticalSteps(steps)).toBe(2)
  })

  it('is not fooled by key order: two objects with the same keys in a different order compare unequal', () => {
    // Documented as a deliberate limitation in state.ts: this comparison is
    // blunt on purpose, since it backs a blunt backstop (loop protection),
    // not a semantic equality judge.
    const steps = [
      { capability: 'echo', input: { a: 1, b: 2 } },
      { capability: 'echo', input: { b: 2, a: 1 } },
    ]
    expect(countTrailingIdenticalSteps(steps)).toBe(1)
  })
})
