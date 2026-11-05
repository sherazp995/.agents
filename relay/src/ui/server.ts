/**
 * The local setup page, served by the daemon on 127.0.0.1 only.
 *
 * Every request passes, in order: an exact Host (`127.0.0.1:<port>` or
 * `localhost:<port>`); a live owner session (except the login route); for a
 * change, a matching Origin and the session's CSRF token. A page read
 * changes nothing. The one stylesheet is served after the Host check and
 * before the session check, so the login and refusal pages are styled too;
 * it is static and public, so fetching it is not audited. Every other
 * request leaves an audit entry; a change to
 * projects, personas or teams commits with its entry. Login and logout are
 * audited right after the session row changes. A request whose entry cannot
 * be written gets an error instead of its page. Responses carry a strict CSP
 * (no frames, no scripts, styles only from this server's own stylesheet),
 * nosniff, and a same-origin referrer policy: under no-referrer, Chrome
 * sends `Origin: null` on the page's own form posts, which the Origin check
 * would refuse.
 *
 * A taken port is logged and the daemon runs on without the page.
 */

import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import type { Logger } from '../obs/logger.js'
import { auditRead } from './audit.js'
import { csrfMatches, endSession, loadSession, redeemLoginLink, SESSION_COOKIE, type Session } from './auth.js'
import type { Handler, HandlerResult, RequestContext, UiDeps } from './context.js'
import { html, page, STYLESHEET_PATH } from './html.js'
import { createPersonaAction, deletePersonaAction, editPersonaPage, listPersonasPage, newPersonaPage, updatePersonaAction } from './pages/personas.js'
import { createProjectAction, deleteProjectAction, listProjectsPage, newProjectPage, projectHubPage, updateProjectAction } from './pages/projects.js'
import { approveProposalAction, proposalPage, proposeAction, recreateFilesAction, rejectProposalAction } from './pages/proposals.js'
import { addMemberAction, confirmRemoveMemberPage, makeLeadAction, memberLimitAction, removeMemberAction, starterTeamAction, teamRedirect, updateMemberAction } from './pages/teams.js'

export const MAX_BODY_BYTES = 512 * 1024
const HEADERS_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
}

type Route = { readonly method: 'GET' | 'POST'; readonly pattern: string; readonly handler: Handler }

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'

const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: '/projects', handler: listProjectsPage },
  { method: 'GET', pattern: '/projects/new', handler: newProjectPage },
  { method: 'POST', pattern: '/projects', handler: createProjectAction },
  { method: 'GET', pattern: '/projects/:id', handler: projectHubPage },
  { method: 'POST', pattern: '/projects/:id', handler: updateProjectAction },
  { method: 'POST', pattern: '/projects/:id/delete', handler: deleteProjectAction },
  // The team lives on the project hub now; the old address redirects there.
  { method: 'GET', pattern: '/projects/:id/team', handler: teamRedirect },
  { method: 'POST', pattern: '/projects/:id/team/members', handler: addMemberAction },
  { method: 'POST', pattern: '/projects/:id/team/members/:id', handler: updateMemberAction },
  { method: 'POST', pattern: '/projects/:id/team/members/:id/lead', handler: makeLeadAction },
  { method: 'GET', pattern: '/projects/:id/team/members/:id/remove', handler: confirmRemoveMemberPage },
  { method: 'POST', pattern: '/projects/:id/team/members/:id/delete', handler: removeMemberAction },
  { method: 'POST', pattern: '/projects/:id/team/template', handler: starterTeamAction },
  { method: 'POST', pattern: '/projects/:id/team/limit', handler: memberLimitAction },
  { method: 'POST', pattern: '/projects/:id/proposals', handler: proposeAction },
  { method: 'GET', pattern: '/projects/:id/proposals/:id', handler: proposalPage },
  { method: 'POST', pattern: '/projects/:id/proposals/:id/approve', handler: approveProposalAction },
  { method: 'POST', pattern: '/projects/:id/proposals/:id/reject', handler: rejectProposalAction },
  { method: 'POST', pattern: '/projects/:id/proposals/:id/recreate', handler: recreateFilesAction },
  { method: 'GET', pattern: '/personas', handler: listPersonasPage },
  { method: 'GET', pattern: '/personas/new', handler: newPersonaPage },
  { method: 'POST', pattern: '/personas', handler: createPersonaAction },
  { method: 'GET', pattern: '/personas/:id', handler: editPersonaPage },
  { method: 'POST', pattern: '/personas/:id', handler: updatePersonaAction },
  { method: 'POST', pattern: '/personas/:id/delete', handler: deletePersonaAction },
]

const COMPILED = ROUTES.map((route) => ({ ...route, regex: new RegExp(`^${route.pattern.replace(/:id/g, UUID)}$`) }))

function match(method: string, path: string): { route: Route; params: string[] } | undefined {
  for (const route of COMPILED) {
    if (route.method !== method) continue
    const found = route.regex.exec(path)
    // `/projects/new` is its own route; a literal segment never matches `:id` since ids are UUIDs.
    if (found) return { route, params: found.slice(1) }
  }
  return undefined
}

export type UiServerOptions = {
  readonly pool: Pool
  readonly workspaceId: string
  readonly port: number
  readonly log: Logger
  readonly deps: UiDeps
}

export type UiServer = { readonly port: number; close(): Promise<void> }

/** Starts the page; resolves undefined (and logs) when the port is taken, so the daemon runs on without it. */
export async function startUiServer(options: UiServerOptions): Promise<UiServer | undefined> {
  const server = createServer((req, res) => {
    handle(options, req, res).catch((error: unknown) => {
      options.log.error({ err: error }, 'ui: a request failed')
      if (!res.headersSent) send(res, 500, page({ title: 'Something failed' }, html`<p>Nothing was changed. Check the relay log.</p>`))
      else res.destroy()
    })
  })
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.on('clientError', (_error, socket) => socket.destroy())

  const started = await new Promise<boolean>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      options.log.error({ err: error, port: options.port }, 'ui: could not listen; Relay runs on without the setup page')
      resolve(false)
    })
    server.listen(options.port, '127.0.0.1', () => resolve(true))
  })
  if (!started) return undefined
  server.on('error', (error) => options.log.error({ err: error }, 'ui: server error'))
  options.log.info({ url: `http://127.0.0.1:${options.port}` }, 'ui: setup page is listening; log in with `relay ui`')
  return { port: options.port, close: () => closeServer(server) }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...headers })
  res.end(body)
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(303, { Location: location, ...SECURITY_HEADERS, ...headers })
  res.end()
}

function cookieValue(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return rest.join('=')
  }
  return undefined
}

function sessionCookie(value: string, maxAgeSeconds?: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/${maxAgeSeconds !== undefined ? `; Max-Age=${maxAgeSeconds}` : ''}`
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Next to this module in src/ and in dist/ (scripts/copy-assets.mjs copies it there).
const STYLESHEET_FILE = new URL('./assets/app.css', import.meta.url)
let stylesheet: Buffer | undefined

function sendStylesheet(res: ServerResponse): void {
  stylesheet ??= readFileSync(STYLESHEET_FILE)
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' })
  res.end(stylesheet)
}

const LOGIN_HINT = html`<p>Run <code>relay ui</code> in a terminal for a fresh login link.</p>`

async function handle(options: UiServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pool, port } = options
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (!allowedHosts.includes(req.headers.host ?? '')) {
    await auditRead(pool, options.workspaceId, 'anonymous', { route: `${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0]}`, outcome: 'refused: wrong Host' }, options.deps.now())
    send(res, 421, page({ title: 'Wrong address' }, html`<p>Open the page at http://127.0.0.1:${port}.</p>`))
    return
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const method = req.method ?? 'GET'
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (method === 'GET' && path === STYLESHEET_PATH) {
    sendStylesheet(res)
    return
  }

  if (method === 'GET' && path === '/login') {
    const token = url.searchParams.get('token') ?? ''
    const redeemed = token === '' ? undefined : await redeemLoginLink(pool, token, options.deps.now())
    if (redeemed === undefined) {
      await auditRead(pool, options.workspaceId, 'anonymous', { route: 'GET /login', outcome: 'refused: link expired, used or unknown' }, options.deps.now())
      send(res, 403, page({ title: 'This login link no longer works' }, LOGIN_HINT))
      return
    }
    await auditRead(pool, redeemed.session.workspaceId, redeemed.session.principalId, { route: 'GET /login', outcome: 'logged in' }, options.deps.now())
    // Redirects so the token leaves the address bar.
    redirect(res, '/projects', { 'Set-Cookie': sessionCookie(redeemed.cookie) })
    return
  }

  const cookie = cookieValue(req)
  const session = cookie === undefined ? undefined : await loadSession(pool, cookie, options.deps.now())
  if (session === undefined || session.workspaceId !== options.workspaceId) {
    await auditRead(pool, options.workspaceId, 'anonymous', { route: `${method} ${path}`, outcome: 'refused: no session' }, options.deps.now())
    send(res, 401, page({ title: 'Log in to Relay' }, LOGIN_HINT))
    return
  }

  let form = new URLSearchParams()
  if (method === 'POST') {
    const allowedOrigins = allowedHosts.map((host) => `http://${host}`)
    if (!allowedOrigins.includes(req.headers.origin ?? '')) {
      await refuse(options, session, res, `${method} ${path}`, 403, 'missing or foreign Origin')
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      await refuse(options, session, res, `${method} ${path}`, 413, 'body too large')
      return
    }
    form = new URLSearchParams(body)
    if (!csrfMatches(session.csrf, form.get('csrf') ?? undefined)) {
      await refuse(options, session, res, `${method} ${path}`, 403, 'bad CSRF token')
      return
    }
    if (path === '/logout') {
      await endSession(pool, cookie ?? '')
      await auditRead(pool, session.workspaceId, session.principalId, { route: 'POST /logout', outcome: 'logged out' }, options.deps.now())
      send(res, 200, page({ title: 'Logged out' }, LOGIN_HINT), { 'Set-Cookie': sessionCookie('', 0) })
      return
    }
  } else if (method !== 'GET') {
    await refuse(options, session, res, `${method} ${path}`, 405, 'method not allowed')
    return
  }

  if (method === 'GET' && path === '/') {
    await auditRead(pool, session.workspaceId, session.principalId, { route: 'GET /', outcome: 'redirected' }, options.deps.now())
    redirect(res, '/projects')
    return
  }

  const found = match(method, path)
  if (found === undefined) {
    await refuse(options, session, res, `${method} ${path}`, 404, 'not found')
    return
  }
  const ctx: RequestContext = {
    pool,
    workspaceId: session.workspaceId,
    actor: session.principalId,
    csrf: session.csrf,
    route: `${method} ${found.route.pattern}`,
    params: found.params,
    form,
    query: url.searchParams,
    deps: options.deps,
  }
  const result: HandlerResult = await found.route.handler(ctx)
  if (result.audited !== true) {
    await auditRead(pool, session.workspaceId, session.principalId, { route: ctx.route, outcome: result.outcome, ...(found.params.length > 0 ? { detail: { ids: found.params } } : {}) }, options.deps.now())
  }
  if (result.kind === 'redirect') redirect(res, result.location)
  else send(res, result.status, result.html)
}

async function refuse(options: UiServerOptions, session: Session, res: ServerResponse, route: string, status: number, reason: string): Promise<void> {
  await auditRead(options.pool, session.workspaceId, session.principalId, { route, outcome: `refused: ${reason}` }, options.deps.now())
  send(res, status, page({ title: 'Refused', csrf: session.csrf }, html`<p>${reason}.</p><p><a href="/projects">Back to projects</a></p>`))
}
