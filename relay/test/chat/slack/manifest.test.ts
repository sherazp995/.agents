import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { buildAppManifest } from '../../../src/chat/slack/manifest.js'
import { FORBIDDEN_WORKSPACE_WIDE_SCOPES, SLACK_BOT_SCOPES } from '../../../src/chat/slack/scopes.js'

type PublishedManifest = {
  oauth_config: { scopes: { bot: string[] } }
  features: {
    app_home: {
      home_tab_enabled: boolean
      messages_tab_enabled: boolean
      messages_tab_read_only_enabled: boolean
    }
  }
}

/**
 * Reads the handwritten manifest an operator actually pastes into
 * api.slack.com/apps. Loaded from disk rather than duplicated as a fixture
 * so this test fails the moment the two documents disagree, which is the
 * whole point: `buildAppManifest()` and this file are two independent
 * places the same manifest can drift, and only a test that reads both stops
 * that drift silently shipping again.
 */
function loadPublishedManifest(): PublishedManifest {
  const raw = readFileSync(new URL('../../../docs/slack-app-manifest.yaml', import.meta.url), 'utf8')
  return parseYaml(raw) as PublishedManifest
}

/**
 * Walks the entire manifest structure, not only oauth_config.scopes.bot,
 * and collects every string value found anywhere in it. FR-SLA-5's guard
 * is meant to catch a workspace wide scope leaking in from ANY field a
 * future edit might add it to, such as a second, mistaken scopes block, a
 * stray comment style field, or a typo that puts it under the wrong key,
 * not only the one field this manifest happens to define it under today.
 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out)
  } else if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) collectStrings(entry, out)
  }
  return out
}

describe('buildAppManifest', () => {
  it('requests exactly SLACK_BOT_SCOPES, in order, as the bot scope list', () => {
    const manifest = buildAppManifest() as {
      oauth_config: { scopes: { bot: string[] } }
    }
    expect(manifest.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES])
  })

  it('never mentions search:read anywhere in the manifest', () => {
    const strings = collectStrings(buildAppManifest())
    expect(strings).not.toContain('search:read')
  })

  it('never mentions users:read.email anywhere in the manifest', () => {
    const strings = collectStrings(buildAppManifest())
    expect(strings).not.toContain('users:read.email')
  })

  it('never mentions any workspace wide read scope anywhere in the manifest', () => {
    const strings = collectStrings(buildAppManifest())
    for (const forbidden of FORBIDDEN_WORKSPACE_WIDE_SCOPES) {
      expect(strings).not.toContain(forbidden)
    }
  })

  it('declares Socket Mode and never a request URL, per FR-SLA-8', () => {
    const manifest = buildAppManifest() as {
      settings: { socket_mode_enabled: boolean }
    }
    expect(manifest.settings.socket_mode_enabled).toBe(true)
    expect(collectStrings(manifest).some((value) => value.includes('request_url'))).toBe(false)
    expect(JSON.stringify(manifest)).not.toMatch(/request_url/)
  })

  it('respects appName and description overrides in both display_information and the bot user', () => {
    const manifest = buildAppManifest({ appName: 'RelayTest', description: 'A test bot' }) as {
      display_information: { name: string; description: string }
      features: { bot_user: { display_name: string } }
    }
    expect(manifest.display_information.name).toBe('RelayTest')
    expect(manifest.display_information.description).toBe('A test bot')
    expect(manifest.features.bot_user.display_name).toBe('RelayTest')
  })

  it('still requests exactly SLACK_BOT_SCOPES when other options are overridden, so an operator customising branding cannot accidentally widen scopes', () => {
    const manifest = buildAppManifest({ appName: 'Custom', slashCommand: '/custom' }) as {
      oauth_config: { scopes: { bot: string[] } }
    }
    expect(manifest.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES])
  })

  it('declares an app_home block, without which Slack defaults the Messages tab to read only and DMs to the bot become impossible', () => {
    const manifest = buildAppManifest() as {
      features: { app_home: { messages_tab_enabled: boolean; messages_tab_read_only_enabled: boolean } }
    }
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true)
    expect(manifest.features.app_home.messages_tab_read_only_enabled).toBe(false)
  })
})

describe('buildAppManifest parity with docs/slack-app-manifest.yaml', () => {
  it('requests exactly the same bot scopes, in the same order, as the published YAML manifest', () => {
    const generated = buildAppManifest() as PublishedManifest
    const published = loadPublishedManifest()
    expect(generated.oauth_config.scopes.bot).toEqual(published.oauth_config.scopes.bot)
  })

  it('declares the same app_home settings as the published YAML manifest, so the generator cannot silently drift from the fix that let DMs through again', () => {
    const generated = buildAppManifest() as PublishedManifest
    const published = loadPublishedManifest()
    expect(generated.features.app_home).toEqual(published.features.app_home)
  })
})
