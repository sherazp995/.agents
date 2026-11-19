import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runChannelFolder, type ChannelFolderDeps } from '../../src/cli/channel.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { listProjects, projectFolderForChannel } from '../../src/projects/store.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('relay channel folder', () => {
  let pool: Pool
  let deps: ChannelFolderDeps

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
    deps = { pool, isFolder: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true }
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function workspace(): Promise<string> {
    return resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
  }

  function folder(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), 'relay-channel-')))
  }

  it('sets, shows, moves and clears the folder on a project made for the channel', async () => {
    const ws = await workspace()
    const first = folder()
    const second = folder()

    expect(await runChannelFolder({ channel: 'C0123ABC', clear: false, workspaceId: ws }, deps)).toMatchObject({ exitCode: 0, message: expect.stringContaining('no folder stored') })

    const created = await runChannelFolder({ channel: 'C0123ABC', folder: `${first}/`, clear: false, workspaceId: ws }, deps)
    expect(created.message).toContain('Made a project named C0123ABC')
    expect(await listProjects(pool, ws)).toEqual([expect.objectContaining({ name: 'C0123ABC', slackChannel: 'C0123ABC', folder: first })])
    expect(await projectFolderForChannel(pool, ws, 'C0123ABC')).toBe(first)

    const moved = await runChannelFolder({ channel: 'C0123ABC', folder: second, clear: false, workspaceId: ws }, deps)
    expect(moved.message).not.toContain('Made a project')
    expect(await runChannelFolder({ channel: 'C0123ABC', clear: false, workspaceId: ws }, deps)).toEqual({ exitCode: 0, message: second })
    expect(await listProjects(pool, ws)).toHaveLength(1)

    expect(await runChannelFolder({ channel: 'C0123ABC', clear: true, workspaceId: ws }, deps)).toMatchObject({ exitCode: 0 })
    expect(await listProjects(pool, ws)).toEqual([])
    expect(await runChannelFolder({ channel: 'C0123ABC', clear: true, workspaceId: ws }, deps)).toMatchObject({ exitCode: 1, message: expect.stringContaining('nothing was cleared') })
  })

  it('updates a project made on the setup page, and refuses to clear it rather than delete it', async () => {
    const ws = await workspace()
    const original = folder()
    const next = folder()
    await pool.query("INSERT INTO projects (workspace_id, name, slack_channel, folder) VALUES ($1, 'Web app', 'C0WEB', $2)", [ws, original])

    expect((await runChannelFolder({ channel: 'C0WEB', folder: next, clear: false, workspaceId: ws }, deps)).exitCode).toBe(0)
    const cleared = await runChannelFolder({ channel: 'C0WEB', clear: true, workspaceId: ws }, deps)

    expect(cleared).toMatchObject({ exitCode: 1, message: expect.stringContaining('belongs to the project "Web app"') })
    expect(await listProjects(pool, ws)).toEqual([expect.objectContaining({ name: 'Web app', folder: next })])
  })

  it('refuses a DM or malformed id and a folder missing on this laptop, writing nothing', async () => {
    const ws = await workspace()

    expect(await runChannelFolder({ channel: 'D0123ABC', folder: folder(), clear: false, workspaceId: ws }, deps)).toMatchObject({ exitCode: 1, message: expect.stringContaining('not a Slack channel id') })
    expect(await runChannelFolder({ channel: 'C0123ABC', folder: '/no/such/relay/folder', clear: false, workspaceId: ws }, deps)).toEqual({
      exitCode: 1,
      message: '/no/such/relay/folder is not a folder on this laptop.',
    })
    expect(await listProjects(pool, ws)).toEqual([])
  })
})
