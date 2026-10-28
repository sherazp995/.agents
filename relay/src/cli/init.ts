/**
 * `relay init`, the setup wizard. FR-SET-1 through FR-SET-10, scoped to what
 * a fresh, config-less machine needs to reach a first task: starter config,
 * policy, and profiles files; a reviewed hard-blocked origin list; an honest
 * browser tier report per profile; guidance for storing Slack secrets in the
 * Keychain; and a closing `relay doctor` pass naming what is still missing.
 *
 * FR-SET-2 (dependency preflight), FR-SET-3 (macOS permission grants),
 * FR-SET-6 (repository enrolment), FR-SET-9 (launchd service), and FR-SET-21
 * (real smoke tests) are NOT implemented here: they need modules this file
 * does not own (doctor's own checks, the browser driver, the orchestrator).
 * `relay doctor`, run at the end of this wizard, already covers the
 * dependency and Slack-connectivity half of that list; the rest is later
 * milestone work.
 *
 * Everything a real terminal or a real clock touches is a parameter with a
 * production default, the same seam src/profiles/tiers.ts uses for `home`
 * and `platform`: a test exercises the exact logic this wizard runs, not a
 * simulation of it, without opening a real prompt or a real doctor pass.
 *
 * THE ONE RULE THIS FILE NEVER BREAKS: an existing config file is never
 * overwritten without --force or an explicit "yes" typed into a real
 * terminal. Destroying a working configuration is the worst thing a setup
 * command can do, so every write path funnels through writeStarterFile,
 * which is the only place `writeFile` is called for these three files.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { defaultConfigPath, defaultPolicyPath, defaultProfilesPath } from '../config/paths.js'

import { SLACK_APP_TOKEN_SECRET, SLACK_BOT_TOKEN_SECRET } from '../chat/slack/adapter.js'
import { ConfigError } from '../config/errors.js'
import { loadProfileRegistry } from '../config/load.js'
import type { CheckResult } from '../doctor/checks.js'
import { formatResults, runDoctor } from '../doctor/run.js'
import type { ProfileEntry, ProfileRegistry } from '../profiles/schema.js'
import { reportTierAvailability, validatePin } from '../profiles/tiers.js'

export const DEFAULT_CONFIG_PATH = defaultConfigPath()
export const DEFAULT_POLICY_PATH = defaultPolicyPath()
export const DEFAULT_PROFILES_PATH = defaultProfilesPath()
export const DEFAULT_PROFILES_EXAMPLE_PATH = 'config/profiles.example.yaml'

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
  # Claude Code session, run without the sandbox. Needs the policy budget.
  enabled: true
  # Reserved per turn before it starts, and charged when real usage is unknown.
  per_turn_fallback_usd: 1
  # Codex reports tokens, not dollars; cost is estimated at this rate.
  codex_usd_per_mtok: 10
  # Fixed charge for general-review's nested Codex lens.
  review_codex_allowance_usd: 2
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
 * The one place any of the three starter files is ever written. An existing
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

type ProfilesFileOutcome = { outcome: 'skipped' } | { outcome: 'declined' } | WriteResult

async function readExampleProfiles(examplePath: string): Promise<string> {
  try {
    return await readFile(examplePath, 'utf8')
  } catch {
    throw new Error(`relay init: could not read the worked example at ${examplePath} to copy it.`)
  }
}

/**
 * Resolves config/profiles.yaml. Distinct from writeStarterFile's own guard
 * for the case where the file does not exist yet: creating it is never
 * destructive, so nothing blocks it non-interactively, but copying placeholder
 * example data into a real config path unasked is still a judgement call, not
 * a neutral default, so it is opt-in non-interactively (--with-example-profiles)
 * and asked for interactively (default yes, since a human can edit it at once).
 * --skip-profiles leaves the path completely untouched either way; an existing
 * file there is still picked up by the tier report below regardless.
 */
async function resolveProfilesFile(
  path: string,
  examplePath: string,
  opts: {
    interactive: boolean
    force: boolean
    skip: boolean
    withExample: boolean
    confirm: (question: string, defaultValue: boolean) => Promise<boolean>
  },
): Promise<ProfilesFileOutcome> {
  if (opts.skip) return { outcome: 'skipped' }

  if (!existsSync(path)) {
    if (opts.interactive) {
      const copy = await opts.confirm(
        `No profile registry at ${path}. Copy the worked example so you can start enrolling browser profiles?`,
        true,
      )
      if (!copy) return { outcome: 'declined' }
    } else if (!opts.withExample) {
      return { outcome: 'declined' }
    }
    const exampleContent = await readExampleProfiles(examplePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, exampleContent, 'utf8')
    return { outcome: 'written', refusedNonInteractive: false }
  }

  const exampleContent = await readExampleProfiles(examplePath)
  return writeStarterFile(path, exampleContent, { interactive: opts.interactive, force: opts.force, confirm: opts.confirm })
}

function describeProfilesOutcome(path: string, outcome: ProfilesFileOutcome): string {
  if (outcome.outcome === 'skipped') return `skipped ${path}, per --skip-profiles.`
  if (outcome.outcome === 'declined') {
    return (
      `no profile registry written at ${path}. Every browser call is refused with a clear reason (FR-PRF-2), ` +
      'which is a safe state, not a broken one. Copy config/profiles.example.yaml there yourself, or run relay ' +
      'init again with --with-example-profiles, when you are ready to enrol one.'
    )
  }
  return describeFileOutcome(path, outcome)
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

type ProfileTierLine = { line: string; pinFailed: boolean }

function describeProfile(profile: ProfileEntry, home: string, platform: NodeJS.Platform): ProfileTierLine {
  if (profile.classification === 'personal') {
    return { line: `profile "${profile.name}" (personal): excluded from agent use, per FR-PRF-5.`, pinFailed: false }
  }

  const report = reportTierAvailability(profile, home, platform)
  const tierLines = report.tiers
    .map((entry) => `tier ${entry.tier} ${entry.available ? 'available' : 'unavailable'} (${entry.reason})`)
    .join('; ')

  if (profile.pinned_tier === undefined) {
    return { line: `profile "${profile.name}" (${profile.classification}): ${tierLines}.`, pinFailed: false }
  }

  const pin = validatePin(profile, home, platform)
  if (pin.ok) {
    return {
      line:
        `profile "${profile.name}" (${profile.classification}): ${tierLines}. ` +
        `Pinned to tier ${profile.pinned_tier}, honoured.`,
      pinFailed: false,
    }
  }
  return {
    line: `profile "${profile.name}" (${profile.classification}): ${tierLines}. PIN FAILURE: ${pin.reason}`,
    pinFailed: true,
  }
}

function describeProfileRegistry(
  registry: ProfileRegistry,
  home: string,
  platform: NodeJS.Platform,
): { lines: string[]; pinFailures: string[] } {
  if (registry.profiles.length === 0) {
    return {
      lines: ['no profiles configured yet. Every browser call is refused with a clear reason (FR-PRF-2), which is a safe state.'],
      pinFailures: [],
    }
  }
  const described = registry.profiles.map((profile) => describeProfile(profile, home, platform))
  return {
    lines: described.map((entry) => entry.line),
    pinFailures: described.filter((entry) => entry.pinFailed).map((entry) => entry.line),
  }
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
  profilesPath: string
  profilesExamplePath: string
  /** Never prompt; use flags and built-in defaults only. Always true when there is no real terminal, regardless of this flag. */
  yes: boolean
  force: boolean
  skipProfiles: boolean
  withExampleProfiles: boolean
  hardBlockedOrigins: string[]
  databaseUrl: string
  redisUrl: string
  /** Overrides TTY detection. Production leaves this unset; tests pin it so behaviour never depends on the test runner's own stdin. */
  isTTY?: boolean
  confirm?: (question: string, defaultValue: boolean) => Promise<boolean>
  promptLine?: (question: string) => Promise<string>
  now?: () => number
  home?: string
  platform?: NodeJS.Platform
  runDoctorFn?: DoctorRunner
}

export type InitResult = { report: string; exitCode: number }

/**
 * Runs the wizard once, start to finish, and returns its report and exit
 * code rather than writing to stdout itself, so the CLI action and a test
 * both call the same function the same way.
 *
 * EXIT CODE CONTRACT: 0 means the wizard completed its own job: the files it
 * owns are in a valid state and no invariant it enforces (a non-empty
 * hard-blocked list, an honourable tier pin) was violated. It does NOT mean
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
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform

  const sections: string[] = [
    'relay init: bootstraps config, policy, and profiles for a clean machine. Target is NFR-12, a first task ' +
      'inside 30 minutes.',
  ]
  let blocked = false

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

  const profilesOutcome = await resolveProfilesFile(options.profilesPath, options.profilesExamplePath, {
    interactive,
    force: options.force,
    skip: options.skipProfiles,
    withExample: options.withExampleProfiles,
    confirm,
  })
  sections.push(describeProfilesOutcome(options.profilesPath, profilesOutcome))

  // Whatever is at profilesPath now, freshly written or already there from
  // before, gets reported: FR-PRF-6a's whole point is learning the truth
  // about this machine at setup, not only about the file this run touched.
  if (existsSync(options.profilesPath)) {
    try {
      const registry = loadProfileRegistry(options.profilesPath)
      const { lines, pinFailures } = describeProfileRegistry(registry, home, platform)
      sections.push(['browser tier availability (FR-PRF-6a):', ...lines].join('\n'))
      if (pinFailures.length > 0) {
        blocked = true
        sections.push(
          ['relay init refuses to complete: the following pins cannot be honoured, per FR-PRF-4a.', ...pinFailures].join(
            '\n',
          ),
        )
      }
    } catch (error) {
      blocked = true
      const detail = error instanceof ConfigError ? error.reason : (error as Error).message
      sections.push(`profiles: ${options.profilesPath} could not be read: ${detail}`)
    }
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

  if (blocked) {
    sections.push('relay init did not complete. Fix the item(s) above and run it again.')
  }

  return { report: sections.join('\n\n'), exitCode: blocked ? 1 : 0 }
}
