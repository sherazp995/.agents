import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyAuditChain } from '../../src/audit/store.js'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { createPersona, editPersona, removePersona, type LibraryContext } from '../../src/projects/persona-library.js'
import { applyStarterTeam } from '../../src/projects/starter-team.js'
import { addMember, createProject, deleteProject, listMembers, listPersonas, projectFolderForChannel, updateMember } from '../../src/projects/store.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { getTestDatabaseUrl } from '../support/database.js'

describe('projects, the persona library and teams', () => {
  let pool: Pool

  beforeAll(async () => {
    const databaseUrl = await getTestDatabaseUrl()
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('refusing a non-test database')
    pool = createPool(databaseUrl)
    await applyMigrations(pool, 'src/db/migrations')
  })

  afterAll(async () => {
    await closePool(pool)
  })

  async function inTx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async function workspace(): Promise<{ workspaceId: string; ctx: LibraryContext }> {
    const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
    const dir = join(mkdtempSync(join(tmpdir(), 'relay-personas-')), 'personas')
    return { workspaceId, ctx: { pool, workspaceId, actor: 'prn_owner', dir, route: 'POST /test' } }
  }

  const project = (workspaceId: string, channel: string, name = 'Web') =>
    inTx((client) => createProject(client, workspaceId, { name, slackChannel: channel, folder: '/tmp', repos: ['web', 'web', 'api'] }))

  it('saves a project with its repos and finds its folder by channel; refuses a channel another project has', async () => {
    const { workspaceId } = await workspace()
    await project(workspaceId, 'C1')

    expect(await projectFolderForChannel(pool, workspaceId, 'C1')).toBe('/tmp')
    expect(await projectFolderForChannel(pool, workspaceId, 'C2')).toBeUndefined()
    await expect(project(workspaceId, 'C1', 'Other')).rejects.toThrow('already belongs to another project')
    // Another workspace may use the same channel id.
    const other = await workspace()
    await expect(project(other.workspaceId, 'C1')).resolves.toEqual(expect.any(String))
  })

  it('shares one persona across two projects\' teams and twice on one team, holds one lead per team, and refuses removing a persona in use', async () => {
    const { workspaceId, ctx } = await workspace()
    const web = await project(workspaceId, 'C1', 'Web')
    const api = await project(workspaceId, 'C2', 'Api')
    const dev = await createPersona(ctx, 'Developer', '# Dev')
    const lead = await createPersona(ctx, 'Lead', '# Lead')

    await inTx((client) => addMember(client, workspaceId, web, { name: 'Lead', role: 'lead', personaId: lead, isLead: true }))
    await inTx((client) => addMember(client, workspaceId, web, { name: 'Dev 1', role: 'developer', personaId: dev, isLead: false }))
    const second = await inTx((client) => addMember(client, workspaceId, web, { name: 'Dev 2', role: 'developer', personaId: dev, isLead: false }))
    await inTx((client) => addMember(client, workspaceId, api, { name: 'Dev', role: 'developer', personaId: dev, isLead: false }))

    await expect(inTx((client) => updateMember(client, workspaceId, web, second, { name: 'Dev 2', role: 'developer', personaId: dev, isLead: true }))).rejects.toThrow('already has a lead')
    expect((await listMembers(pool, workspaceId, web)).map((member) => [member.name, member.personaName, member.isLead])).toEqual([
      ['Lead', 'Lead', true],
      ['Dev 1', 'Developer', false],
      ['Dev 2', 'Developer', false],
    ])
    expect((await listPersonas(pool, workspaceId)).find((persona) => persona.id === dev)?.projects).toEqual(['Api', 'Web'])

    await expect(removePersona(ctx, dev)).rejects.toThrow('is on the team of Api, Web')
    // The database itself refuses it too, past the page's own check.
    await expect(pool.query('DELETE FROM personas WHERE id = $1', [dev])).rejects.toThrow('violates foreign key constraint')
    await inTx((client) => deleteProject(client, workspaceId, api))
    expect((await listPersonas(pool, workspaceId)).find((persona) => persona.id === dev)?.projects).toEqual(['Web'])
  })

  it('writes, edits and removes persona files with fixed names, out of git, and records each change in the audit chain', async () => {
    const { workspaceId, ctx } = await workspace()
    const id = await createPersona(ctx, 'Reviewer', '# Reviewer')
    const twin = await createPersona(ctx, 'Reviewer', '# Another reviewer')
    const fileOf = async (personaId: string) => (await listPersonas(pool, workspaceId)).find((persona) => persona.id === personaId)?.fileName ?? ''
    const first = await fileOf(id)
    const second = await fileOf(twin)
    expect(first).toMatch(/^reviewer-[0-9a-f]{6}\.md$/)
    expect(first).not.toBe(second)
    expect(readFileSync(join(ctx.dir, '.gitignore'), 'utf8')).toBe('*\n')

    await editPersona(ctx, id, 'Senior reviewer', '# Senior')
    const renamed = (await listPersonas(pool, workspaceId)).find((persona) => persona.id === id)
    expect(renamed).toMatchObject({ name: 'Senior reviewer' })
    // A rename never moves the file.
    expect(readFileSync(join(ctx.dir, renamed?.fileName ?? ''), 'utf8')).toBe('# Senior\n')

    await removePersona(ctx, twin)
    expect(existsSync(join(ctx.dir, second))).toBe(false)
    expect(await verifyAuditChain(pool, workspaceId)).toMatchObject({ intact: true, entries: 4 })
    const { rows } = await pool.query<{ outcome: string }>(`SELECT detail->>'outcome' AS outcome FROM audit_entries WHERE workspace_id = $1 ORDER BY sequence`, [workspaceId])
    expect(rows.map((row) => row.outcome)).toEqual(['persona created', 'persona created', 'persona saved', 'persona removed'])
  })

  it('starts a team from the template with five members, reusing starter personas already in the library', async () => {
    const { workspaceId, ctx } = await workspace()
    const web = await project(workspaceId, 'C1', 'Web')
    const api = await project(workspaceId, 'C2', 'Api')
    await createPersona(ctx, 'developer', '# My own developer')

    const first = await applyStarterTeam(ctx, web)
    const again = await applyStarterTeam(ctx, api)

    expect(first).toEqual({ personasMade: ['Lead', 'Reviewer', 'QA'], membersMade: ['Lead', 'Developer 1', 'Developer 2', 'Reviewer', 'QA'] })
    expect(again.personasMade).toEqual([])
    expect((await listPersonas(pool, workspaceId)).map((persona) => persona.name)).toEqual(['developer', 'Lead', 'QA', 'Reviewer'])
    expect((await listMembers(pool, workspaceId, api)).map((member) => member.personaName)).toEqual(['Lead', 'developer', 'developer', 'Reviewer', 'QA'])
  })

  it('stops the template at the first failure and says what it made', async () => {
    const { workspaceId, ctx } = await workspace()
    const web = await project(workspaceId, 'C1')
    const lead = await createPersona(ctx, 'Someone', '# Lead')
    await inTx((client) => addMember(client, workspaceId, web, { name: 'Lead', role: 'lead', personaId: lead, isLead: true }))

    const result = await applyStarterTeam(ctx, web)

    expect(result).toMatchObject({ personasMade: ['Lead', 'Developer', 'Reviewer', 'QA'], membersMade: [], error: expect.stringContaining('already has a lead') })
  })
})
