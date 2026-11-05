import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/migrate.js'
import { closePool, createPool } from '../../src/db/pool.js'
import { mintLoginLink } from '../../src/ui/auth.js'
import type { UiDeps } from '../../src/ui/context.js'
import { startUiServer } from '../../src/ui/server.js'
import { getTestDatabaseUrl } from '../support/database.js'
import { log, uiHarness, type Harness } from './harness.js'

describe('the setup page server', () => {
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

  const harness = (overrides: Partial<UiDeps> = {}, db: Pool = pool): Promise<Harness> => uiHarness(pool, overrides, db)

  const count = async (table: string, workspaceId: string) => Number((await pool.query(`SELECT count(*) FROM ${table} WHERE workspace_id = $1`, [workspaceId])).rows[0]?.count)
  const outcomes = async (workspaceId: string) =>
    (await pool.query<{ route: string; outcome: string }>(`SELECT detail->>'route' AS route, detail->>'outcome' AS outcome FROM audit_entries WHERE workspace_id = $1 ORDER BY sequence`, [workspaceId])).rows

  it('serves a logged-in owner, with strict headers, and audits each request without secrets', async () => {
    const h = await harness()
    try {
      const { cookie, csrf } = await h.login()
      const page = await h.send('GET', '/projects', { cookie })

      expect(page.status).toBe(200)
      expect(page.body).toContain('runs its team when the team has a lead')
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'")
      expect(page.headers['x-content-type-options']).toBe('nosniff')
      // Not no-referrer: under it Chrome sends `Origin: null` on the page's own form posts.
      expect(page.headers['referrer-policy']).toBe('same-origin')
      const audit = JSON.stringify((await pool.query('SELECT detail FROM audit_entries WHERE workspace_id = $1', [h.workspaceId])).rows)
      expect(audit).toContain('logged in')
      for (const secret of [cookie.split('=')[1] ?? '', csrf]) expect(audit).not.toContain(secret)
    } finally {
      await h.server.close()
    }
  })

  it('refuses a wrong Host, no session, a change without Origin or with a bad CSRF token, and a used link; none of them saves anything', async () => {
    const h = await harness()
    try {
      const { cookie, csrf } = await h.login()
      const form = { csrf, name: 'Web', slack_channel: 'C1', folder: '/srv/web' }

      expect((await h.send('GET', '/projects', { cookie, host: `evil.example:${h.port}` })).status).toBe(421)
      expect((await h.send('GET', '/projects')).status).toBe(401)
      expect((await h.send('POST', '/projects', { cookie, origin: null, form })).status).toBe(403)
      expect((await h.send('POST', '/projects', { cookie, origin: 'http://evil.example', form })).status).toBe(403)
      expect((await h.send('POST', '/projects', { cookie, form: { ...form, csrf: 'wrong' } })).status).toBe(403)
      expect((await h.send('GET', '/login?token=not-a-real-token')).status).toBe(403)
      expect(await count('projects', h.workspaceId)).toBe(0)
      expect((await outcomes(h.workspaceId)).map((entry) => entry.outcome)).toEqual(
        expect.arrayContaining(['refused: wrong Host', 'refused: no session', 'refused: missing or foreign Origin', 'refused: bad CSRF token', 'refused: link expired, used or unknown']),
      )
    } finally {
      await h.server.close()
    }
  })

  it('caps the body, refuses other methods, and ends the session on logout', async () => {
    const h = await harness()
    try {
      const { cookie, csrf } = await h.login()
      expect((await h.send('POST', '/projects', { cookie, form: { csrf, name: 'x'.repeat(600 * 1024) } })).status).toBe(413)
      expect((await h.send('DELETE', '/projects', { cookie })).status).toBe(405)
      expect(await count('projects', h.workspaceId)).toBe(0)

      const out = await h.send('POST', '/logout', { cookie, form: { csrf } })
      expect([out.status, String(out.headers['set-cookie'])]).toEqual([200, expect.stringContaining('Max-Age=0')])
      expect((await h.send('GET', '/projects', { cookie })).status).toBe(401)
      expect(await count('web_sessions', h.workspaceId)).toBe(0)
    } finally {
      await h.server.close()
    }
  })

  it('removes an unused persona even when its file cannot be moved aside, and says so', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'relay-ui-')), 'personas')
    const h = await harness({ personasDir: dir })
    try {
      const { cookie, csrf } = await h.login()
      const created = await h.send('POST', '/personas', { cookie, form: { csrf, name: 'Dev', text: 'hi' } })
      // A file where the .removed folder belongs makes the move fail.
      writeFileSync(join(dir, '.removed'), '')

      const removed = await h.send('POST', `${String(created.headers.location)}/delete`, { cookie, form: { csrf } })
      expect([removed.status, removed.body.includes('could not be moved aside')]).toEqual([200, true])
      expect(await count('personas', h.workspaceId)).toBe(0)
      expect((await outcomes(h.workspaceId)).map((entry) => entry.outcome)).toContain('persona removed')
    } finally {
      await h.server.close()
    }
  })

  it('creates a project from the form and refuses a missing folder, a channel the bot is not in, and a taken channel', async () => {
    const h = await harness()
    try {
      const { cookie, csrf } = await h.login()
      const post = (form: Record<string, string | string[]>) => h.send('POST', '/projects', { cookie, form: { csrf, ...form } })

      const missingFolder = await post({ name: 'Web', slack_channel: 'C1', folder: '/nope' })
      expect([missingFolder.status, missingFolder.body.includes('/nope is not a folder on this machine')]).toEqual([400, true])
      expect((await post({ name: 'Web', slack_channel: 'C9', folder: '/srv/web' })).body).toContain('The bot is not in that Slack channel')
      expect(await count('projects', h.workspaceId)).toBe(0)

      const created = await post({ name: 'Web', slack_channel: 'C1', folder: '/srv/web', repos: 'web' })
      expect(created.status).toBe(303)
      expect((await post({ name: 'Other', slack_channel: 'C1', folder: '/srv/web' })).body).toContain('already belongs to another project')
      const { rows } = await pool.query('SELECT name, slack_channel, folder FROM projects WHERE workspace_id = $1', [h.workspaceId])
      expect(rows).toEqual([{ name: 'Web', slack_channel: 'C1', folder: '/srv/web' }])
      expect((await outcomes(h.workspaceId)).filter((entry) => entry.outcome === 'project created')).toHaveLength(1)
    } finally {
      await h.server.close()
    }
  })

  it('shows a persona\'s text escaped, and builds a team from the template on the project hub', async () => {
    const h = await harness()
    try {
      const { cookie, csrf } = await h.login()
      const persona = await h.send('POST', '/personas', { cookie, form: { csrf, name: 'Dev <b>', text: '<script>alert(1)</script>' } })
      const page = await h.send('GET', String(persona.headers.location), { cookie })
      expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(page.body).not.toContain('<script>')

      const project = await h.send('POST', '/projects', { cookie, form: { csrf, name: 'Web', slack_channel: 'C1', folder: '/srv/web' } })
      const team = await h.send('POST', `${String(project.headers.location)}/team/template`, { cookie, form: { csrf } })
      expect(team.status).toBe(200)
      expect(team.body).toContain('Added members: Lead, Developer 1, Developer 2, Reviewer, QA.')
      expect(await count('team_members', h.workspaceId)).toBe(5)
    } finally {
      await h.server.close()
    }
  })

  it('styles every page, logged in or out, only from its own stylesheet, which is served without a session and copied into the build', async () => {
    const h = await harness()
    try {
      const css = await h.send('GET', '/assets/app.css')
      expect([css.status, css.headers['content-type'], css.body.includes('prefers-color-scheme: dark')]).toEqual([200, 'text/css; charset=utf-8', true])

      const loggedOut = [await h.send('GET', '/projects'), await h.send('GET', '/login?token=nope'), await h.send('GET', '/projects', { host: `evil.example:${h.port}` })]
      const { cookie, csrf } = await h.login()
      const project = await h.send('POST', '/projects', { cookie, form: { csrf, name: 'Web', slack_channel: 'C1', folder: '/srv/web' } })
      const persona = await h.send('POST', '/personas', { cookie, form: { csrf, name: 'Dev', text: 'hi' } })
      const hub = String(project.headers.location)
      const loggedIn = await Promise.all(['/projects', '/projects/new', hub, '/personas', '/personas/new', String(persona.headers.location)].map((path) => h.send('GET', path, { cookie })))
      for (const reply of [...loggedOut, ...loggedIn]) {
        expect(reply.body).toContain('<link rel="stylesheet" href="/assets/app.css">')
        expect(reply.body).toContain('<meta name="viewport"')
        expect(reply.body).not.toMatch(/ style=|<style/i)
        expect(reply.headers['content-security-policy']).toContain("style-src 'self';")
      }
      expect(readFileSync('scripts/copy-assets.mjs', 'utf8')).toContain("['src/ui/assets', 'dist/src/ui/assets']")
    } finally {
      await h.server.close()
    }
  })

  it('answers with an error and saves nothing when the audit entry cannot be written', async () => {
    const failingAudit = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === 'connect') {
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(inner, key, innerReceiver) {
                if (key === 'query') {
                  return (text: unknown, ...rest: unknown[]) =>
                    typeof text === 'string' && text.includes('INSERT INTO audit_entries') ? Promise.reject(new Error('audit down')) : (inner.query as (...args: unknown[]) => unknown).call(inner, text, ...rest)
                }
                const value = Reflect.get(inner, key, innerReceiver) as unknown
                return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(inner) : value
              },
            }) as PoolClient
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    }) as Pool
    const h = await harness({}, failingAudit)
    try {
      // Login itself is audited, so mint and redeem through the working pool first.
      const token = await mintLoginLink(pool, h.workspaceId, (await pool.query<{ id: string }>('SELECT id FROM principals WHERE workspace_id = $1', [h.workspaceId])).rows[0]?.id ?? '')
      const reply = await h.send('GET', `/login?token=${token}`)
      expect(reply.status).toBe(500)
      expect(reply.headers['set-cookie']).toBeUndefined()
      expect(await count('web_sessions', h.workspaceId)).toBe(1)
      expect(await count('projects', h.workspaceId)).toBe(0)
    } finally {
      await h.server.close()
    }
  })

  it('runs on without the page when its port is taken, and stops listening once closed', async () => {
    const h = await harness()
    const second = await startUiServer({ pool, workspaceId: h.workspaceId, port: h.port, log, deps: { personasDir: '/tmp', repoNames: () => [], listChannels: async () => ({ kind: 'ok', channels: [] }), isFolder: () => false, home: '/', now: () => new Date() } })
    expect(second).toBeUndefined()
    await h.server.close()
    await expect(h.send('GET', '/projects')).rejects.toThrow()
  })
})
