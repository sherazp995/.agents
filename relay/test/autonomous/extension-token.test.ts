import { describe, expect, it } from 'vitest'
import { createExtensionTokens, extensionTokenIn } from '../../src/autonomous/extension-token.js'
import { firstFolderPath } from '../../src/chat/slack/channel-folder.js'
import type { Logger } from '../../src/obs/logger.js'
import { scrubSecrets } from '../../src/secrets/scrubber.js'

const TOKEN = 'k3y-AbCdEf_0123456789'

function quietLog(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return { warnings, warn: (_obj: unknown, message: string) => void warnings.push(message), info: () => {}, error: () => {}, debug: () => {} } as unknown as Logger & { warnings: string[] }
}

describe('extensionTokenIn', () => {
  it('takes the value after the first PLAYWRIGHT_MCP_EXTENSION_TOKEN= line, bare, quoted or in backticks', () => {
    expect(extensionTokenIn(`Folder ~/code/web\nPLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`)).toBe(TOKEN)
    expect(extensionTokenIn(`\`PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}\``)).toBe(TOKEN)
    expect(extensionTokenIn(`PLAYWRIGHT_MCP_EXTENSION_TOKEN="${TOKEN}" and PLAYWRIGHT_MCP_EXTENSION_TOKEN=other`)).toBe(TOKEN)
  })

  it('gives none without the line, for the name alone, or for a longer name that only ends with it', () => {
    expect(extensionTokenIn('Folder ~/code/web')).toBeUndefined()
    expect(extensionTokenIn('PLAYWRIGHT_MCP_EXTENSION_TOKEN=')).toBeUndefined()
    expect(extensionTokenIn(`MY_PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`)).toBeUndefined()
  })

  it('leaves the folder pick alone when the token line sits next to the folder', () => {
    expect(firstFolderPath(`PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN} work in ~/code/web`)).toBe('~/code/web')
  })
})

describe('createExtensionTokens', () => {
  it("gives a worker its channel's token and registers it, so Relay's posts scrub it", async () => {
    const tokens = createExtensionTokens({ readPurpose: async () => `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`, log: quietLog() })

    expect(await tokens.forWorker('t1', 'C1')).toBe(TOKEN)
    expect(scrubSecrets(`the token is ${TOKEN}`)).not.toContain(TOKEN)
  })

  it('gives none for a DM without reading it, and none with a warning when the description cannot be read', async () => {
    const read: string[] = []
    const log = quietLog()
    const tokens = createExtensionTokens({
      readPurpose: async (channel) => {
        read.push(channel)
        throw new Error('channel_not_found')
      },
      log,
    })

    expect(await tokens.forWorker('t1', 'D1')).toBeUndefined()
    expect(await tokens.forWorker('t2', 'C1')).toBeUndefined()
    expect(read).toEqual(['C1'])
    expect(log.warnings).toHaveLength(1)
  })

  it('reports a change once the line is removed or replaced, and none while it stays the same', async () => {
    let purpose = `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`
    const tokens = createExtensionTokens({ readPurpose: async () => purpose, log: quietLog() })
    await tokens.forWorker('t1', 'C1')

    expect(await tokens.changedSince('t1', 'C1')).toBe(false)
    purpose = 'no token now'
    expect(await tokens.changedSince('t1', 'C1')).toBe(true)
    purpose = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=another-token-1234'
    expect(await tokens.changedSince('t1', 'C1')).toBe(true)
  })

  it('reports no change for a task whose worker it never started, such as a read-only one', async () => {
    const tokens = createExtensionTokens({ readPurpose: async () => `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`, log: quietLog() })
    expect(await tokens.changedSince('never', 'C1')).toBe(false)
  })
})
