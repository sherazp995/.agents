import { describe, expect, it } from 'vitest'
import { CONFIRM_MODAL_BLOCK_ID, CONFIRM_MODAL_CALLBACK_ID, EDIT_MODAL_BLOCK_ID, EDIT_MODAL_CALLBACK_ID } from '../../../src/approvals/blockkit.js'
import { viewFallbackErrors } from '../../../src/chat/slack/api-client.js'
import { SHELL_PASSWORD_BLOCK_ID, SHELL_PASSWORD_CALLBACK_ID, SHELL_PASSWORD_GENERIC_ERROR } from '../../../src/chat/slack/shell-password.js'

describe('viewFallbackErrors', () => {
  const approvalText = 'Something went wrong; your decision was not recorded. Please try again.'

  it.each([
    [CONFIRM_MODAL_CALLBACK_ID, CONFIRM_MODAL_BLOCK_ID, approvalText],
    [EDIT_MODAL_CALLBACK_ID, EDIT_MODAL_BLOCK_ID, approvalText],
    [SHELL_PASSWORD_CALLBACK_ID, SHELL_PASSWORD_BLOCK_ID, SHELL_PASSWORD_GENERIC_ERROR],
    ['unknown_popup', CONFIRM_MODAL_BLOCK_ID, approvalText],
  ])('puts the error for %s on its own block', (callbackId, blockId, text) => {
    expect(viewFallbackErrors(callbackId)).toEqual({ [blockId]: text })
  })
})
