import { describe, expect, it } from 'vitest'
import { browserEnv, createExtensionTokens, EXTENSION_ONLY_NOTE, extensionProfileIn, extensionTokenIn, takeExtensionLines } from '../../src/autonomous/extension-token.js'
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

describe('extensionProfileIn', () => {
  it('reads a quoted profile name with its space, in straight or curly quotes, single quotes or backticks', () => {
    expect(extensionProfileIn(`~/code/insitu PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN} PLAYWRIGHT_MCP_PROFILE_DIR_NAME="Profile 16"`)).toBe('Profile 16')
    expect(extensionProfileIn('PLAYWRIGHT_MCP_PROFILE_DIR_NAME=\u201cProfile 16\u201d')).toBe('Profile 16')
    expect(extensionProfileIn("PLAYWRIGHT_MCP_PROFILE_DIR_NAME='Profile 3'")).toBe('Profile 3')
    expect(extensionProfileIn('`PLAYWRIGHT_MCP_PROFILE_DIR_NAME=Default`')).toBe('Default')
  })

  it('gives none without the line, for an unquoted name cut at its space, or for anything that is not a profile directory', () => {
    expect(extensionProfileIn(`PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`)).toBeUndefined()
    expect(extensionProfileIn('PLAYWRIGHT_MCP_PROFILE_DIR_NAME=Profile 16')).toBeUndefined()
    expect(extensionProfileIn('PLAYWRIGHT_MCP_PROFILE_DIR_NAME="Hassan (insitu)"')).toBeUndefined()
    expect(extensionProfileIn('PLAYWRIGHT_MCP_PROFILE_DIR_NAME="../Profile 1"')).toBeUndefined()
    expect(extensionProfileIn('XPLAYWRIGHT_MCP_PROFILE_DIR_NAME="Profile 16"')).toBeUndefined()
  })

  it('leaves the token and the folder pick alone when the profile line sits next to them', () => {
    const description = `~/code/web PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}\nPLAYWRIGHT_MCP_PROFILE_DIR_NAME="Profile 16"`
    expect(extensionTokenIn(description)).toBe(TOKEN)
    expect(firstFolderPath(description)).toBe('~/code/web')
  })
})

describe('takeExtensionLines', () => {
  it('gives the token and profile and the message without them, and registers the token for scrubbing', () => {
    const taken = takeExtensionLines(`Start at ~/.agents \`PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}\` PLAYWRIGHT_MCP_PROFILE_DIR_NAME=\u201cProfile 16\u201d and fix it`)

    expect(taken).toEqual({ text: 'Start at ~/.agents and fix it', found: true, browser: { token: TOKEN, profile: 'Profile 16' } })
    expect(scrubSecrets(`the token is ${TOKEN}`)).not.toContain(TOKEN)
  })

  it('leaves a message without the words unchanged, including a longer name that only ends with one', () => {
    const text = `fix it  please MY_PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`
    expect(takeExtensionLines(text)).toEqual({ text, found: false, browser: {} })
  })

  it('removes an unusable profile without using it', () => {
    expect(takeExtensionLines('go PLAYWRIGHT_MCP_PROFILE_DIR_NAME="../Profile 1"')).toEqual({ text: 'go', found: true, browser: {} })
  })

  it('stores a note for a message that held nothing else', () => {
    expect(takeExtensionLines(`PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}\nPLAYWRIGHT_MCP_PROFILE_DIR_NAME="Profile 3"`).text).toBe(EXTENSION_ONLY_NOTE)
  })
})

describe('createExtensionTokens', () => {
  it("gives a thread its channel's token and registers it, so Relay's posts scrub it", async () => {
    const tokens = createExtensionTokens({ readPurpose: async () => `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN}`, log: quietLog() })

    expect(await tokens.current('C1')).toEqual({ token: TOKEN })
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

    expect(await tokens.current('D1')).toEqual({})
    expect(await tokens.current('C1')).toEqual({})
    expect(read).toEqual(['C1'])
    expect(log.warnings).toHaveLength(1)
  })

  it('gives the profile with the token as envs', async () => {
    const tokens = createExtensionTokens({ readPurpose: async () => `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${TOKEN} PLAYWRIGHT_MCP_PROFILE_DIR_NAME="Profile 16"`, log: quietLog() })

    expect(browserEnv(await tokens.current('C1'))).toEqual({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN, PLAYWRIGHT_MCP_PROFILE_DIR_NAME: 'Profile 16' })
  })

  it("gives a DM thread its remembered values without reading anything, replaces them, and drops them on forget", async () => {
    const read: string[] = []
    const tokens = createExtensionTokens({ readPurpose: async (channel) => (read.push(channel), ''), log: quietLog() })
    tokens.rememberDm('D1:10.1', { token: TOKEN, profile: 'Profile 16' })

    expect(await tokens.current('D1:10.1')).toEqual({ token: TOKEN, profile: 'Profile 16' })
    expect(await tokens.current('D1:20.1')).toEqual({})
    tokens.rememberDm('D1:10.1', { token: TOKEN })
    expect(await tokens.current('D1:10.1')).toEqual({ token: TOKEN })
    tokens.forget('D1:10.1')
    expect(await tokens.current('D1:10.1')).toEqual({})
    expect(read).toEqual([])
  })

  it("ignores DM values for a channel thread and reads its description", async () => {
    const tokens = createExtensionTokens({ readPurpose: async () => 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=channel-token-1234', log: quietLog() })
    tokens.rememberDm('C1:10.1', { token: TOKEN })

    expect(await tokens.current('C1:10.1')).toEqual({ token: 'channel-token-1234' })
  })
})
