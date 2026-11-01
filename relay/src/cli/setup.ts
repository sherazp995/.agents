/**
 * `relay setup`: every install step in order, on macOS and Linux, so a new
 * machine needs commands rather than hand-written files, SQL or keystore
 * calls. Each step is one of relay's own commands and checks before it
 * acts, so running setup again only finishes what an earlier run left. The
 * first step that fails stops the run and names the command that fixes it,
 * because a later step built on a missing earlier one only fails louder.
 */

import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { SLACK_APP_TOKEN_SECRET, SLACK_BOT_TOKEN_SECRET } from '../chat/slack/adapter.js'

export type StepResult = { readonly report: string; readonly exitCode: number }

export type SetupStep = {
  readonly title: string
  /** The standalone command for this step, named when it fails so it can be rerun alone. */
  readonly command: string
  run(): Promise<StepResult>
}

export type SetupResult = { readonly report: string; readonly exitCode: number }

export async function runSetup(steps: readonly SetupStep[], write: (text: string) => void): Promise<SetupResult> {
  for (const [index, step] of steps.entries()) {
    write(`\n[${index + 1}/${steps.length}] ${step.title}\n`)
    let result: StepResult
    try {
      result = await step.run()
    } catch (error) {
      result = { report: (error as Error).message, exitCode: 1 }
    }
    if (result.report !== '') write(`${indent(result.report)}\n`)
    if (result.exitCode !== 0) {
      return {
        report: `Setup stopped at step ${index + 1}. Fix what it names, then run \`${step.command}\` or \`relay setup\` again; finished steps are skipped.`,
        exitCode: result.exitCode,
      }
    }
  }
  return { report: 'Setup finished.', exitCode: 0 }
}

/** Each step's effect, injected so the CLI passes relay's own commands and a test passes fakes. */
export type SetupDependencies = {
  readonly platform: NodeJS.Platform
  readonly configPath: string
  readonly configExists: () => boolean
  readonly init: () => Promise<StepResult>
  readonly dbCreate: () => Promise<StepResult>
  readonly installService: (start: boolean) => Promise<StepResult>
  readonly serviceInstalled: () => boolean
  readonly secretsMigrate: () => Promise<StepResult>
  readonly hasSecret: (name: string) => Promise<boolean>
  readonly setSecret: (name: string, value: string) => Promise<StepResult>
  readonly registeredRepos: () => readonly string[]
  readonly reposAdd: (path: string) => Promise<StepResult>
  readonly doctor: () => Promise<StepResult>
  /** Whether a person is at a terminal to answer the token and repository prompts. */
  readonly interactive: boolean
  readonly askHidden: (question: string) => Promise<string>
  readonly askLine: (question: string, fallback: string) => Promise<string>
  /** `--repo`, used instead of asking. */
  readonly repo?: string
  readonly cwd: string
}

function slackTokenStep(deps: SetupDependencies, name: string, label: string, prefix: string): SetupStep {
  return {
    title: label,
    command: `relay secrets set ${name}`,
    async run() {
      if (await deps.hasSecret(name)) return { report: `${name} is already stored`, exitCode: 0 }
      if (!deps.interactive) return { report: `${name} is missing and there is no terminal to ask for it`, exitCode: 1 }
      const value = await deps.askHidden(`Paste the ${label} (${prefix}...), from the Slack app made with docs/slack-app-manifest.yaml: `)
      if (!value.startsWith(prefix)) return { report: `That does not start with ${prefix}; nothing was stored`, exitCode: 1 }
      return deps.setSecret(name, value)
    },
  }
}

/** The install steps in order for this platform; each skips itself when its work is already done. */
export function buildSetupSteps(deps: SetupDependencies): SetupStep[] {
  return [
    {
      title: 'Config',
      command: 'relay init',
      run: () => (deps.configExists() ? Promise.resolve({ report: `${deps.configPath} exists; kept as it is`, exitCode: 0 }) : deps.init()),
    },
    { title: 'Database', command: 'relay db create', run: deps.dbCreate },
    // The keychain trusts one helper build, so on macOS it is built before migrate stores anything.
    ...(deps.platform === 'darwin' ? [{ title: 'Secrets helper', command: 'relay install-service', run: () => deps.installService(false) }] : []),
    { title: 'Relay secrets', command: 'relay secrets migrate', run: deps.secretsMigrate },
    slackTokenStep(deps, SLACK_BOT_TOKEN_SECRET, 'Slack bot token', 'xoxb-'),
    slackTokenStep(deps, SLACK_APP_TOKEN_SECRET, 'Slack app-level token', 'xapp-'),
    {
      title: 'Repository',
      command: 'relay repos add <path>',
      async run() {
        const registered = deps.registeredRepos()
        if (registered.length > 0) return { report: `${registered.join(', ')} already registered`, exitCode: 0 }
        const path = deps.repo ?? (deps.interactive ? await deps.askLine('Repository Relay may work in', deps.cwd) : undefined)
        if (path === undefined) return { report: 'No repository is registered; pass --repo <path>', exitCode: 1 }
        return deps.reposAdd(path)
      },
    },
    {
      title: 'Supervisor',
      command: 'relay install-service --start',
      // The macOS helper rebuild above stops the daemon and removes its plist, so there it always runs.
      run: () =>
        deps.platform !== 'darwin' && deps.serviceInstalled()
          ? Promise.resolve({ report: 'already installed; run `relay install-service --start` to rewrite and restart it', exitCode: 0 })
          : deps.installService(true),
    },
    { title: 'Doctor', command: 'relay doctor', run: deps.doctor },
  ]
}

function indent(text: string): string {
  return text.split('\n').map((line) => (line === '' ? line : `  ${line}`)).join('\n')
}

/** Reads one line from the terminal without echoing it, for a token pasted at a prompt. */
export function promptHidden(question: string): Promise<string> {
  process.stdout.write(question)
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() })
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true })
  return new Promise((resolve) => {
    reader.question('', (answer) => {
      reader.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

/** Reads one visible line, returning `fallback` for an empty answer. */
export function promptLine(question: string, fallback: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    reader.question(`${question} [${fallback}]: `, (answer) => {
      reader.close()
      resolve(answer.trim() === '' ? fallback : answer.trim())
    })
  })
}
