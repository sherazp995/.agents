/**
 * Server-rendered HTML for the setup page. Every value that came from a
 * person, a file or Slack goes through `escapeHtml`; the `html` tag does it
 * for interpolated values, and only `Safe` fragments (built here) pass
 * through unescaped. Styles live in assets/app.css (no inline styles, so the
 * CSP can say style-src 'self'); the build copies it into dist.
 */

export class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

type Part = Safe | string | number | boolean | null | undefined | readonly Part[]

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return ''
  if (part instanceof Safe) return part.value
  if (Array.isArray(part)) return part.map(render).join('')
  return escapeHtml(String(part))
}

/** A template tag that escapes every interpolated value unless it is `Safe`. */
export function html(strings: TemplateStringsArray, ...values: readonly Part[]): Safe {
  let out = strings[0] ?? ''
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? '')
  })
  return new Safe(out)
}

/** Where the server answers with src/ui/assets/app.css, before any session check. */
export const STYLESHEET_PATH = '/assets/app.css'

export type Flash = { readonly kind: 'error' | 'ok'; readonly text: string }

export type Crumb = { readonly label: string; readonly href: string }

export type PageOptions = {
  readonly title: string
  readonly csrf?: string
  readonly flash?: Flash
  /** The pages above this one; the page's own title ends the trail. */
  readonly crumbs?: readonly Crumb[]
  /** Reloads the page every N seconds (only the proposal status page, which also offers a stop link). */
  readonly refreshSeconds?: number
}

const NAV = [
  { href: '/projects', label: 'Projects' },
  { href: '/personas', label: 'Personas' },
] as const

function navLinks(options: PageOptions): Safe {
  const section = options.crumbs?.[0]?.href ?? NAV.find((item) => item.label === options.title)?.href
  return html`${NAV.map((item) => html`<a href="${item.href}"${item.href === section ? html` aria-current="page"` : ''}>${item.label}</a>`)}`
}

function crumbTrail(crumbs: readonly Crumb[] | undefined, title: string): Safe {
  if (crumbs === undefined || crumbs.length === 0) return html``
  return html`<nav aria-label="Breadcrumb"><ol class="crumbs">${crumbs.map((crumb) => html`<li><a href="${crumb.href}">${crumb.label}</a></li>`)}<li aria-current="page">${title}</li></ol></nav>`
}

/** One message before the h1, with a text heading so colour is not the only signal. */
function banner(flash: Flash | undefined): Safe {
  if (flash === undefined) return html``
  return flash.kind === 'ok'
    ? html`<div class="flash flash-ok" role="status"><p class="flash-title">Done</p><p>${flash.text}</p></div>`
    : html`<div class="flash flash-error" role="alert"><p class="flash-title">There is a problem</p><p>${flash.text}</p></div>`
}

/** A whole page; with a session (csrf given) it carries the nav and a logout button. Styles come only from /assets/app.css. */
export function page(options: PageOptions, body: Safe): string {
  const header = options.csrf === undefined
    ? html`<header class="site-header"><span class="brand">Relay</span></header>`
    : html`<header class="site-header"><span class="brand">Relay</span><nav aria-label="Main">${navLinks(options)}</nav><span class="logout">${postButton('/logout', options.csrf, 'Log out')}</span></header>`
  const refresh = options.refreshSeconds === undefined ? html`` : html`<meta http-equiv="refresh" content="${options.refreshSeconds}">`
  const head = html`<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">${refresh}<title>${options.title} · Relay</title><link rel="stylesheet" href="${STYLESHEET_PATH}">`
  return `<!doctype html>${html`<html lang="en"><head>${head}</head><body>${header}<main>${crumbTrail(options.crumbs, options.title)}${banner(options.flash)}<h1>${options.title}</h1>${body}</main></body></html>`}`
}

/** `danger-fill` is only for the confirm step of a destructive action. */
export type ButtonKind = 'primary' | 'secondary' | 'danger' | 'danger-fill' | 'link'

/** The class for a button or a link styled as one. */
export function buttonClass(kind: ButtonKind = 'secondary'): string {
  return kind === 'secondary' ? 'button' : `button button-${kind}`
}

/** A hidden CSRF field for a form. */
export function csrfField(csrf: string): Safe {
  return html`<input type="hidden" name="csrf" value="${csrf}">`
}

/** A one-button form that posts to `action`; a `Safe` label can carry hidden context (`Remove<span class="visually-hidden"> Ada</span>`). */
export function postButton(action: string, csrf: string, label: string | Safe, kind: ButtonKind = 'secondary'): Safe {
  return html`<form class="inline" method="post" action="${action}">${csrfField(csrf)}<button type="submit" class="${buttonClass(kind)}">${label}</button></form>`
}

export const TEAM_RUN_NOTE = "A message in a project's Slack channel runs its team when the team has a lead: the lead plans and posts, members build in their own worktrees, and commits stay local. Without a lead, one agent works in the project's folder."
