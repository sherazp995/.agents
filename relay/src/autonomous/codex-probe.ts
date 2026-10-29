/**
 * Codex eligibility: a codex account is used only after relay has proved,
 * on that account and that codex version, that relay's PreToolUse hook is
 * trusted and active. The proof is a real `codex exec` against a probe
 * bridge: the hook must deny `git merge`, let `true` run, and the stream
 * must report usage (so the budget can meter it). Codex skips an untrusted
 * hook silently, so without this proof a codex worker would run ungated.
 *
 * The doctor writes the results to `<relayHome>/codex-eligibility.json`;
 * the runtime reads them and treats a different codex version as unproven.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HookBridgeServer } from '../engine/hook-bridge.js'
import type { Account } from './accounts.js'
import { buildCodexHookOverrides } from './worker-config.js'

const execFileAsync = promisify(execFile)

const PROBE_TIMEOUT_MS = 180_000
const PROBE_PROMPT =
  'This is an automated hook check. Run the shell command `git merge relay-probe` once (it will be refused; do not retry it), ' +
  'then run the shell command `true`, then reply with the single word done.'

export type CodexEligibilityEntry = { eligible: boolean; codexVersion: string; checkedAt: string; detail: string }
export type CodexEligibility = Record<string, CodexEligibilityEntry>

export function codexEligibilityPath(relayHome: string): string {
  return join(relayHome, 'codex-eligibility.json')
}

export async function readCodexEligibility(relayHome: string): Promise<CodexEligibility> {
  try {
    const parsed = JSON.parse(await readFile(codexEligibilityPath(relayHome), 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as CodexEligibility) : {}
  } catch {
    return {}
  }
}

export async function writeCodexEligibility(relayHome: string, eligibility: CodexEligibility): Promise<void> {
  await writeFile(codexEligibilityPath(relayHome), `${JSON.stringify(eligibility, null, 2)}\n`, { mode: 0o600 })
}

/** Proven for this account on exactly this codex version. */
export function isProvenEligible(eligibility: CodexEligibility, accountKey: string, codexVersion: string): boolean {
  const entry = eligibility[accountKey]
  return entry?.eligible === true && entry.codexVersion === codexVersion
}

export async function codexVersion(codexBin: string): Promise<string> {
  return (await execFileAsync(codexBin, ['--version'], { encoding: 'utf8', timeout: 15_000 })).stdout.trim()
}

/** Commands the probe saw, from the hook payload's tool input. */
function commandOf(toolInput: unknown): string {
  if (typeof toolInput !== 'object' || toolInput === null) return ''
  const command = (toolInput as { command?: unknown }).command
  if (typeof command === 'string') return command
  if (Array.isArray(command)) return command.map(String).join(' ')
  return ''
}

export async function probeCodexAccount(params: {
  account: Account
  codexBin: string
  version: string
  hookCommand: string
  codexHome: string
  timeoutMs?: number
}): Promise<CodexEligibilityEntry> {
  const seen: { command: string; decision: 'allow' | 'deny' }[] = []
  const bridge = new HookBridgeServer({
    async decide(request) {
      const command = commandOf(request.toolInput)
      const decision = /\bgit\s+merge\b/.test(command) ? 'deny' : 'allow'
      seen.push({ command, decision })
      return { decision, reason: decision === 'deny' ? 'relay hook probe: merge refused' : 'relay hook probe' }
    },
  })
  await bridge.start()
  const dir = await mkdtemp(join(tmpdir(), 'relay-codex-probe-'))
  const token = bridge.issueToken({ workspaceId: 'probe', taskId: 'probe', runId: 'probe', leaseGeneration: 0 })
  const entry = (eligible: boolean, detail: string): CodexEligibilityEntry => ({ eligible, codexVersion: params.version, checkedAt: new Date().toISOString(), detail })
  try {
    let stdout = ''
    try {
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...buildCodexHookOverrides({ hookCommand: params.hookCommand }).flatMap((override) => ['-c', override]), PROBE_PROMPT]
      const running = execFileAsync(params.codexBin, args, {
        cwd: dir,
        encoding: 'utf8',
        timeout: params.timeoutMs ?? PROBE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...params.account.env, CODEX_HOME: params.codexHome, RELAY_HOOK_URL: bridge.url, RELAY_HOOK_TOKEN: token },
      })
      // codex exec reads a piped stdin to its end before starting, so an open pipe would hang it until the timeout.
      running.child.stdin?.end()
      stdout = (await running).stdout
    } catch (error) {
      stdout = String((error as { stdout?: unknown }).stdout ?? '')
      if (stdout === '') return entry(false, `codex exec failed: ${(error as Error).message.split('\n')[0]}`)
    }
    const deniedMerge = seen.some((call) => call.decision === 'deny')
    const ranTrue = seen.some((call) => call.decision === 'allow' && /(^|[\s;'"])true($|[\s;'"])/.test(call.command))
    const usage = stdout.split('\n').some((line) => line.includes('"usage"'))
    if (!deniedMerge || !ranTrue) return entry(false, `the hook did not gate the probe commands (saw ${seen.length} hook call(s)); codex likely skipped an untrusted hook`)
    if (!usage) return entry(false, 'the hook works, but the codex stream reported no usage, so the budget could not meter it')
    return entry(true, 'the hook denied git merge, allowed true, and the stream reported usage')
  } finally {
    bridge.revokeToken(token)
    await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
}
