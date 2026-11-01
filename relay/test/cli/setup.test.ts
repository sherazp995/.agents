import { describe, expect, it, vi } from 'vitest'
import { buildSetupSteps, runSetup, type SetupDependencies, type SetupStep } from '../../src/cli/setup.js'

function step(title: string, exitCode: number, report = `${title} done`): SetupStep & { run: ReturnType<typeof vi.fn> } {
  return { title, command: `relay ${title}`, run: vi.fn(async () => ({ report, exitCode })) }
}

describe('runSetup', () => {
  it('runs every step in order and finishes', async () => {
    const output: string[] = []
    const steps = [step('init', 0), step('db create', 0, 'already connects; nothing to do')]

    const result = await runSetup(steps, (text) => output.push(text))

    expect(result).toEqual({ report: 'Setup finished.', exitCode: 0 })
    expect(output.join('')).toContain('[2/2] db create\n  already connects; nothing to do')
  })

  it('stops at the first failing step and names its command', async () => {
    const later = step('repos add', 0)
    const steps = [step('init', 0), step('db create', 1, 'could not connect'), later]

    const result = await runSetup(steps, () => {})

    expect(result.exitCode).toBe(1)
    expect(result.report).toContain('Setup stopped at step 2')
    expect(result.report).toContain('`relay db create`')
    expect(later.run).not.toHaveBeenCalled()
  })

  it('treats a thrown step as a failure', async () => {
    const thrower: SetupStep = { title: 'secrets', command: 'relay secrets migrate', run: async () => { throw new Error('keyring locked') } }
    const output: string[] = []

    const result = await runSetup([thrower], (text) => output.push(text))

    expect(result.exitCode).toBe(1)
    expect(output.join('')).toContain('keyring locked')
  })
})

function fakeDeps(overrides: Partial<SetupDependencies> = {}): SetupDependencies & { calls: string[] } {
  const calls: string[] = []
  const ok = (name: string) => async () => {
    calls.push(name)
    return { report: `${name} ran`, exitCode: 0 }
  }
  return {
    calls,
    platform: 'linux',
    configPath: '/home/me/.relay/config/relay.config.yaml',
    configExists: () => true,
    init: ok('init'),
    dbCreate: ok('db create'),
    installService: async (start) => {
      calls.push(start ? 'install-service --start' : 'install-service')
      return { report: '', exitCode: 0 }
    },
    serviceInstalled: () => false,
    secretsMigrate: ok('secrets migrate'),
    hasSecret: async () => true,
    setSecret: async (name, value) => {
      calls.push(`set ${name}=${value}`)
      return { report: '', exitCode: 0 }
    },
    registeredRepos: () => ['agents'],
    reposAdd: async (path) => {
      calls.push(`repos add ${path}`)
      return { report: '', exitCode: 0 }
    },
    doctor: ok('doctor'),
    interactive: true,
    askHidden: async () => 'xoxb-pasted',
    askLine: async (_question, fallback) => fallback,
    cwd: '/home/me/project',
    ...overrides,
  }
}

describe('buildSetupSteps', () => {
  it('on Linux runs the database, migrate, supervisor and doctor, skipping what is done', async () => {
    const deps = fakeDeps()

    await runSetup(buildSetupSteps(deps), () => {})

    expect(deps.calls).toEqual(['db create', 'secrets migrate', 'install-service --start', 'doctor'])
  })

  it('on macOS builds the secrets helper before migrate stores anything', async () => {
    const deps = fakeDeps({ platform: 'darwin', serviceInstalled: () => true })

    await runSetup(buildSetupSteps(deps), () => {})

    expect(deps.calls).toEqual(['db create', 'install-service', 'secrets migrate', 'install-service --start', 'doctor'])
  })

  it('on Linux leaves an installed supervisor alone', async () => {
    const deps = fakeDeps({ serviceInstalled: () => true })

    await runSetup(buildSetupSteps(deps), () => {})

    expect(deps.calls).not.toContain('install-service --start')
  })

  it('writes the config only when there is none', async () => {
    const deps = fakeDeps({ configExists: () => false })

    await runSetup(buildSetupSteps(deps), () => {})

    expect(deps.calls[0]).toBe('init')
  })

  it('asks for a missing Slack token and refuses one with the wrong prefix', async () => {
    const stored = fakeDeps({ hasSecret: async (name) => name !== 'relay-slack-bot-token' })
    await runSetup(buildSetupSteps(stored), () => {})
    expect(stored.calls).toContain('set relay-slack-bot-token=xoxb-pasted')

    const wrong = fakeDeps({ hasSecret: async () => false, askHidden: async () => 'not-a-token' })
    const result = await runSetup(buildSetupSteps(wrong), () => {})
    expect(result.report).toContain('`relay secrets set relay-slack-bot-token`')
    expect(wrong.calls.some((call) => call.startsWith('set '))).toBe(false)
  })

  it('stops on a missing token when there is no terminal to ask', async () => {
    const deps = fakeDeps({ hasSecret: async () => false, interactive: false })

    const result = await runSetup(buildSetupSteps(deps), () => {})

    expect(result.exitCode).toBe(1)
    expect(deps.calls).not.toContain('doctor')
  })

  it('registers --repo, or the answer to the prompt, when no repository is registered', async () => {
    const flagged = fakeDeps({ registeredRepos: () => [], repo: '/home/me/.agents' })
    await runSetup(buildSetupSteps(flagged), () => {})
    expect(flagged.calls).toContain('repos add /home/me/.agents')

    const asked = fakeDeps({ registeredRepos: () => [] })
    await runSetup(buildSetupSteps(asked), () => {})
    expect(asked.calls).toContain('repos add /home/me/project')
  })
})
