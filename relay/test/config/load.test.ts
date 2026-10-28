import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../../src/config/errors.js'
import { loadPolicy, loadRelayConfig } from '../../src/config/load.js'

function writeTemp(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-config-'))
  const path = join(dir, name)
  writeFileSync(path, contents, 'utf8')
  return path
}

const VALID_POLICY = `
version: 1
defaults:
  unmatched: ask
hard_blocked_origins:
  - "*.chase.com"
`

describe('loadPolicy', () => {
  it('accepts a policy with a non-empty hard-blocked list', () => {
    const policy = loadPolicy(writeTemp('policy.yaml', VALID_POLICY))
    expect(policy.defaults.unmatched).toBe('ask')
    expect(policy.hard_blocked_origins).toEqual(['*.chase.com'])
  })

  it('refuses an empty hard-blocked origin list, per FR-SET-7', () => {
    const yaml = `
version: 1
defaults:
  unmatched: ask
hard_blocked_origins: []
`
    expect(() => loadPolicy(writeTemp('policy.yaml', yaml))).toThrow(ConfigError)
  })

  it('refuses an unmatched default of allow, per FR-POL-3', () => {
    const yaml = VALID_POLICY.replace('unmatched: ask', 'unmatched: allow')
    expect(() => loadPolicy(writeTemp('policy.yaml', yaml))).toThrow(/unmatched/)
  })

  it('refuses malformed YAML rather than defaulting permissive, per FR-POL-2', () => {
    expect(() => loadPolicy(writeTemp('policy.yaml', 'defaults: [unclosed'))).toThrow(ConfigError)
  })

  it('refuses a missing file rather than assuming defaults', () => {
    expect(() => loadPolicy('/nonexistent/policy.yaml')).toThrow(ConfigError)
  })

  it('refuses hard-blocked origins that are blank or whitespace-only, per FR-SET-7', () => {
    const blank = VALID_POLICY.replace('"*.chase.com"', '"   "')
    expect(() => loadPolicy(writeTemp('policy.yaml', blank))).toThrow(ConfigError)

    const empty = VALID_POLICY.replace('"*.chase.com"', '""')
    expect(() => loadPolicy(writeTemp('policy.yaml', empty))).toThrow(ConfigError)

    // A real, non-blank list must still be accepted.
    const policy = loadPolicy(writeTemp('policy.yaml', VALID_POLICY))
    expect(policy.hard_blocked_origins).toEqual(['*.chase.com'])
  })

  it('refuses an unknown top-level key rather than silently discarding it', () => {
    const yaml = `${VALID_POLICY}\nunknown_top_level_key: true\n`
    expect(() => loadPolicy(writeTemp('policy.yaml', yaml))).toThrow(/unknown_top_level_key/)
  })

  it('refuses an unknown nested key rather than silently discarding it', () => {
    const yaml = VALID_POLICY.replace('unmatched: ask', 'unmatched: ask\n  unknown_nested_key: true')
    expect(() => loadPolicy(writeTemp('policy.yaml', yaml))).toThrow(/unknown_nested_key/)
  })

  it('freezes the returned policy recursively, so it cannot be overridden at runtime, per FR-POL-4', () => {
    const policy = loadPolicy(writeTemp('policy.yaml', VALID_POLICY))
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.defaults)).toBe(true)
    expect(Object.isFrozen(policy.hard_blocked_origins)).toBe(true)
    expect(() => {
      ;(policy.hard_blocked_origins as string[]).length = 0
    }).toThrow(TypeError)
    expect(policy.hard_blocked_origins).toEqual(['*.chase.com'])
  })

  it('keeps only the first line of a YAML syntax error, so a bad line never leaks its contents', () => {
    const yaml = 'defaults:\n  bad_password_field_hunter2SECRET: [unclosed\n'
    try {
      loadPolicy(writeTemp('policy.yaml', yaml))
      throw new Error('expected loadPolicy to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as Error).message).not.toContain('hunter2SECRET')
    }
  })
})

describe('loadPolicy: origins, escalation_rules, capabilities', () => {
  it('accepts a policy with no origins, escalation_rules, or capabilities block, since all three are optional', () => {
    const policy = loadPolicy(writeTemp('policy.yaml', VALID_POLICY))
    expect(policy.origins).toBeUndefined()
    expect(policy.escalation_rules).toBeUndefined()
    expect(policy.capabilities).toBeUndefined()
  })

  it('accepts an origins allow/deny list, per FR-POL-4', () => {
    const yaml = `${VALID_POLICY}\norigins:\n  allow: ["*.mycompany.com", "github.com"]\n  deny: ["*.ads.example"]\n`
    const policy = loadPolicy(writeTemp('policy.yaml', yaml))
    expect(policy.origins).toEqual({ allow: ['*.mycompany.com', 'github.com'], deny: ['*.ads.example'] })
  })

  it('refuses an origins block missing either allow or deny, since both are required once the block is present', () => {
    const yaml = `${VALID_POLICY}\norigins:\n  allow: ["github.com"]\n`
    expect(() => loadPolicy(writeTemp('policy.yaml', yaml))).toThrow(/origins.deny/)
  })

  it('accepts escalation_rules matching the requirements doc §18.4 policy example, per FR-POL-1 and FR-POL-8', () => {
    const yaml = `${VALID_POLICY}
escalation_rules:
  - when: { amount_gt: 50 }
    then: irreversible
  - when: { affected_count_gt: 10 }
    then: irreversible
  - when: { origin_unknown: true, tier: write }
    then: sensitive
  - when: { credential_in_args: true }
    then: sensitive
`
    const policy = loadPolicy(writeTemp('policy.yaml', yaml))
    expect(policy.escalation_rules).toHaveLength(4)
    expect(policy.escalation_rules?.[2]).toEqual({ when: { origin_unknown: true, tier: 'write' }, then: 'sensitive' })
  })

  it('refuses an escalation rule whose "when" clause is empty, since it would match every call unconditionally', () => {
    const yaml = `${VALID_POLICY}\nescalation_rules:\n  - when: {}\n    then: irreversible\n`
    expect(() => loadPolicy(writeTemp('policy.yaml', yaml))).toThrow(/escalation rule condition/)
  })

  it('refuses an escalation rule with an unknown condition field', () => {
    const yaml = `${VALID_POLICY}\nescalation_rules:\n  - when: { amount_gt: 50, made_up_field: true }\n    then: irreversible\n`
    expect(() => loadPolicy(writeTemp('policy.yaml', yaml))).toThrow(/made_up_field/)
  })

  it('refuses an escalation rule whose "then" is not a real risk tier', () => {
    const yaml = `${VALID_POLICY}\nescalation_rules:\n  - when: { amount_gt: 50 }\n    then: catastrophic\n`
    expect(() => loadPolicy(writeTemp('policy.yaml', yaml))).toThrow(/then/)
  })

  it('accepts capability scope overrides at all four FR-CAP-2 scopes', () => {
    const yaml = `${VALID_POLICY}
capabilities:
  shell.exec:
    global: disabled
    principals:
      alice: approval_gated
    sessions:
      sess-1: enabled
    recipes:
      nightly-cleanup: disabled
`
    const policy = loadPolicy(writeTemp('policy.yaml', yaml))
    expect(policy.capabilities?.['shell.exec']).toEqual({
      global: 'disabled',
      principals: { alice: 'approval_gated' },
      sessions: { 'sess-1': 'enabled' },
      recipes: { 'nightly-cleanup': 'disabled' },
    })
  })

  it('refuses a capability state outside enabled, disabled, or approval_gated', () => {
    const yaml = `${VALID_POLICY}\ncapabilities:\n  shell.exec:\n    global: sort_of_enabled\n`
    expect(() => loadPolicy(writeTemp('policy.yaml', yaml))).toThrow(/global/)
  })

  it('freezes origins, escalation_rules, and capabilities recursively, per FR-POL-4', () => {
    const yaml = `${VALID_POLICY}
origins:
  allow: ["github.com"]
  deny: []
escalation_rules:
  - when: { amount_gt: 50 }
    then: irreversible
capabilities:
  shell.exec:
    global: disabled
`
    const policy = loadPolicy(writeTemp('policy.yaml', yaml))
    expect(Object.isFrozen(policy.origins)).toBe(true)
    expect(Object.isFrozen(policy.origins?.allow)).toBe(true)
    expect(Object.isFrozen(policy.escalation_rules)).toBe(true)
    expect(Object.isFrozen(policy.capabilities)).toBe(true)
    expect(Object.isFrozen(policy.capabilities?.['shell.exec'])).toBe(true)
  })
})

const VALID_CONFIG = `
model_provider:
  name: anthropic
  zero_data_retention: true
database:
  url: postgres://localhost:5432/relay
redis:
  url: redis://localhost:6379
logging:
  level: info
secrets:
  provider: keychain
`

describe('loadRelayConfig', () => {
  it('accepts a config asserting zero data retention', () => {
    const config = loadRelayConfig(writeTemp('relay.config.yaml', VALID_CONFIG))
    expect(config.model_provider.zero_data_retention).toBe(true)
    expect(config.logging.level).toBe('info')
  })

  it('leaves logging.file unset when the config omits it, preserving stdout logging by default, per FR-OBS-1', () => {
    const config = loadRelayConfig(writeTemp('relay.config.yaml', VALID_CONFIG))
    expect(config.logging.file).toBeUndefined()
    expect(config.logging.max_size_bytes).toBeUndefined()
    expect(config.logging.max_files).toBeUndefined()
  })

  it('accepts a logging.file with rotation caps, per FR-OBS-1', () => {
    const yaml = VALID_CONFIG.replace(
      'logging:\n  level: info',
      'logging:\n  level: info\n  file: /var/log/relay/relay.log\n  max_size_bytes: 1048576\n  max_files: 10',
    )
    const config = loadRelayConfig(writeTemp('relay.config.yaml', yaml))
    expect(config.logging.file).toBe('/var/log/relay/relay.log')
    expect(config.logging.max_size_bytes).toBe(1048576)
    expect(config.logging.max_files).toBe(10)
  })

  it('loads a config from before Slack chats dropped their budget, and still refuses another unknown autonomous key', () => {
    const old = `${VALID_CONFIG}autonomous:\n  enabled: true\n  per_turn_fallback_usd: 1\n  codex_usd_per_mtok: 10\n  review_codex_allowance_usd: 2\n`
    expect(loadRelayConfig(writeTemp('relay.config.yaml', old)).autonomous).toMatchObject({ enabled: true })
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', `${VALID_CONFIG}autonomous:\n  enabled: true\n  budget_usd: 1\n`))).toThrow(/budget_usd/)
  })

  it('refuses a blank logging.file rather than silently treating it as unset', () => {
    const yaml = VALID_CONFIG.replace('logging:\n  level: info', 'logging:\n  level: info\n  file: "   "')
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', yaml))).toThrow(/logging.file/)
  })

  it('refuses a non-positive max_size_bytes or max_files', () => {
    const badSize = VALID_CONFIG.replace(
      'logging:\n  level: info',
      'logging:\n  level: info\n  file: /var/log/relay/relay.log\n  max_size_bytes: 0',
    )
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', badSize))).toThrow(/max_size_bytes/)

    const badFiles = VALID_CONFIG.replace(
      'logging:\n  level: info',
      'logging:\n  level: info\n  file: /var/log/relay/relay.log\n  max_files: -1',
    )
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', badFiles))).toThrow(/max_files/)
  })

  it('refuses a config that does not assert zero data retention, per FR-DATA-6', () => {
    const yaml = VALID_CONFIG.replace('zero_data_retention: true', 'zero_data_retention: false')
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', yaml))).toThrow(/zero_data_retention/)
  })

  it('names the offending file in the error, so the operator can act', () => {
    const path = writeTemp('relay.config.yaml', 'database: {}')
    expect(() => loadRelayConfig(path)).toThrow(new RegExp(path.replace(/[/\\]/g, '.')))
  })

  it('refuses an unknown top-level key rather than silently discarding it', () => {
    const yaml = `${VALID_CONFIG}\nunknown_top_level_key: true\n`
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', yaml))).toThrow(/unknown_top_level_key/)
  })

  it('refuses an unknown nested key rather than silently discarding it', () => {
    const yaml = VALID_CONFIG.replace('name: anthropic', 'name: anthropic\n  unknown_nested_key: true')
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', yaml))).toThrow(/unknown_nested_key/)
  })

  it('refuses an HTTPS URL for the database, which must be postgres:// or postgresql://', () => {
    const yaml = VALID_CONFIG.replace(
      'url: postgres://localhost:5432/relay',
      'url: https://localhost:5432/relay',
    )
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', yaml))).toThrow(/database.url/)
  })

  it('refuses an HTTPS URL for redis, which must be redis:// or rediss://', () => {
    const yaml = VALID_CONFIG.replace('url: redis://localhost:6379', 'url: https://localhost:6379')
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', yaml))).toThrow(/redis.url/)
  })

  it('refuses secrets.provider: env, since production secrets must come from the Keychain and never an environment dump, per FR-SLA-6', () => {
    const yaml = VALID_CONFIG.replace('provider: keychain', 'provider: env')
    expect(() => loadRelayConfig(writeTemp('relay.config.yaml', yaml))).toThrow(/provider/)
  })

  it('freezes the returned config recursively, so it cannot be mutated at runtime', () => {
    const config = loadRelayConfig(writeTemp('relay.config.yaml', VALID_CONFIG))
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.database)).toBe(true)
    expect(() => {
      ;(config.database as { url: string }).url = 'postgres://tampered/db'
    }).toThrow(TypeError)
  })
})
