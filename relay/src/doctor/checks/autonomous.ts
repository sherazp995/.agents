/**
 * Slack chats' setup, checked only when `autonomous.enabled` is on: the
 * CLIs and the account pool, a registered repository, and the codex hook
 * proof per codex account. The proof runs a real `codex exec` per account and records the
 * result in `<relayHome>/codex-eligibility.json`, which is the only thing
 * that lets the runtime use a codex account (src/autonomous/codex-probe.ts).
 *
 * The Slack `reactions:write` scope is checked by the slack check, which
 * compares every scope relay needs.
 */

import { accessSync, constants, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAccountPool } from '../../autonomous/accounts.js'
import { codexVersion, probeCodexAccount, readCodexEligibility, writeCodexEligibility, type CodexEligibility, type CodexEligibilityEntry } from '../../autonomous/codex-probe.js'
import { DEFAULT_CODEX_HOME } from '../../autonomous/turn-runner.js'
import { loadRepoRegistryIfPresent } from '../../config/load.js'
import { defaultReposPath, resolveRelayHome } from '../../config/paths.js'
import type { CheckResult } from '../checks.js'
import { registerCheck, type CheckContext } from '../registry.js'

const SETUP = 'autonomous-setup'
const CODEX_HOOK = 'autonomous-codex-hook'

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

registerCheck({
  name: SETUP,
  async run(ctx: CheckContext): Promise<CheckResult> {
    const autonomous = ctx.config.autonomous
    if (autonomous?.enabled !== true) return { name: SETUP, status: 'ok', detail: 'autonomous mode is off' }
    const problems: string[] = []
    const notes: string[] = []

    if (!executable(autonomous.claude_bin)) problems.push(`claude_bin ${autonomous.claude_bin} is not an executable file`)
    // Codex is optional: without it every chat runs on a claude account (src/autonomous/accounts.ts skips an unproven codex one).
    if (!executable(autonomous.codex_bin)) notes.push(`codex is not installed at ${autonomous.codex_bin}, so chats use claude only`)
    const accounts = await readAccountPool()
    if (!accounts.some((account) => account.client === 'claude')) problems.push('the account pool has no claude account (~/.agents/accounts.toml plus the default logins)')
    notes.push(`accounts: ${accounts.map((account) => account.key).join(', ') || 'none'}`)

    const reposPath = process.env.RELAY_REPOS_PATH ?? defaultReposPath()
    const repos = loadRepoRegistryIfPresent(reposPath).repos
    if (repos.length === 0) problems.push(`no repository is registered in ${reposPath}`)

    if (problems.length > 0) {
      return { name: SETUP, status: 'failed', detail: [...problems, ...notes].join('; '), remediation: 'Fix each item named, then re-run `relay doctor`.' }
    }
    return { name: SETUP, status: 'ok', detail: notes.join('; ') }
  },
})

/** Set by the doctor CLI test, which runs a build outside dist; the check then neither probes nor writes the saved proofs. */
export const SKIP_CODEX_PROOF_ENV = 'RELAY_DOCTOR_SKIP_CODEX_PROOF'

registerCheck({
  name: CODEX_HOOK,
  async run(ctx: CheckContext): Promise<CheckResult> {
    const autonomous = ctx.config.autonomous
    if (autonomous?.enabled !== true) return { name: CODEX_HOOK, status: 'ok', detail: 'autonomous mode is off' }
    const codexAccounts = (await readAccountPool()).filter((account) => account.client === 'codex')
    if (codexAccounts.length === 0) return { name: CODEX_HOOK, status: 'ok', detail: 'no codex account in the pool' }
    if (!executable(autonomous.codex_bin)) return { name: CODEX_HOOK, status: 'ok', detail: `codex is not installed at ${autonomous.codex_bin}; it is optional, so codex is not used` }
    // A build in another folder (the doctor CLI test's) has its own hook path, which codex has not trusted: proving it would
    // fail and save "not eligible" over the real proofs, which turns codex workers off until the next relay doctor.
    if (process.env[SKIP_CODEX_PROOF_ENV] === '1') return { name: CODEX_HOOK, status: 'ok', detail: `skipped: ${SKIP_CODEX_PROOF_ENV}=1, saved proofs left as they are` }

    // The compiled hook script sits beside this file's dist tree: dist/src/doctor/checks -> dist/scripts.
    const hookScript = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'hook-pretooluse.js')
    if (!existsSync(hookScript)) {
      return { name: CODEX_HOOK, status: 'degraded', detail: `the compiled hook ${hookScript} is missing, so no codex account was proven; codex is not used`, remediation: 'Run `pnpm build`, then `relay doctor`.' }
    }
    let version: string
    try {
      version = await codexVersion(autonomous.codex_bin)
    } catch (error) {
      return { name: CODEX_HOOK, status: 'degraded', detail: `${autonomous.codex_bin} --version failed (${(error as Error).message.split('\n')[0]}); codex is not used` }
    }

    const hookCommand = `'${process.execPath}' '${hookScript}'`
    const relayHome = resolveRelayHome().path
    const saved = await readCodexEligibility(relayHome)
    // A real codex turn per login takes about 20 seconds, so a passing proof made with this same codex version, hook command and
    // codex home is reused; a failed, new or changed login is probed. --recheck probes every login.
    const stillProven = (entry: CodexEligibilityEntry | undefined, codexHome: string): entry is CodexEligibilityEntry =>
      ctx.recheck !== true && entry?.eligible === true && entry.codexVersion === version && entry.hookCommand === hookCommand && entry.codexHome === codexHome
    // Each probe runs in its own codex home and temp folder, so they run side by side.
    const checked = await Promise.all(
      codexAccounts.map(async (account) => {
        const codexHome = account.configDir ?? DEFAULT_CODEX_HOME
        const previous = saved[account.key]
        if (stillProven(previous, codexHome)) return { key: account.key, entry: previous, reused: true }
        const entry = await probeCodexAccount({ account, codexBin: autonomous.codex_bin, version, hookCommand, codexHome })
        return { key: account.key, entry: { ...entry, hookCommand, codexHome }, reused: false }
      }),
    )
    // Reused entries are written back with the new ones: the file holds exactly the pool's current codex logins.
    const eligibility: CodexEligibility = Object.fromEntries(checked.map(({ key, entry }) => [key, entry]))
    await writeCodexEligibility(relayHome, eligibility)

    const describe = ({ key, entry, reused }: (typeof checked)[number]) =>
      reused ? `${key}: eligible (proven ${entry.checkedAt.slice(0, 16).replace('T', ' ')} UTC)` : `${key}: ${entry.eligible ? 'eligible' : 'not eligible'} (${entry.detail})`
    const allEligible = checked.every(({ entry }) => entry.eligible)
    const anyReused = checked.some(({ reused }) => reused)
    return {
      name: CODEX_HOOK,
      status: allEligible ? 'ok' : 'degraded',
      detail: `${version}. ${checked.map(describe).join('; ')}${anyReused ? '. Saved proofs reused; `relay doctor --recheck` probes again' : ''}`,
      ...(allEligible ? {} : { remediation: 'An account that is not eligible is never used for codex turns. Trust relay\'s hook in that codex home, or log it in, then re-run `relay doctor`.' }),
    }
  },
})
