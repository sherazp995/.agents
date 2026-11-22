import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../../src/obs/logger.js'
import type { ShellPasswordPort } from '../../../src/shell/types.js'
import {
  handleShellPasswordButton,
  handleShellPasswordCancel,
  handleShellPasswordSubmission,
  SHELL_PASSWORD_ACTION_IDS,
  SHELL_PASSWORD_BLOCK_ID,
  SHELL_PASSWORD_CALLBACK_ID,
  SHELL_PASSWORD_GENERIC_ERROR,
  SHELL_PASSWORD_INPUT_ACTION_ID,
  shellReplyBlocks,
} from '../../../src/chat/slack/shell-password.js'
import type { ShellPasswordContext } from '../../../src/chat/slack/shell-password.js'
import type { SlackApiClient, SlackBlockActionEnvelope, SlackOpenModalArgs, SlackViewSubmissionEnvelope } from '../../../src/chat/slack/types.js'

const OWNER = 'UOWNER'
const REQUEST_ID = 'req-1'

type Calls = { canAnswer: unknown[]; submit: unknown[]; cancel: unknown[] }

function fakePort(overrides: Partial<ShellPasswordPort> = {}): { port: ShellPasswordPort; calls: Calls } {
  const calls: Calls = { canAnswer: [], submit: [], cancel: [] }
  const port: ShellPasswordPort = {
    canAnswer: async (request) => {
      calls.canAnswer.push(request)
      return overrides.canAnswer ? overrides.canAnswer(request) : true
    },
    submit: async (request) => {
      calls.submit.push(request)
      return overrides.submit ? overrides.submit(request) : 'accepted'
    },
    cancel: async (request) => {
      calls.cancel.push(request)
      return overrides.cancel ? overrides.cancel(request) : 'cancelled'
    },
  }
  return { port, calls }
}

/** A real pino logger at debug, writing into a string, so a test can search everything it logged. */
function capturingContext(port: ShellPasswordPort): { ctx: ShellPasswordContext; opened: SlackOpenModalArgs[]; logged: () => string } {
  let output = ''
  const destination = new Writable({
    write(chunk: unknown, _encoding, callback) {
      output += String(chunk)
      callback()
    },
  })
  const opened: SlackOpenModalArgs[] = []
  const apiClient = { openModal: async (args: SlackOpenModalArgs) => void opened.push(args) } as unknown as SlackApiClient
  return { ctx: { port, apiClient, log: createLogger('debug', destination) }, opened, logged: () => output }
}

function click(actionId: string, user = OWNER): SlackBlockActionEnvelope {
  return { actions: [{ action_id: actionId, type: 'button', value: REQUEST_ID }], user: { id: user }, trigger_id: 'trigger-1' }
}

function submission(password: string | null, user = OWNER): SlackViewSubmissionEnvelope {
  return {
    view: {
      callback_id: SHELL_PASSWORD_CALLBACK_ID,
      private_metadata: JSON.stringify({ requestId: REQUEST_ID }),
      state: { values: { [SHELL_PASSWORD_BLOCK_ID]: { [SHELL_PASSWORD_INPUT_ACTION_ID]: { value: password } } } },
    },
    user: { id: user },
  }
}

function inlineError(text: string): unknown {
  return { response_action: 'errors', errors: { [SHELL_PASSWORD_BLOCK_ID]: text } }
}

describe('shellReplyBlocks', () => {
  it('is only the markdown block when no password is waiting', () => {
    expect(shellReplyBlocks('`$ pwd`')).toEqual([{ type: 'markdown', text: '`$ pwd`' }])
  })

  it('adds Enter password and Cancel buttons carrying the request id', () => {
    const [markdown, actions] = shellReplyBlocks('`$ sudo true`', REQUEST_ID) as [unknown, { type: string; elements: Record<string, unknown>[] }]
    expect(markdown).toEqual({ type: 'markdown', text: '`$ sudo true`' })
    expect(actions.type).toBe('actions')
    expect(actions.elements.map((button) => [button.action_id, button.value, button.style])).toEqual([
      [SHELL_PASSWORD_ACTION_IDS.enter, REQUEST_ID, 'primary'],
      [SHELL_PASSWORD_ACTION_IDS.cancel, REQUEST_ID, undefined],
    ])
  })
})

describe('handleShellPasswordButton', () => {
  it('opens nothing for a user the port refuses', async () => {
    const { port, calls } = fakePort({ canAnswer: async () => false })
    const { ctx, opened } = capturingContext(port)

    await handleShellPasswordButton(ctx, click(SHELL_PASSWORD_ACTION_IDS.enter, 'UMEMBER'))

    expect(calls.canAnswer).toEqual([{ requestId: REQUEST_ID, platformUserId: 'UMEMBER' }])
    expect(opened).toEqual([])
  })

  it('opens the password popup with the request id in its metadata for an allowed user', async () => {
    const { port } = fakePort()
    const { ctx, opened } = capturingContext(port)

    await handleShellPasswordButton(ctx, click(SHELL_PASSWORD_ACTION_IDS.enter))

    expect(opened).toHaveLength(1)
    const view = opened[0]?.view as { callback_id: string; private_metadata: string; blocks: { block_id: string; element: Record<string, unknown> }[] }
    expect(opened[0]?.triggerId).toBe('trigger-1')
    expect(view.callback_id).toBe(SHELL_PASSWORD_CALLBACK_ID)
    expect(JSON.parse(view.private_metadata)).toEqual({ requestId: REQUEST_ID })
    expect(view.blocks[0]?.block_id).toBe(SHELL_PASSWORD_BLOCK_ID)
    expect(view.blocks[0]?.element).toMatchObject({ type: 'plain_text_input', action_id: SHELL_PASSWORD_INPUT_ACTION_ID, multiline: false })
  })

  it('opens nothing when no shell password handler is wired', async () => {
    const { ctx, opened, logged } = capturingContext(fakePort().port)

    await handleShellPasswordButton({ ...ctx, port: undefined }, click(SHELL_PASSWORD_ACTION_IDS.enter))

    expect(opened).toEqual([])
    expect(logged()).toContain('no shell password handler is wired')
  })
})

describe('handleShellPasswordCancel', () => {
  it('hands the click to the port', async () => {
    const { port, calls } = fakePort()
    const { ctx } = capturingContext(port)

    await handleShellPasswordCancel(ctx, click(SHELL_PASSWORD_ACTION_IDS.cancel))

    expect(calls.cancel).toEqual([{ requestId: REQUEST_ID, platformUserId: OWNER }])
  })
})

describe('handleShellPasswordSubmission', () => {
  it('closes the popup once the port accepts the password', async () => {
    const { port, calls } = fakePort()
    const { ctx } = capturingContext(port)

    expect(await handleShellPasswordSubmission(ctx, submission('hunter2'))).toBeUndefined()
    expect(calls.submit).toEqual([{ requestId: REQUEST_ID, platformUserId: OWNER, password: 'hunter2' }])
  })

  it.each([
    ['refused', 'Only the owner who ran this command can answer.'],
    ['expired', 'This password request has ended.'],
  ] as const)('keeps the popup open on its own field when the port answers %s', async (outcome, message) => {
    const { ctx } = capturingContext(fakePort({ submit: async () => outcome }).port)

    expect(await handleShellPasswordSubmission(ctx, submission('hunter2'))).toEqual(inlineError(message))
  })

  it('asks for the password without calling the port when the field is empty', async () => {
    const { port, calls } = fakePort()
    const { ctx } = capturingContext(port)

    expect(await handleShellPasswordSubmission(ctx, submission(''))).toEqual(inlineError('Type the password.'))
    expect(calls.submit).toEqual([])
  })

  it('gives the generic inline error when the port throws', async () => {
    const { ctx } = capturingContext(fakePort({ submit: async () => Promise.reject(new Error('socket closed')) }).port)

    expect(await handleShellPasswordSubmission(ctx, submission('hunter2'))).toEqual(inlineError(SHELL_PASSWORD_GENERIC_ERROR))
  })
})

describe('the password never reaches the log', () => {
  const passwords = ['abc', `it's "quoted"`]
  const ports: [string, Partial<ShellPasswordPort>][] = [
    ['accepted', {}],
    ['refused', { submit: async () => 'refused' }],
    ['expired', { submit: async () => 'expired' }],
    // The worst case: the error itself carries the password.
    ['throwing', { submit: async ({ password }) => Promise.reject(Object.assign(new Error(`bad ${password}`), { password })) }],
  ]

  for (const password of passwords) {
    it.each(ports)(`keeps ${JSON.stringify(password)} out of the log when the port is %s`, async (_name, overrides) => {
      const { ctx, logged } = capturingContext(fakePort(overrides).port)

      await handleShellPasswordSubmission(ctx, submission(password))

      expect(logged()).not.toBe('')
      expect(logged()).not.toContain(password)
      expect(logged()).not.toContain(JSON.stringify(password).slice(1, -1))
    })
  }
})
