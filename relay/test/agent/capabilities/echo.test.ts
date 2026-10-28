import { describe, expect, it } from 'vitest'
import { ECHO_CAPABILITY_NAME, echo } from '../../../src/agent/capabilities/echo.js'

describe('echo', () => {
  it('returns whatever it was given, unchanged', async () => {
    await expect(echo('hello', new AbortController().signal)).resolves.toBe('hello')
  })

  it('round-trips a non-primitive payload by reference, since it never copies or inspects it', async () => {
    const payload = { nested: [1, 2, 3] }
    await expect(echo(payload, new AbortController().signal)).resolves.toBe(payload)
  })

  it('round-trips null and undefined without substituting a default', async () => {
    await expect(echo(null, new AbortController().signal)).resolves.toBeNull()
    await expect(echo(undefined, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('exposes the capability name the loop\'s capability map registers it under', () => {
    expect(ECHO_CAPABILITY_NAME).toBe('echo')
  })
})
