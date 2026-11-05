/**
 * What a page handler gets and gives back. The server (server.ts) does the
 * checks every request needs (Host, session, Origin, CSRF) before a handler
 * runs, and records the audit entry for any request a handler did not
 * already record inside its own change.
 */

import type { Pool } from 'pg'
import type { TeamProposer } from '../projects/proposals.js'
import type { ChannelList } from '../projects/slack-channels.js'

export type UiDeps = {
  readonly personasDir: string
  /** Names in the repo registry (config/repos.yaml). */
  readonly repoNames: () => readonly string[]
  readonly listChannels: () => Promise<ChannelList>
  readonly isFolder: (path: string) => boolean
  readonly home: string
  readonly now: () => Date
  /** Starts Relay's read-only team proposals; absent when the daemon runs without it. */
  readonly proposer?: TeamProposer
}

export type RequestContext = {
  readonly pool: Pool
  readonly workspaceId: string
  /** The owner's principal id, the audit actor. */
  readonly actor: string
  readonly csrf: string
  /** Method and route pattern, e.g. `POST /projects/:id`, for the audit entry. */
  readonly route: string
  readonly params: readonly string[]
  readonly form: URLSearchParams
  /** The URL's query string (for example `?edit=<member>`). */
  readonly query: URLSearchParams
  readonly deps: UiDeps
}

export type HandlerResult =
  | { readonly kind: 'page'; readonly status: number; readonly html: string; readonly outcome: string; readonly audited?: true }
  | { readonly kind: 'redirect'; readonly location: string; readonly outcome: string; readonly audited?: true }

export type Handler = (ctx: RequestContext) => Promise<HandlerResult>

export const pageResult = (html: string, outcome = 'shown', status = 200): HandlerResult => ({ kind: 'page', status, html, outcome })
export const notFound = (html: string): HandlerResult => ({ kind: 'page', status: 404, html, outcome: 'not found' })
/** A change that was saved (and audited inside its own transaction). */
export const savedRedirect = (location: string, outcome: string): HandlerResult => ({ kind: 'redirect', location, outcome, audited: true })
