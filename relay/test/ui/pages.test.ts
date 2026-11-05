import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { getTestDatabaseUrl } from '../support/database.js'
import { insertAssignment } from '../../src/teams/store.js'
import { openRun, teamFixture } from '../teams/fixture.js'
import { uiHarness, type Harness } from './harness.js'

describe('the setup pages: projects table, project hub and persona library', () => {
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

  async function withOwner(work: (h: Harness, session: { cookie: string; csrf: string }) => Promise<void>): Promise<void> {
    const h = await uiHarness(pool)
    try {
      await work(h, await h.login())
    } finally {
      await h.server.close()
    }
  }

  async function setUp(h: Harness, { cookie, csrf }: { cookie: string; csrf: string }) {
    const project = String((await h.send('POST', '/projects', { cookie, form: { csrf, name: 'Web', slack_channel: 'C1', folder: '/srv/web', repos: 'web' } })).headers.location)
    const personaId = String((await h.send('POST', '/personas', { cookie, form: { csrf, name: 'Dev', text: 'Write <tests> first.' } })).headers.location).split('/').pop() ?? ''
    const add = (form: Record<string, string>) => h.send('POST', `${project}/team/members`, { cookie, form: { csrf, persona_id: personaId, ...form } })
    return { project, personaId, add }
  }

  const members = async (workspaceId: string) =>
    (await pool.query<{ name: string; role: string; is_lead: boolean }>('SELECT name, role, is_lead FROM team_members WHERE workspace_id = $1 ORDER BY name', [workspaceId])).rows

  it('shows an empty workspace one action, then a table with each project\'s lead, team size and proposal state', async () => {
    await withOwner(async (h, session) => {
      const empty = await h.send('GET', '/projects', { cookie: session.cookie })
      expect(empty.body).toContain('href="/projects/new">Create your first project</a>')

      const { project, add } = await setUp(h, session)
      await add({ name: 'Ada', role: 'lead', is_lead: 'on' })
      await add({ name: 'Bob', role: 'developer' })
      await pool.query("INSERT INTO team_proposals (workspace_id, project_id, requested_by, source, status) VALUES ($1, $2, 'owner', 'page', 'ready')", [h.workspaceId, project.split('/').pop()])

      const table = (await h.send('GET', '/projects', { cookie: session.cookie })).body
      const row = /<tbody>([\s\S]*)<\/tbody>/.exec(table)?.[1] ?? ''
      expect(row.replace(/\s+/g, ' ')).toMatch(/>Web<\/a><\/th> <td>#web<\/td> <td><code>\/srv\/web<\/code><\/td> <td>web<\/td> <td>Ada<\/td> <td>2<\/td> <td><span class="badge badge-info">Ready for review<\/span><\/td>/)
      expect(table).not.toContain('Create your first project')
    })
  })

  it('adds, edits, makes lead and removes (after a confirm page) members on the hub, and the old team address redirects there', async () => {
    await withOwner(async (h, session) => {
      const { cookie, csrf } = session
      const { project, personaId, add } = await setUp(h, session)
      const projectId = project.split('/').pop() ?? ''

      const added = await add({ name: 'Ada', role: 'lead', is_lead: 'on' })
      expect([added.status, added.headers.location]).toEqual([303, project])
      await add({ name: 'Bob', role: 'developer' })
      const bobId = (await pool.query<{ id: string }>("SELECT id FROM team_members WHERE workspace_id = $1 AND name = 'Bob'", [h.workspaceId])).rows[0]?.id ?? ''

      const hub = (await h.send('GET', project, { cookie })).body
      expect(hub).toContain('<th scope="row">Bob</th>')
      expect(hub).toContain('<pre class="persona">Write &lt;tests&gt; first.')
      expect(hub).toContain(`<a href="/personas/${personaId}">Edit Dev in the library</a>`)
      expect(hub).not.toContain('Start from template')

      const editing = (await h.send('GET', `${project}?edit=${bobId}`, { cookie })).body
      expect(editing).toContain(`form="edit-${bobId}" value="Bob"`)
      expect((await h.send('POST', `${project}/team/members/${bobId}`, { cookie, form: { csrf, name: 'Bob', role: 'reviewer', persona_id: personaId } })).status).toBe(303)
      expect((await h.send('POST', `${project}/team/members/${bobId}/lead`, { cookie, form: { csrf } })).status).toBe(303)
      expect(await members(h.workspaceId)).toEqual([
        { name: 'Ada', role: 'lead', is_lead: false },
        { name: 'Bob', role: 'reviewer', is_lead: true },
      ])

      const confirm = await h.send('GET', `${project}/team/members/${bobId}/remove`, { cookie })
      expect([confirm.status, confirm.body.includes('<h1>Remove Bob?</h1>')]).toEqual([200, true])
      expect(await members(h.workspaceId)).toHaveLength(2)
      expect((await h.send('POST', `${project}/team/members/${bobId}/delete`, { cookie, form: { csrf } })).headers.location).toBe(project)
      expect((await members(h.workspaceId)).map((member) => member.name)).toEqual(['Ada'])

      const old = await h.send('GET', `/projects/${projectId}/team`, { cookie })
      expect([old.status, old.headers.location]).toEqual([303, project])
    })
  })

  it('shows a refused add or edit again with what was typed', async () => {
    await withOwner(async (h, session) => {
      const { cookie, csrf } = session
      const { project, personaId, add } = await setUp(h, session)

      const refusedAdd = await h.send('POST', `${project}/team/members`, { cookie, form: { csrf, name: 'Grace <3', role: 'tester', persona_id: '' } })
      expect(refusedAdd.status).toBe(400)
      expect(refusedAdd.body).toContain('Pick a persona.')
      expect(refusedAdd.body).toContain('id="new-name" name="name" value="Grace &lt;3"')
      expect(refusedAdd.body).toContain('id="new-role" name="role" value="tester"')

      await add({ name: 'Ada', role: 'lead', is_lead: 'on' })
      await add({ name: 'Bob', role: 'developer' })
      const bobId = (await pool.query<{ id: string }>("SELECT id FROM team_members WHERE workspace_id = $1 AND name = 'Bob'", [h.workspaceId])).rows[0]?.id ?? ''
      const refusedEdit = await h.send('POST', `${project}/team/members/${bobId}`, { cookie, form: { csrf, name: 'Robert', role: 'qa', persona_id: personaId, is_lead: 'on' } })
      expect(refusedEdit.status).toBe(400)
      expect(refusedEdit.body).toContain('This team already has a lead')
      expect(refusedEdit.body).toContain(`form="edit-${bobId}" value="Robert"`)
      expect(refusedEdit.body).toContain(`form="edit-${bobId}" value="qa"`)
    })
  })

  it('marks a persona Relay wrote as "written by Relay" in the library and on its page, and not one made by hand', async () => {
    await withOwner(async (h, { cookie, csrf }) => {
      const byHand = String((await h.send('POST', '/personas', { cookie, form: { csrf, name: 'Hand', text: 'x' } })).headers.location)
      const relayId = (await pool.query<{ id: string }>("INSERT INTO personas (workspace_id, name, file_name, written_by_relay) VALUES ($1, 'Proposed', 'proposed.md', true) RETURNING id", [h.workspaceId])).rows[0]?.id ?? ''

      const library = (await h.send('GET', '/personas', { cookie })).body
      expect(library.match(/written by Relay/g)).toHaveLength(1)
      expect(library).toMatch(/>Proposed<\/a> <span class="badge badge-info">written by Relay/)
      expect((await h.send('GET', `/personas/${relayId}`, { cookie })).body).toContain('written by Relay')
      expect((await h.send('GET', byHand, { cookie })).body).not.toContain('written by Relay')
    })
  })
  const runsOn = async (workspaceId: string) =>
    (await pool.query<{ name: string; client: string; model: string | null; is_lead: boolean }>('SELECT name, client, model, is_lead FROM team_members WHERE workspace_id = $1 ORDER BY name', [workspaceId])).rows

  it("saves each member's client and model, shows them, keeps them when the lead moves, and refuses a bad client or model", async () => {
    await withOwner(async (h, session) => {
      const { cookie, csrf } = session
      const { project, personaId, add } = await setUp(h, session)
      expect((await add({ name: 'Ada', role: 'lead', is_lead: 'on', client: 'codex', model: ' gpt-5-codex ' })).status).toBe(303)
      expect((await add({ name: 'Bob', role: 'developer', client: 'codex', model: 'o4' })).status).toBe(303)
      expect((await add({ name: 'Cy', role: 'developer' })).status).toBe(303)
      expect(await runsOn(h.workspaceId)).toEqual([
        { name: 'Ada', client: 'codex', model: 'gpt-5-codex', is_lead: true },
        { name: 'Bob', client: 'codex', model: 'o4', is_lead: false },
        { name: 'Cy', client: 'claude', model: null, is_lead: false },
      ])
      const hub = (await h.send('GET', project, { cookie })).body
      expect(hub).toContain('<td>Codex, <code>gpt-5-codex</code></td>')
      expect(hub).toContain('<td>Claude<span class="muted">, default model</span></td>')
      expect(hub).toContain('<option value="claude" selected>Claude</option>')

      const bobId = (await pool.query<{ id: string }>("SELECT id FROM team_members WHERE workspace_id = $1 AND name = 'Bob'", [h.workspaceId])).rows[0]?.id ?? ''
      const editing = (await h.send('GET', `${project}?edit=${bobId}`, { cookie })).body
      expect(editing).toContain(`name="model" form="edit-${bobId}" maxlength="100" value="o4"`)
      expect(editing).toContain('<option value="codex" selected>Codex</option>')

      // Making Bob lead keeps both members' client and model.
      expect((await h.send('POST', `${project}/team/members/${bobId}/lead`, { cookie, form: { csrf } })).status).toBe(303)
      expect(await runsOn(h.workspaceId)).toEqual([
        { name: 'Ada', client: 'codex', model: 'gpt-5-codex', is_lead: false },
        { name: 'Bob', client: 'codex', model: 'o4', is_lead: true },
        { name: 'Cy', client: 'claude', model: null, is_lead: false },
      ])

      // An edit to Claude with an empty model clears the model.
      const save = (form: Record<string, string>) => h.send('POST', `${project}/team/members/${bobId}`, { cookie, form: { csrf, name: 'Bob', role: 'developer', persona_id: personaId, is_lead: 'on', ...form } })
      expect((await save({ client: 'claude', model: '  ' })).status).toBe(303)
      expect((await runsOn(h.workspaceId)).find((member) => member.name === 'Bob')).toEqual({ name: 'Bob', client: 'claude', model: null, is_lead: true })

      for (const [form, message] of [
        [{ client: 'gemini' }, 'Pick Claude or Codex as the client.'],
        [{ client: 'codex', model: 'o4\u0007' }, 'The model name cannot hold control characters.'],
        [{ client: 'codex', model: 'm'.repeat(101) }, 'The model name is at most 100 characters.'],
      ] as const) {
        const refused = await save(form)
        expect([refused.status, refused.body.includes(message)]).toEqual([400, true])
      }
      const refusedAdd = await add({ name: 'Dee', role: 'qa', client: 'gemini' })
      expect([refusedAdd.status, refusedAdd.body.includes('Pick Claude or Codex as the client.')]).toEqual([400, true])
      expect((await runsOn(h.workspaceId)).find((member) => member.name === 'Bob')).toEqual({ name: 'Bob', client: 'claude', model: null, is_lead: true })
      expect(await runsOn(h.workspaceId)).toHaveLength(3)
    })
  })

  it("saves the team's member limit from 1 to 6, audited, and refuses one outside that", async () => {
    await withOwner(async (h, session) => {
      const { cookie, csrf } = session
      const { project } = await setUp(h, session)
      const projectId = project.split('/').pop() ?? ''
      const limit = async () => (await pool.query<{ member_limit: number }>('SELECT member_limit FROM teams WHERE project_id = $1', [projectId])).rows[0]?.member_limit
      expect((await h.send('GET', project, { cookie })).body).toContain('name="member_limit" min="1" max="6" step="1" value="3"')

      const saved = await h.send('POST', `${project}/team/limit`, { cookie, form: { csrf, member_limit: '5' } })
      expect([saved.status, saved.headers.location]).toEqual([303, project])
      expect(await limit()).toBe(5)
      const audited = await pool.query("SELECT 1 FROM audit_entries WHERE workspace_id = $1 AND detail->>'outcome' = 'member limit saved' AND detail->>'memberLimit' = '5'", [h.workspaceId])
      expect(audited.rowCount).toBe(1)
      expect((await h.send('GET', project, { cookie })).body).toContain('value="5"')

      for (const typed of ['7', '0', '2.5', 'three']) {
        const refused = await h.send('POST', `${project}/team/limit`, { cookie, form: { csrf, member_limit: typed } })
        expect([refused.status, refused.body.includes('The member limit is a whole number from 1 to 6.'), refused.body.includes(`name="member_limit" min="1" max="6" step="1" value="${typed}"`)]).toEqual([400, true, true])
      }
      expect(await limit()).toBe(5)
      expect((await h.send('POST', `${project}/team/limit`, { cookie, form: { member_limit: '2' } })).status).toBe(403)
      expect(await limit()).toBe(5)
    })
  })

  it('shows the latest team run and its assignments read-only, escaped', async () => {
    await withOwner(async (h, { cookie }) => {
      const fixture = await teamFixture(pool, { workspaceId: h.workspaceId })
      const run = await openRun(pool, fixture, { title: 'add a <b>button</b>' })
      const { assignment } = await insertAssignment(pool, { workspaceId: h.workspaceId, run, memberId: 'm0', memberName: 'Theo', kind: 'build', brief: 'b', idemKey: 'k' })
      await pool.query("UPDATE team_assignments SET state = 'done', result_commit = '0123456789abcdef' WHERE id = $1", [assignment.id])
      await insertAssignment(pool, { workspaceId: h.workspaceId, run, memberId: 'm1', memberName: 'Iris', kind: 'review', brief: 'b', idemKey: 'k2' })

      const hub = (await h.send('GET', `/projects/${fixture.projectId}`, { cookie })).body.replace(/\s+/g, ' ')
      expect(hub).toContain('<h2 id="run-heading">Latest team run</h2>')
      expect(hub).toContain('<dt>Request</dt><dd>add a &lt;b&gt;button&lt;/b&gt;</dd> <dt>Kind</dt><dd>build</dd> <dt>Repo</dt><dd><code>web</code></dd> <dt>Branch</dt><dd><code>relay/x-add-a-button</code></dd> <dt>Status</dt><dd>open</dd>')
      expect(hub).toContain('<tr><th scope="row">Theo</th><td>build</td><td>done</td><td><code>0123456</code></td></tr>')
      expect(hub).toContain('<tr><th scope="row">Iris</th><td>review</td><td>queued</td><td><span class="muted">None</span></td></tr>')
      expect(hub).not.toContain('<b>button</b>')
    })
  })
})
