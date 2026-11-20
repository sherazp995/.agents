import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { codexHomeOf, deleteCodexChatRecord, findOpenCodexChat, writeCodexChatRecord } from '../../src/live/open-codex.js'

const CHAT = '01a1f9b7-c23a-7fd1-879a-5c2da28c6dff'
const HOME = '/Users/me/.codex1'

function liveProcess(): number {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  onTestFinished(() => {
    child.kill()
  })
  if (child.pid === undefined) throw new Error('sleep did not start')
  return child.pid
}

describe('open Codex chat records', () => {
  it('finds a chat while its process lives, and not after it exits or once its record is deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-codex-chats-'))
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    const pid = child.pid ?? 0
    await writeCodexChatRecord({ chatId: CHAT, pid, codexHome: HOME }, { dir })

    expect(await findOpenCodexChat(CHAT, [HOME], { dir })).toMatchObject({ chatId: CHAT, pid, codexHome: HOME })

    await new Promise((resolve) => {
      child.on('exit', resolve)
      child.kill()
    })
    expect(await findOpenCodexChat(CHAT, [HOME], { dir })).toBeNull()

    await writeCodexChatRecord({ chatId: CHAT, pid: liveProcess(), codexHome: HOME }, { dir })
    await deleteCodexChatRecord(CHAT, { dir })
    expect(await findOpenCodexChat(CHAT, [HOME], { dir })).toBeNull()
  })

  it('does not take a process that reused the recorded id for the chat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-codex-chats-'))
    let started = 'Fri Nov 20 21:00:00 2026'
    const execFile = async () => ({ stdout: `${started}\n`, stderr: '' })
    await writeCodexChatRecord({ chatId: CHAT, pid: 4242, codexHome: HOME }, { dir, execFile })
    expect(await findOpenCodexChat(CHAT, [HOME], { dir, execFile })).not.toBeNull()

    started = 'Fri Nov 20 22:30:00 2026'
    expect(await findOpenCodexChat(CHAT, [HOME], { dir, execFile })).toBeNull()
  })

  it('refuses a record naming a login Relay does not know, and counts the default login as ~/.codex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-codex-chats-'))
    await writeCodexChatRecord({ chatId: CHAT, pid: liveProcess(), codexHome: '/tmp/someone-else' }, { dir })
    expect(await findOpenCodexChat(CHAT, [HOME, codexHomeOf(null)], { dir })).toBeNull()

    expect(codexHomeOf(null)).toBe(join(homedir(), '.codex'))
    await writeCodexChatRecord({ chatId: CHAT, pid: liveProcess(), codexHome: join(homedir(), '.codex') }, { dir })
    expect(await findOpenCodexChat(CHAT, [codexHomeOf(null)], { dir })).not.toBeNull()
  })
})
