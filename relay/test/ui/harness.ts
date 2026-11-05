/**
 * A setup page server on a free port with a fresh workspace and owner, for
 * the UI tests: `send` makes raw HTTP requests (Origin set for POSTs unless
 * overridden) and `login` redeems a login link and returns the cookie and
 * CSRF token.
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { expect } from 'vitest'
import { createLogger } from '../../src/obs/logger.js'
import { provisionPrincipal } from '../../src/tenancy/principals.js'
import { resolveWorkspaceId } from '../../src/tenancy/workspaces.js'
import { mintLoginLink } from '../../src/ui/auth.js'
import type { UiDeps } from '../../src/ui/context.js'
import { startUiServer, type UiServer } from '../../src/ui/server.js'

export const log = createLogger('fatal')

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

export type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

export type SendOptions = { cookie?: string; origin?: string | null; host?: string; form?: Record<string, string | string[]> }

export type Harness = {
  server: UiServer
  port: number
  workspaceId: string
  send: (method: string, path: string, options?: SendOptions) => Promise<Reply>
  login: () => Promise<{ cookie: string; csrf: string }>
}

export function toForm(form: Record<string, string | string[]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(form)) for (const item of [value].flat()) params.append(key, item)
  return params.toString()
}

/** `pool` provisions the workspace and login; `db` is what the server uses (a failing proxy in one test). */
export async function uiHarness(pool: Pool, overrides: Partial<UiDeps> = {}, db: Pool = pool): Promise<Harness> {
  const workspaceId = await resolveWorkspaceId(pool, 'slack', `T_${randomUUID()}`)
  const principalId = await provisionPrincipal(pool, workspaceId, 'slack', `U_${randomUUID()}`, 'Owner', ['owner'])
  const port = await freePort()
  const deps: UiDeps = {
    personasDir: join(mkdtempSync(join(tmpdir(), 'relay-ui-')), 'personas'),
    repoNames: () => ['web'],
    listChannels: async () => ({ kind: 'ok', channels: [{ id: 'C1', name: 'web' }, { id: 'C2', name: 'api' }] }),
    isFolder: (path) => path === '/srv/web',
    home: '/home/me',
    now: () => new Date(),
    ...overrides,
  }
  const server = await startUiServer({ pool: db, workspaceId, port, log, deps })
  if (server === undefined) throw new Error('server did not start')

  const send: Harness['send'] = (method, path, options = {}) =>
    new Promise((resolve, reject) => {
      const body = options.form === undefined ? undefined : toForm(options.form)
      const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${port}` }
      if (options.cookie !== undefined) headers.Cookie = options.cookie
      const origin = options.origin === undefined ? (method === 'POST' ? `http://127.0.0.1:${port}` : null) : options.origin
      if (origin !== null) headers.Origin = origin
      if (body !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        headers['Content-Length'] = String(Buffer.byteLength(body))
      }
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end(body)
    })

  const login = async () => {
    const token = await mintLoginLink(pool, workspaceId, principalId)
    const reply = await send('GET', `/login?token=${token}`)
    expect(reply.status).toBe(303)
    const setCookie = String(reply.headers['set-cookie'] ?? '')
    expect(setCookie).toMatch(/HttpOnly; SameSite=Strict; Path=\//)
    const cookie = setCookie.split(';')[0] ?? ''
    const page = await send('GET', '/projects', { cookie })
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? ''
    return { cookie, csrf }
  }
  return { server, port, workspaceId, send, login }
}
