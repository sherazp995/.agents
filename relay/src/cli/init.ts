/**
 * `relay init`, the setup wizard. FR-SET-1 through FR-SET-10, scoped to what
 * a fresh, config-less machine needs to reach a first task: starter config
 * and policy files; a reviewed hard-blocked origin list; guidance for storing
 * Slack secrets in the Keychain; and a closing `relay doctor` pass naming
 * what is still missing.
 *
 * FR-SET-2 (dependency preflight), FR-SET-3 (macOS permission grants),
 * FR-SET-6 (repository enrolment), FR-SET-9 (launchd service), and FR-SET-21
 * (real smoke tests) are NOT implemented here: they need modules this file
 * does not own (doctor's own checks, the orchestrator).
 * `relay doctor`, run at the end of this wizard, already covers the
 * dependency and Slack-connectivity half of that list; the rest is later
 * milestone work.
 *
 * Everything a real terminal or a real clock touches is a parameter with a
 * production default: a test exercises the exact logic this wizard runs, not a
 * simulation of it, without opening a real prompt or a real doctor pass.
 *
 * THE ONE RULE THIS FILE NEVER BREAKS: an existing config file is never
 * overwritten without --force or an explicit "yes" typed into a real
 * terminal. Destroying a working configuration is the worst thing a setup
 * command can do, so every write path funnels through writeStarterFile,
 * which is the only place `writeFile` is called for these files.
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { defaultConfigPath, defaultPolicyPath } from '../config/paths.js'

import { SLACK_APP_TOKEN_SECRET, SLACK_BOT_TOKEN_SECRET } from '../chat/slack/adapter.js'
import type { CheckResult } from '../doctor/checks.js'
import { formatResults, runDoctor } from '../doctor/run.js'

export const DEFAULT_CONFIG_PATH = defaultConfigPath()
export const DEFAULT_POLICY_PATH = defaultPolicyPath()

// The system's own Postgres and Redis (Homebrew services on their default
// ports), matching this repository's committed config/relay.config.yaml.
// Redis database 13 keeps relay's keys apart from other apps on the same
// server.
export const DEFAULT_DATABASE_URL = 'postgres://relay:relay@localhost:5432/relay'
export const DEFAULT_REDIS_URL = 'redis://localhost:6379/13'

/** The categories the committed config/policy.yaml already ships with. FR-SET-7's "proposes the default categories" starting point, reviewed and extended, never replaced. */
export const DEFAULT_HARD_BLOCKED_ORIGINS: readonly string[] = [
  '*.chase.com',
  '*.coinbase.com',
  'console.aws.amazon.com',
  '*.1password.com',
]

/**
 * Combines the built-in defaults with operator-supplied additions, never a
 * replacement. `base` is a parameter, not a direct reference to
 * DEFAULT_HARD_BLOCKED_ORIGINS inside the function body, so a test can drive
 * the empty-list guard below without depending on that constant staying
 * non-empty forever. Every real call site in this file uses the default.
 *
 * Because the only way to grow this list through runInit's own option
 * surface is addition, an operator cannot empty it out from under FR-SET-7
 * by construction; the throw below is defence in depth for that guarantee,
 * not the primary mechanism.
 */
export function mergeHardBlockedOrigins(
  extra: readonly string[],
  base: readonly string[] = DEFAULT_HARD_BLOCKED_ORIGINS,
): string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const origin of [...base, ...extra]) {
    const trimmed = origin.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(trimmed)
  }
  if (merged.length === 0) {
    throw new Error(
      'relay init: refusing to complete with an empty hard-blocked origin list. Setup cannot complete with an ' +
        'empty hard_blocked_origins, per FR-SET-7.',
    )
  }
  return merged
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function renderConfigYaml(databaseUrl: string, redisUrl: string): string {
  return `# Relay runtime configuration, written by relay init.
# Re-run relay init any time. It never overwrites this file without --force
# or your explicit confirmation in a terminal.

model_provider:
  name: anthropic
  # FR-DATA-6: retention must be asserted, not assumed. Confirm your
  # Anthropic account has zero data retention before this stays true.
  zero_data_retention: true
database:
  url: ${databaseUrl}
redis:
  url: ${redisUrl}
logging:
  level: info
autonomous:
  # Every Slack conversation runs as an autonomous task: one thread is one
  # Claude Code chat, run without the sandbox.
  enabled: true
secrets:
  # FR-SEC-2 and FR-SLA-6: the only provider production config may name.
  # Secrets live in the macOS Keychain, never in this file. relay init
  # prints exactly what to store and how; see its secrets section.
  provider: keychain
`
}

function renderPolicyYaml(hardBlockedOrigins: readonly string[]): string {
  const origins = hardBlockedOrigins.map((origin) => `  - ${yamlSingleQuoted(origin)}`).join('\n')
  return `# Relay policy, written by relay init.
version: 1
defaults:
  unmatched: ask
# FR-POL-4: this list cannot be overridden at runtime. Editing it requires a
# restart. FR-SET-7: relay init refuses to complete with it empty, and only
# ever adds to it, never removes an entry, so re-running init cannot shrink it.
hard_blocked_origins:
${origins}
# FR-POL-7 spend caps in dollars. Required by autonomous mode, which
# relay.config.yaml turns on by default.
budget:
  run_cap_usd: 5
  session_cap_usd: 20
  principal_day_cap_usd: 50
`
}

function renderSecretsGuidance(): string {
  return [
    'Slack credentials, FR-SET-4 and FR-SET-8: relay never asks for a token here, and never writes one to a ' +
      'file, a log, or shell history.',
    'Store them yourself, directly in the macOS Keychain, using the exact service names relay reads:',
    '',
    `  security add-generic-password -a "$USER" -s ${SLACK_BOT_TOKEN_SECRET} -U -w`,
    `  security add-generic-password -a "$USER" -s ${SLACK_APP_TOKEN_SECRET} -U -w`,
    '',
    "Leave -w as the very last thing on the line. security then prompts for the value on a hidden line instead " +
      "of taking it as an argument, so the token never appears in this terminal's history or in relay's own " +
      'process list.',
    '-U updates the item in place if you are rotating an existing token rather than storing one for the first time.',
    'Run relay doctor afterward. It confirms the token is present and accepted, and it never prints the value itself.',
  ].join('\n')
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

type FileOutcome = 'written' | 'overwritten' | 'kept-existing'

type WriteResult = { outcome: FileOutcome; refusedNonInteractive: boolean }

/**
 * The one place either starter file is ever written. An existing
 * file is left untouched unless --force was given, or (only when a real
 * terminal is present) the operator confirms an explicit overwrite prompt.
 * Non-interactively, an existing file without --force is reported and left
 * alone rather than blocking the rest of the wizard: the operator's own
 * configuration is respected, not treated as an obstacle.
 */
async function writeStarterFile(
  path: string,
  content: string,
  opts: { interactive: boolean; force: boolean; confirm: (question: string, defaultValue: boolean) => Promise<boolean> },
): Promise<WriteResult> {
  const exists = existsSync(path)
  if (!exists) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return { outcome: 'written', refusedNonInteractive: false }
  }
  if (opts.force) {
    await writeFile(path, content, 'utf8')
    return { outcome: 'overwritten', refusedNonInteractive: false }
  }
  if (!opts.interactive) {
    return { outcome: 'kept-existing', refusedNonInteractive: true }
  }
  const proceed = await opts.confirm(`${path} already exists. Overwrite it with a fresh starter?`, false)
  if (!proceed) return { outcome: 'kept-existing', refusedNonInteractive: false }
  await writeFile(path, content, 'utf8')
  return { outcome: 'overwritten', refusedNonInteractive: false }
}

function describeFileOutcome(path: string, outcome: WriteResult): string {
  if (outcome.outcome === 'written') return `wrote ${path}`
  if (outcome.outcome === 'overwritten') return `overwrote ${path} with a fresh starter`
  return outcome.refusedNonInteractive
    ? `kept the existing ${path} untouched. It already exists and --force was not given, so relay init never ` +
        'overwrites it without a terminal to confirm in. Pass --force to replace it, or run relay init in a ' +
        'terminal and confirm the prompt.'
    : `kept the existing ${path} untouched, as you confirmed.`
}

async function resolveHardBlockedOrigins(
  extra: readonly string[],
  opts: { interactive: boolean; promptLine: (question: string) => Promise<string> },
): Promise<string[]> {
  let additions = [...extra]
  if (opts.interactive) {
    const raw = await opts.promptLine(
      `Hard-blocked origins, always refused regardless of approval (FR-SET-7). Currently: ` +
        `${DEFAULT_HARD_BLOCKED_ORIGINS.join(', ')}. Add more, comma separated, or press Enter to keep these:`,
    )
    if (raw.length > 0) {
      additions = [...additions, ...raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)]
    }
  }
  return mergeHardBlockedOrigins(additions)
}

async function defaultConfirm(question: string, defaultValue: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultValue ? '(Y/n)' : '(y/N)'
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase()
    if (answer.length === 0) return defaultValue
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

async function defaultPromptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(`${question} `)).trim()
  } finally {
    rl.close()
  }
}

export type DoctorRunner = (options: {
  configPath: string
  policyPath: string
}) => Promise<{ results: CheckResult[]; exitCode: number }>

export type InitOptions = {
  configPath: string
  policyPath: string
  /** Never prompt; use flags and built-in defaults only. Always true when there is no real terminal, regardless of this flag. */
  yes: boolean
  force: boolean
  hardBlockedOrigins: string[]
  databaseUrl: string
  redisUrl: string
  /** Overrides TTY detection. Production leaves this unset; tests pin it so behaviour never depends on the test runner's own stdin. */
  isTTY?: boolean
  confirm?: (question: string, defaultValue: boolean) => Promise<boolean>
  promptLine?: (question: string) => Promise<string>
  now?: () => number
  runDoctorFn?: DoctorRunner
}

export type InitResult = { report: string; exitCode: number }

/**
 * Runs the wizard once, start to finish, and returns its report and exit
 * code rather than writing to stdout itself, so the CLI action and a test
 * both call the same function the same way.
 *
 * EXIT CODE CONTRACT: 0 means the wizard completed its own job: the files it
 * owns are in a valid state and the invariant it enforces (a non-empty
 * hard-blocked list) was not violated. It does NOT mean
 * the machine is fully ready to run a task; `relay doctor`'s own exit code,
 * printed in the report below, is what answers that. Tying relay init's own
 * exit code to Postgres or Redis being reachable right now would fail a
 * perfectly correct config just because `docker compose up -d` has not run
 * yet, which is not this wizard's job to demand.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const interactive = !options.yes && (options.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true))
  const confirm = options.confirm ?? defaultConfirm
  const promptLine = options.promptLine ?? defaultPromptLine
  const runDoctorImpl = options.runDoctorFn ?? runDoctor

  const sections: string[] = [
    'relay init: bootstraps config and policy for a clean machine. Target is NFR-12, a first task ' +
      'inside 30 minutes.',
  ]

  const configOutcome = await writeStarterFile(options.configPath, renderConfigYaml(options.databaseUrl, options.redisUrl), {
    interactive,
    force: options.force,
    confirm,
  })
  sections.push(describeFileOutcome(options.configPath, configOutcome))

  let hardBlockedOrigins: string[]
  try {
    hardBlockedOrigins = await resolveHardBlockedOrigins(options.hardBlockedOrigins, { interactive, promptLine })
  } catch (error) {
    sections.push((error as Error).message)
    return { report: sections.join('\n\n'), exitCode: 1 }
  }
  const policyOutcome = await writeStarterFile(options.policyPath, renderPolicyYaml(hardBlockedOrigins), {
    interactive,
    force: options.force,
    confirm,
  })
  sections.push(describeFileOutcome(options.policyPath, policyOutcome))
  if (policyOutcome.outcome === 'written' || policyOutcome.outcome === 'overwritten') {
    sections.push(`hard-blocked origins written (FR-SET-7): ${hardBlockedOrigins.join(', ')}`)
  }

  sections.push(renderSecretsGuidance())

  const { results, exitCode: doctorExitCode } = await runDoctorImpl({
    configPath: options.configPath,
    policyPath: options.policyPath,
  })
  sections.push(formatResults(results))
  if (doctorExitCode !== 0) {
    sections.push(
      'relay doctor reports open items above. relay init does not fail on them: each one is a dependency or ' +
        'connectivity gap with its own next command, not a wizard invariant.',
    )
  }

  sections.push(
    `relay init finished its own steps in ${formatElapsed(now() - startedAt)}. This measures the wizard only, ` +
      'not the full NFR-12 time to a first successful task.',
  )

  return { report: sections.join('\n\n'), exitCode: 0 }
}
