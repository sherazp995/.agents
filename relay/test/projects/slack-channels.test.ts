import { describe, expect, it } from 'vitest'
import { listBotChannels, MISSING_SCOPE_MESSAGE, type FetchChannelPage } from '../../src/projects/slack-channels.js'

describe('listBotChannels', () => {
  it('follows every cursor and sorts the channels by name', async () => {
    const cursors: Array<string | undefined> = []
    const pages: FetchChannelPage = async (cursor) => {
      cursors.push(cursor)
      return cursor === undefined ? { channels: [{ id: 'C2', name: 'web' }], nextCursor: 'next' } : { channels: [{ id: 'C1', name: 'api' }] }
    }

    expect(await listBotChannels(pages)).toEqual({ kind: 'ok', channels: [{ id: 'C1', name: 'api' }, { id: 'C2', name: 'web' }] })
    expect(cursors).toEqual([undefined, 'next'])
  })

  it('names the reinstall for a missing scope, and passes any other Slack error through', async () => {
    const failing = (error: unknown): FetchChannelPage => async () => Promise.reject(error)

    expect(await listBotChannels(failing(Object.assign(new Error('An API error occurred: missing_scope'), { data: { error: 'missing_scope' } })))).toEqual({ kind: 'failed', message: MISSING_SCOPE_MESSAGE })
    expect(await listBotChannels(failing(new Error('ratelimited')))).toEqual({ kind: 'failed', message: 'Could not list Slack channels: ratelimited' })
  })
})
