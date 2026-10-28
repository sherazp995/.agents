import { describe, expect, it } from 'vitest'
import { wrapUntrusted } from '../../src/agent/untrusted.js'
import type { AdapterCapabilities, ChatAction, ChatEvent, ChatRef } from '../../src/chat/contract.js'
import { describeCapabilities, sessionRefFor } from '../../src/chat/contract.js'

// --- Type level assertions --------------------------------------------------
//
// These assignments exist to be checked by tsc, not to run. `pnpm typecheck`
// is what proves each one is still a compile error. If a future edit loosens
// any of the types below, the matching @ts-expect-error stops matching a
// real error and becomes an unused directive error itself, which fails
// typecheck rather than letting the loosened type pass silently. A reviewer
// verifies this by loosening a type and confirming typecheck then fails.

// An edit action must carry a message in its ref, because it is editing a
// message a prior post produced and there is nothing to edit without one.
// @ts-expect-error edit requires ref.message: ChatAction's edit member intersects ChatRef with Required<Pick<ChatRef, 'channel' | 'message'>>.
const _editWithoutMessage: ChatAction = {
  kind: 'edit',
  ref: { channel: 'C1' },
  text: 'updated',
}

// raw carries the platform payload for audit and must be present on every
// event, never optional, so a producer cannot forget to retain it.
// @ts-expect-error ChatEvent requires raw even when every other field is present.
const _eventWithoutRaw: ChatEvent = {
  kind: 'message',
  adapter: 'slack',
  workspaceId: '00000000-0000-4000-8000-000000000001',
  platformTeamId: 'T1',
  principalId: null,
  ref: { channel: 'C1' },
  text: wrapUntrusted('hello'),
  files: [],
  receivedAt: '2026-08-08T00:00:00.000Z',
}

// text carries the message a real person typed: outside content exactly as
// much as raw, and exactly the field an agent loop reaches for as "what the
// user said". A bare string must not satisfy it, or the wrapper protects
// the audit-only field while leaving the one a prompt actually uses wide
// open. See src/agent/untrusted.ts and src/chat/contract.ts's ChatEvent doc
// comment. The directive sits on the `text` line itself, not the
// declaration line above, because tsc reports a wrong-type-for-an-existing-
// property error at that property's own line, not at the object literal's
// opening brace.
const _eventWithBareText: ChatEvent = {
  kind: 'message',
  adapter: 'slack',
  workspaceId: '00000000-0000-4000-8000-000000000001',
  platformTeamId: 'T1',
  principalId: null,
  ref: { channel: 'C1' },
  // @ts-expect-error ChatEvent.text must be Untrusted<string>, not a bare string.
  text: 'hello',
  files: [],
  raw: wrapUntrusted({}),
  receivedAt: '2026-08-08T00:00:00.000Z',
}

// Every capability flag is required so an adapter cannot silently omit one
// and have callers treat the missing flag as falsy by accident.
// @ts-expect-error AdapterCapabilities requires maxMessageBytes.
const _capsMissingField: AdapterCapabilities = {
  buttons: true,
  editMessage: true,
  fileUpload: true,
  modals: true,
  threads: true,
}

function buildEvent(ref: ChatRef): ChatEvent {
  return {
    kind: 'message',
    adapter: 'slack',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    platformTeamId: 'T1',
    principalId: null,
    ref,
    text: wrapUntrusted('hello'),
    files: [],
    raw: wrapUntrusted({}),
    receivedAt: '2026-08-08T00:00:00.000Z',
    mentionsBot: false,
    platformEventId: `${ref.channel}:${ref.message ?? 'none'}`,
  }
}

describe('sessionRefFor', () => {
  it('threads a fresh message onto itself: ref.thread becomes the message id, since a message with no thread yet must start one on itself per FR-SL-3', () => {
    const event = buildEvent({ channel: 'C1', message: '100.000001' })
    expect(sessionRefFor(event)).toEqual({ channel: 'C1', thread: '100.000001' })
  })

  it('continues an existing thread reply, keeping the original thread rather than the reply message itself', () => {
    const event = buildEvent({ channel: 'C1', thread: '100.000001', message: '100.000002' })
    expect(sessionRefFor(event)).toEqual({ channel: 'C1', thread: '100.000001' })
  })

  it('throws rather than silently returning an unthreaded ref when the event carries neither thread nor message', () => {
    const event = buildEvent({ channel: 'C1' })
    expect(() => sessionRefFor(event)).toThrow(/neither thread nor message/)
  })
})

describe('describeCapabilities', () => {
  it('summarises a degraded capability set so the reporter can state it', () => {
    const caps: AdapterCapabilities = {
      buttons: false,
      editMessage: true,
      fileUpload: true,
      modals: true,
      threads: true,
      maxMessageBytes: 40_000,
    }

    expect(describeCapabilities(caps)).toBe(
      'buttons: no, editMessage: yes, fileUpload: yes, modals: yes, threads: yes, maxMessageBytes: 40000',
    )
  })
})
