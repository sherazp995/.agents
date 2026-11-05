import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { wrapUntrusted } from '../../../src/agent/untrusted.js'
import type { ChatEvent } from '../../../src/chat/contract.js'
import { createLogger } from '../../../src/obs/logger.js'
import type { ChannelFolderLookup } from '../../../src/chat/slack/channel-folder.js'
import { ASK_AGAIN_TEXT, FolderQuestions, RESEND_TEXT, WAITING_TTL_MS, folderGate, questionText } from '../../../src/chat/slack/folder-questions.js'

const home = mkdtempSync(join(tmpdir(), 'relay-folder-questions-'))
mkdirSync(join(home, 'web'))
mkdirSync(join(home, "team's repo"))
const missing = join(home, 'not-here')
const request = { mode: 'direct', text: 'fix the build' } as const

function questions(found: ChannelFolderLookup, clock = { now: 0 }) {
  return new FolderQuestions({ lookup: async () => found, home, now: () => clock.now })
}

describe('FolderQuestions.forNewThread', () => {
  it('uses the description folder when it exists, and today\'s rules when there is none', async () => {
    expect(await questions({ kind: 'folder', path: join(home, 'web') }).forNewThread('C1:1', 'C1', 'P1', request)).toEqual({ kind: 'folder', path: join(home, 'web') })
    expect(await questions({ kind: 'none' }).forNewThread('C1:1', 'C1', 'P1', request)).toEqual({ kind: 'today' })
  })

  it('refuses to start when the description cannot be read, naming the reinstall for a missing scope', async () => {
    const scope = await questions({ kind: 'failed', missingScope: true }).forNewThread('C1:1', 'C1', 'P1', request)
    const other = await questions({ kind: 'failed', missingScope: false }).forNewThread('C1:1', 'C1', 'P1', request)
    expect(scope).toMatchObject({ kind: 'refused', text: expect.stringContaining('channels:read') })
    expect(other).toMatchObject({ kind: 'refused', text: expect.stringContaining('Mention me again') })
  })

  it('asks when the folder is missing, and the request waits', async () => {
    const folders = questions({ kind: 'folder', path: missing })
    expect(await folders.forNewThread('C1:1', 'C1', 'P1', request)).toEqual({ kind: 'asked', text: questionText(missing) })
    expect(folders.isWaiting('C1:1')).toBe(true)
    expect(folders.isWaiting('C1:2')).toBe(false)
  })
})

describe('FolderQuestions.forNewThread for a project channel', () => {
  function projectQuestions(projectFolder: string | undefined, lookups: string[]) {
    return new FolderQuestions({
      lookup: async (channel) => {
        lookups.push(channel)
        return { kind: 'folder', path: join(home, "team's repo") }
      },
      projectFolder: async (channel) => (channel === 'C1' ? projectFolder : undefined),
      home,
      now: () => 0,
    })
  }

  it("uses the project's folder over the description, and leaves other channels to the description", async () => {
    const lookups: string[] = []
    const folders = projectQuestions(join(home, 'web'), lookups)
    expect(await folders.forNewThread('C1:1', 'C1', 'P1', request)).toEqual({ kind: 'folder', path: join(home, 'web') })
    expect(lookups).toEqual([])
    expect(await folders.forNewThread('C2:1', 'C2', 'P1', request)).toEqual({ kind: 'folder', path: join(home, "team's repo") })
    expect(lookups).toEqual(['C2'])
  })

  it("asks about a project folder that no longer exists, naming the project, and the requester's answer still wins", async () => {
    const folders = projectQuestions(missing, [])
    expect(await folders.forNewThread('C1:1', 'C1', 'P1', request)).toEqual({ kind: 'asked', text: questionText(missing, 'project') })
    expect(questionText(missing, 'project')).toContain('project (set up in relay ui)')
    expect(folders.answer('C1:1', 'P1', '~/web')).toEqual({ kind: 'claimed', request, folder: join(home, 'web') })
  })
})

describe('FolderQuestions.answer', () => {
  async function waiting(clock = { now: 0 }) {
    const folders = questions({ kind: 'folder', path: missing }, clock)
    await folders.forNewThread('C1:1', 'C1', 'P1', request)
    return folders
  }

  it('claims the request once for the requester\'s folder', async () => {
    const folders = await waiting()
    expect(folders.answer('C1:1', 'P1', '<@UBOT> use ~/web')).toEqual({ kind: 'claimed', request, folder: join(home, 'web') })
    expect(folders.answer('C1:1', 'P1', '~/web')).toEqual({ kind: 'not_waiting' })
  })

  it('reads an answer with the description grammar: a quoted path with an apostrophe, or `~/` alone', async () => {
    const quoted = await waiting()
    expect(quoted.answer('C1:1', 'P1', `use "~/team's repo"`)).toMatchObject({ kind: 'claimed', folder: join(home, "team's repo") })
    const homeOnly = new FolderQuestions({ lookup: async () => ({ kind: 'folder', path: missing }), home, now: () => 0 })
    await homeOnly.forNewThread('C1:1', 'C1', 'P1', request)
    expect(homeOnly.answer('C1:1', 'P1', '~/')).toMatchObject({ kind: 'claimed', folder: home })
  })

  it('asks again for a reply with no existing folder, and ignores anyone else', async () => {
    const folders = await waiting()
    expect(folders.answer('C1:1', 'P1', 'try ~/nope')).toEqual({ kind: 'ask_again', text: ASK_AGAIN_TEXT })
    expect(folders.answer('C1:1', 'P2', '~/web')).toEqual({ kind: 'ignored' })
    expect(folders.isWaiting('C1:1')).toBe(true)
  })

  it('forgets the request on stop or after 24 hours', async () => {
    const stopped = await waiting()
    expect(stopped.cancel('C1:1', 'P2')).toBe(false)
    expect(stopped.cancel('C1:1', 'P1')).toBe(true)
    expect(stopped.cancel('C1:1', 'P1')).toBe(false)

    const clock = { now: 0 }
    const expired = await waiting(clock)
    clock.now = WAITING_TTL_MS - 1
    expect(expired.isWaiting('C1:1')).toBe(true)
    clock.now = WAITING_TTL_MS
    expect(expired.answer('C1:1', 'P1', '~/web')).toEqual({ kind: 'not_waiting' })
  })
})

describe('folderGate, starting an answered autonomous request', () => {
  const event = (id: string, text: string) => ({ platformEventId: id, text: wrapUntrusted(text), ref: { channel: 'C1', message: id } }) as unknown as ChatEvent

  async function answered(route: (event: ChatEvent) => Promise<'handled' | 'not_autonomous'>) {
    const questions = new FolderQuestions({ lookup: async () => ({ kind: 'folder', path: missing }), home })
    await questions.forNewThread('C1:1', 'C1', 'P1', { mode: 'autonomous', event: event('ask', 'fix it') })
    const posts: string[] = []
    const deps = { questions, post: async (text: string) => posts.push(text), routeAutonomous: route, startDirect: async () => {}, log: createLogger('fatal') }
    await folderGate(deps, event('answer', '~/web'), 'C1:1', 'P1')
    return posts
  }

  it('does not ask for a resend once the task exists, even if the answer cannot join it', async () => {
    const posts = await answered(async (routed) => {
      if (routed.platformEventId === 'answer') throw new Error('intake failed')
      return 'handled'
    })
    expect(posts).toEqual([])
  })

  it('says what to do when the original request could not start', async () => {
    const thrown = await answered(async () => {
      throw new Error('intake failed')
    })
    const refused = await answered(async () => 'not_autonomous')
    expect(thrown).toEqual([expect.stringContaining('Check whether it ran before sending it again')])
    expect(refused).toEqual([expect.stringContaining(RESEND_TEXT)])
  })
})
