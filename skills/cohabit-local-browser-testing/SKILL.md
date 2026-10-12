---
name: cohabit-local-browser-testing
description: "Use when running cohabit-web in a browser for QA, a video or a manual check: servers, staff/IdP sign-in and impersonation, Playwright."
---

<!-- agents-hub:learned-skill -->

# cohabit-local-browser-testing

Learned from memories the user confirmed. Follow every rule below; each one
came from a correction or preference the user gave in a past session.

## Rules

### Staff/admin IdP sign-in and impersonation locally: start cohabit-web with the server-tunnel skill, don't mark it blocked

When a cohabit-web check needs a staff sign-in through Cohabit Authentication (admin, super admin, impersonation, backend Confirm), run the app with the server-tunnel skill (~/Documents/cohabitplatforms/cohabit-web/.claude/skills/server-tunnel/scripts/tunnels.sh up, from the worktree under test). It starts the developer-portal and oidc-server and registers this session's redirect URI, so the IdP login works without touching the localhost:3000 server. Why: on 2026-10-12 (COHABIT-1099) visual QA marked impersonation blocked because the IdP callback only worked on :3000; Hassan said 'you can run the server from the server tunnel skill ... idp will work' and '/learn ... is the skill'. How to apply: for any QA, video or manual check behind staff sign-in, plan a server-tunnel session (use --no-sidekiq when another session runs Sidekiq on the shared DB) instead of reporting the path blocked; tear it down with tunnels.sh down afterwards.

_Learned from `-Users-hassan-Documents-cohabitplatforms-cohabit-web/idp-signin-use-server-tunnel.md` on 2026-10-12._

### Drive the local Playwright browser; the real-Chrome extension only when the user asks for it

For browser work in this project use the local dev browser: the headless
`playwright` server or the `mcp__plugin_playwright_playwright__*` tools. Use the
`playwright-extension` server (the user's real Chrome) only when the user says to
use the extension. Never use the claude-in-chrome extension tools. On 2026-09-30 a
navigate through the extension hung past two minutes and Hassan stopped it with
"use playwright plugin"; on 2026-10-13 he said "When i mention to use the
extension. then use it. Otherwise stay on the local dev browser".

**Why:** two Chrome browsers are connected to this account, so the extension
refuses to act until the user picks one, which costs a round trip every session.
Playwright launches its own browser and needs no such choice. Asked which Chrome
to use, Hassan answered "use playwright plugin or browser directly".

**How to apply:** load the playwright tools directly with ToolSearch. Screenshots
must be written under the repo root or `.playwright-mcp/` (the server refuses
paths outside its allowed roots), and `.playwright-mcp/` is gitignored, so move
anything worth keeping into the scratchpad afterwards. Sign out with GET
`/logout`; `DELETE /users/sign_out` from `fetch` does not clear the session, and
the session cookie is httpOnly so JS cannot delete it. See
[[cohabit-local-signin]].

_Learned from `-Users-hassan-Documents-cohabitplatforms-cohabit-web/browser-automation-use-playwright.md` on 2026-10-12._

### Close the Playwright browser (and stop the test server) as soon as browser testing is finished

When a browser check is done, sign out, call the Playwright `browser_close` tool and stop the dev server started for it.

**Why:** Hassan asked explicitly: "make sure to close playwright after you finish testing".

**How to apply:** close at the end of each browser check, reopen for the next one. See [[browser-automation-use-playwright]].

_Learned from `-Users-hassan-Documents-cohabitplatforms-cohabit-web/close-playwright-after-testing.md` on 2026-10-12._

### Never stop Hassan's already-running dev servers or tunnels; start work on a free port instead

Do not kill or restart dev servers/tunnels that are already running on this machine, even to free a port the task seems to need. Start a new server on a free port and, if a public URL is needed, use the cloudflared quick tunnel already pointing at that port.

**Why:** Hassan runs several portal servers at once (ports 3000, 3002, 3003, 3005, 3006, 3007) plus cloudflared tunnels for each. Killing one interrupts unrelated in-flight work. When asked to serve a worktree at a tunnel URL, he corrected: "don't stop the 3000 server. Only start your server at 3010."

**How to apply:** Pick an unused port for the worktree server. Find the matching quick tunnel's hostname with `curl http://127.0.0.1:<metrics-port>/quicktunnel`, where the metrics port comes from `lsof -nP -a -p <cloudflared-pid> -iTCP -sTCP:LISTEN`. Confirm which server a tunnel actually reaches by curling a unique probe path and grepping the server log. See [[cohabit-tunnel-host-allowlist]].

_Learned from `-Users-hassan-Documents-cohabitplatforms-cohabit-web/dont-kill-running-dev-servers.md` on 2026-10-12._

### Never restart, stop or kill a dev server or tunnel session the user is running; test tooling on a spare checkout

Never run restart/down/up against a checkout whose server the user is using, and never kill a half-finished restart (it leaves the server stopped). Test skill/script changes on a different, idle checkout.

**Why:** On 2026-10-09 I ran `tunnels.sh restart rails` on the user's live session, then killed it mid-way when they said to stop, leaving Rails down. They had to fix it.

**How to apply:** Before any command that restarts servers, confirm the target is not the user's live session. If a restart is already running when told to stop, let it finish rather than killing it.

_Learned from `-Users-hassan-Documents-zubair549-cohabit-web/dont-touch-running-dev-servers.md` on 2026-10-12._
