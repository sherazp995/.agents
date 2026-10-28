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
import { codexVersion, probeCodexAccount, writeCodexEligibility, type CodexEligibility } from '../../autonomous/codex-probe.js'
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

    for (const [label, bin] of [['claude_bin', autonomous.claude_bin], ['codex_bin', autonomous.codex_bin]] as const) {
      if (!executable(bin)) problems.push(`${label} ${bin} is not an executable file`)
    }
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

registerCheck({
  name: CODEX_HOOK,
  async run(ctx: CheckContext): Promise<CheckResult> {
    const autonomous = ctx.config.autonomous
    if (autonomous?.enabled !== true) return { name: CODEX_HOOK, status: 'ok', detail: 'autonomous mode is off' }
    const codexAccounts = (await readAccountPool()).filter((account) => account.client === 'codex')
    if (codexAccounts.length === 0) return { name: CODEX_HOOK, status: 'ok', detail: 'no codex account in the pool' }

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
    const eligibility: CodexEligibility = {}
    for (const account of codexAccounts) {
      eligibility[account.key] = await probeCodexAccount({ account, codexBin: autonomous.codex_bin, version, hookCommand, codexHome: account.configDir ?? DEFAULT_CODEX_HOME })
    }
    await writeCodexEligibility(resolveRelayHome().path, eligibility)

    const lines = Object.entries(eligibility).map(([key, entry]) => `${key}: ${entry.eligible ? 'eligible' : 'not eligible'} (${entry.detail})`)
    const allEligible = Object.values(eligibility).every((entry) => entry.eligible)
    return {
      name: CODEX_HOOK,
      status: allEligible ? 'ok' : 'degraded',
      detail: `${version}. ${lines.join('; ')}`,
      ...(allEligible ? {} : { remediation: 'An account that is not eligible is never used for codex turns. Trust relay\'s hook in that codex home, or log it in, then re-run `relay doctor`.' }),
    }
  },
})
