---
name: frontend-engineering
description: Frontend design and review checklist for Rails + Hotwire/Stimulus, React/Next.js, Vue, Svelte or Angular. Use when building, changing or reviewing UI code - components, Stimulus controllers, Turbo forms, TypeScript, CSS/Tailwind, accessibility, bundle size or render performance, state management, or choosing Hotwire versus a JS framework. Works with the ViewComponent, frontend and forms/Turbo rules in ~/.agents/AGENTS-RULES.md.
---

# Frontend engineering

Apply the ViewComponent, frontend, forms/Turbo and security rules in `~/.agents/AGENTS-RULES.md` (rules 13-29, 38-40). The project's own `CLAUDE.md`/`AGENTS.md` wins. For iOS or Android UI also load `mobile-design`.

## Defaults

- Web platform first: a `<button>` is a button, a `<form>` is a form, `<details>` is a disclosure. Reach for a framework feature only when it earns its keep.
- **Hotwire or React:** stay in Rails + Hotwire for server-driven flows, forms, dashboards, and anything where SEO matters. Use React/Next.js for client-heavy interactivity (canvas, drag and drop, real-time collaboration) or offline-first apps. Never both in one view.
- State lives where it belongs: URL state in the URL, server state in the server cache (Turbo, React Query), client state in the component closest to its use.
- Component contracts: props in, events out, no DOM queries reaching outside the component, scoped selectors only.
- TypeScript: discriminated unions over enums, `unknown` over `any`, exhaustive switches with `never`. A documented escape hatch is fine.

## Reject on sight

- `<div onclick>`: use `<button>`.
- `dangerouslySetInnerHTML`, `raw` or `html_safe` on user data.
- A Stimulus controller wired to two events that call each other (it double-fires).
- A JSON `fetch` to a Rails endpoint where `form_with` + `turbo_stream` fits.
- An analytics call in a Stimulus `connect()` without a guard value (fires on every frame swap).
- Hardcoded locales such as `toLocaleDateString('en-US')`; pass `undefined`.
- A new dependency without a bundle-size and maintenance case (what it solves, the platform-native alternative, size, last release).
- Abstractions for one use: a wrapper with one variant, a hook with one caller, a context with one consumer.

## Priorities

1. **Accessibility from the start:** semantic HTML, ARIA only where it adds value, keyboard navigation, focus management. WCAG 2.1 AA is the floor.
2. **Performance budgets:** bundle KB, LCP, INP, hydration cost, measured on real device profiles.

## Done means seen

Type-check and unit tests are not enough for UI: open it in a browser, run the main path and the edge cases, and watch the console. If you cannot drive a browser here, say it is unverified.

## Reporting

The exact selector, action descriptor (`input->filter#apply`), ARIA attribute or bundle cost, with file:line. Separate **must fix** (accessibility, security, performance regression, broken Hotwire convention) from **nice to have**.
