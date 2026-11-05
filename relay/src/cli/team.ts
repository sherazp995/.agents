/**
 * `relay team`: run by a chat turn, every subcommand asks the daemon through
 * the turn's own hook bridge token (loopback only). `propose` asks for a
 * team for the channel's project; the others are the running team's
 * commands (src/teams/route.ts), where the daemon decides from the token
 * whether the caller is the lead or a member. This side only carries the
 * request and prints the answer.
 */

import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { TEAM_PATH } from '../teams/types.js'

export const OUTSIDE_A_TURN = "relay team propose only works inside a Relay turn in a project's Slack channel: ask Relay there to propose a team."

export type TeamProposeResult = { readonly exitCode: number; readonly message: string }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** What a `relay team` command prints and exits with. */
export type TeamCommandResult = { readonly exitCode: number; readonly message: string }

type Posted = { readonly kind: 'outside' } | { readonly kind: 'unreachable'; readonly message: string } | { readonly kind: 'answered'; readonly status: number; readonly answer: Record<string, unknown> | undefined }

/** Posts to a route on this turn's own hook bridge; the token goes only to a loopback daemon. */
async function postToRelay(path: string, body: unknown, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<Posted> {
  const hookUrl = env.RELAY_HOOK_URL
  const token = env.RELAY_HOOK_TOKEN
  if (hookUrl === undefined || hookUrl === '' || token === undefined || token === '') return { kind: 'outside' }
  let url: URL
  try {
    url = new URL(path, hookUrl)
  } catch {
    return { kind: 'outside' }
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return { kind: 'outside' }

  let response: Response
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  } catch (error) {
    return { kind: 'unreachable', message: `Could not reach Relay: ${error instanceof Error ? error.message : String(error)}` }
  }
  const answer = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  return { kind: 'answered', status: response.status, answer: typeof answer === 'object' && answer !== null ? answer : undefined }
}

export async function runTeamPropose(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<TeamProposeResult> {
  const posted = await postToRelay('/team-proposal', {}, env, fetchImpl)
  if (posted.kind === 'outside') return { exitCode: 1, message: OUTSIDE_A_TURN }
  if (posted.kind === 'unreachable') return { exitCode: 1, message: posted.message }
  const message = typeof posted.answer?.message === 'string' ? posted.answer.message : `Relay answered ${posted.status} with no message.`
  return { exitCode: posted.status >= 200 && posted.status < 300 && posted.answer?.ok === true ? 0 : 1, message }
}

export const SAFE_TO_RETRY = 'Relay is still working on it; it is safe to run the same command again.'

/** Any `relay team` command but propose: posts `{ command, ...body }` to the team route and renders the answer. */
export async function runTeamCommand(command: string, body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<TeamCommandResult> {
  const posted = await postToRelay(TEAM_PATH, { ...body, command }, env, fetchImpl)
  if (posted.kind === 'outside') return { exitCode: 1, message: `relay team ${command} only works inside a Relay team turn.` }
  if (posted.kind === 'unreachable') return { exitCode: 1, message: `${posted.message}. If it timed out, it is safe to run the same command again.` }
  if (posted.status === 504) return { exitCode: 1, message: `${typeof posted.answer?.message === 'string' ? `${posted.answer.message} ` : ''}${SAFE_TO_RETRY}` }
  const answer = posted.answer
  const message = typeof answer?.message === 'string' ? answer.message : `Relay answered ${posted.status} with no message.`
  const ok = posted.status >= 200 && posted.status < 300 && answer?.ok === true
  const details = answer === undefined ? [] : renderData(answer)
  return { exitCode: ok ? 0 : 1, message: [message, ...details].join('\n') }
}

/** The answer's data fields as indented readable lines (status already puts its list in the message). */
function renderData(answer: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(answer)) {
    if (key === 'ok' || key === 'message' || key === 'assignments' || value === null || value === undefined) continue
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${renderValue(item)}`)
    } else {
      lines.push(`${key}: ${renderValue(value)}`)
    }
  }
  return lines
}

function renderValue(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value)
  return Object.entries(value)
    .filter(([, inner]) => inner !== null && inner !== undefined)
    .map(([key, inner]) => `${key} ${typeof inner === 'object' ? JSON.stringify(inner) : String(inner)}`)
    .join(', ')
}

/** `relay team` and its subcommands. */
export function registerTeamCommands(program: Command): void {
  const teamCommand = program.command('team').description("A project's team of agents")

  teamCommand
    .command('propose')
    .description("Inside a Relay turn in a project's Slack channel: ask Relay to propose a team for that project; only the owner approves it")
    .action(async () => {
      const result = await runTeamPropose()
      ;(result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`)
      process.exitCode = result.exitCode
    })

  const send = async (command: string, body: Record<string, unknown>): Promise<void> => {
    const result = await runTeamCommand(command, body)
    ;(result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`)
    process.exitCode = result.exitCode
  }

  teamCommand
    .command('start')
    .description("Lead: start a team request: a build run gets a request worktree and branch; --pr reviews a PR and merges nothing")
    .requiredOption('--title <request>', 'the request, in a few words (names the branch)')
    .option('--repo <name>', "one of the project's repos, by name or alias; default: the project folder's repo")
    .option('--pr <number or url>', 'review this PR instead of building')
    .action(async (options: { title: string; repo?: string; pr?: string }) => send('start', { title: options.title, ...(options.repo === undefined ? {} : { repo: options.repo }), ...(options.pr === undefined ? {} : { pr: options.pr }) }))

  teamCommand
    .command('assign')
    .description('Lead: give a member a build, review or qa task')
    .requiredOption('--member <name>', 'the member, by name')
    .requiredOption('--kind <kind>', 'build, review or qa')
    .option('--brief <text>', 'the task')
    .option('--brief-file <path>', 'read the task from a file')
    .option('--key <key>', 'a key that makes a repeat add nothing (default: from member, kind and brief)')
    .action(async (options: { member: string; kind: string; brief?: string; briefFile?: string; key?: string }) => {
      if ((options.brief === undefined) === (options.briefFile === undefined)) {
        process.stderr.write('relay team assign: give exactly one of --brief or --brief-file.\n')
        process.exitCode = 1
        return
      }
      let brief: string
      try {
        brief = options.brief ?? readFileSync(options.briefFile as string, 'utf8')
      } catch (error) {
        process.stderr.write(`relay team assign: could not read ${options.briefFile}: ${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
        return
      }
      await send('assign', { member: options.member, kind: options.kind, brief, ...(options.key === undefined ? {} : { key: options.key }) })
    })

  teamCommand
    .command('answer')
    .description("Lead: answer a member's question or send it a follow-up")
    .requiredOption('--assignment <id>', 'the assignment')
    .requiredOption('--text <text>', 'the answer')
    .action(async (options: { assignment: string; text: string }) => send('answer', { assignment: options.assignment, text: options.text }))

  teamCommand
    .command('merge')
    .description("Lead: merge a done build assignment's commit into the request branch")
    .requiredOption('--assignment <id>', 'the assignment')
    .action(async (options: { assignment: string }) => send('merge', { assignment: options.assignment }))

  teamCommand
    .command('cancel')
    .description('Lead: cancel an assignment and stop its member')
    .requiredOption('--assignment <id>', 'the assignment')
    .action(async (options: { assignment: string }) => send('cancel', { assignment: options.assignment }))

  teamCommand
    .command('finish')
    .description('Lead: close the open team request; its worktrees are kept')
    .action(async () => send('finish', {}))

  teamCommand
    .command('status')
    .description("Lead: the team request's assignments, results and stale reviews")
    .action(async () => send('status', {}))

  teamCommand
    .command('ask-lead')
    .description('Member: ask the lead a question, then end your turn; the answer comes in your next turn')
    .requiredOption('--text <question>', 'the question')
    .action(async (options: { text: string }) => send('ask-lead', { text: options.text }))
}
