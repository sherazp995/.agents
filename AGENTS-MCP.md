# Shared MCP Servers

Shared MCP servers are listed in `~/.agents/mcp/servers.json` (Claude's `{"mcpServers": {...}}` shape; `env_vars` is Codex only; an optional `clients` list, such as `["codex"]`, limits a server to those clients). To add or change one, edit that file, then run `python3 ~/.agents/install.py`. It writes each server into every login: Claude's `~/.claude.json` and each extra account's own `.claude.json` (top-level `mcpServers`), and Codex's `[mcp_servers.<name>]` in each login's `config.toml`. It updates or removes only servers it added (recorded in `agents-hub-mcp.json` in each login folder), never touches a server you added yourself or a project-level one, and reports a different server under the same name as a conflict. A hand-added server in a known older form (a `playwright-ext` that is exactly `npx @playwright/mcp@latest --extension` with no env, or a Codex `playwright-extension` switched on by `PLAYWRIGHT_MCP_EXTENSION=true` and nothing else) is replaced by `playwright-extension`; with any setting of its own it is left alone and reported. `python3 ~/.agents/check.py` fails when a login lacks a shared server or has a different one under its name.

## Playwright: two servers

| Server name | Browser | Config file | Use for |
|---|---|---|---|
| `playwright` | A fresh browser, no logins | Codex: `mcp/servers.json` (`clients: ["codex"]`). Claude: the `playwright` plugin, so its tools are `mcp__plugin_playwright_playwright__*` | Screenshots, visual QA, local apps, anything that needs no sign in |
| `playwright-extension` | The user's real Chrome through the Playwright MCP Bridge extension, with their tabs, cookies and logins | `mcp/servers.json` | Sites that need the user's own session, or watching the browser live |

Default to `playwright`, the local dev browser. Use `playwright-extension` only when the user says to use the extension; a task that seems to need their real session is a reason to ask, not to switch.

### Headless (`playwright`)

- Codex command: `npx @playwright/mcp@latest` (from `mcp/servers.json`), with Playwright MCP's defaults.
- Claude gets the server from its `playwright` plugin, so `servers.json` does not add a second one there.
- `mcp/playwright-headless.json` (headless, viewport 1440x900 at deviceScaleFactor 3) is not used by `servers.json`: its `outputDir` is a Linux path that does not exist on every machine.

### Extension (`playwright-extension`)

- Command: `npx -y @playwright/mcp@latest --extension` (from `mcp/servers.json`). It takes no `--config`: `mcp/playwright-extension.json` names a Linux `outputDir` that does not exist on every machine, so that file is not used.
- Needs the "Playwright MCP Bridge" extension installed in Chrome.
- The extension shows a token. The user starts the agent with it set, for example `PLAYWRIGHT_MCP_EXTENSION_TOKEN=<token> claude`. Claude passes it to the MCP server from its environment; Codex forwards it through `env_vars`.
- Never write the token into a config file, memory or chat.
- Without the token, Chrome asks the user to approve each connection.
- Browser launch options do not apply: it drives the Chrome that is already open. Work in a new tab and leave the user's other tabs alone.

### Registering

Do not use `claude mcp add` or edit an agent's MCP config by hand for shared servers: add them to `mcp/servers.json` and run `install.py`. Tools appear as `mcp__<server name>__*`. A project level entry with the same name in `~/.claude.json` overrides the user one for that project. Cursor, OpenCode and other agents are not written by `install.py`; register the same command under the same server name in their own MCP config.
