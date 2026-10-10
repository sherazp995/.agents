# Shared MCP Servers

Shared MCP config files live in `~/.agents/mcp/`. Each agent registers the servers in its own config, pointing at these files.

## Playwright: two servers

| Server name | Browser | Config file | Use for |
|---|---|---|---|
| `playwright` | Fresh headless Chrome, isolated profile, no logins | `mcp/playwright-headless.json` | Screenshots, visual QA, local apps, anything that needs no sign in |
| `playwright-extension` | The user's real Chrome through the Playwright MCP Bridge extension, with their tabs, cookies and logins | `mcp/playwright-extension.json` | Sites that need the user's own session, or watching the browser live |

Default to `playwright`. Use `playwright-extension` only when the task needs the user's real session or the user asks for it.

### Headless (`playwright`)

- Command: `npx -y @playwright/mcp@latest --config ~/.agents/mcp/playwright-headless.json`
- Viewport 1440x900 at deviceScaleFactor 3, so text stays readable in screenshots.
- Screenshots go to `~/Documents/screenshots`.

### Extension (`playwright-extension`)

- Command: `npx -y @playwright/mcp@latest --extension --config ~/.agents/mcp/playwright-extension.json`
- Needs the "Playwright MCP Bridge" extension installed in Chrome.
- The extension shows a token. The user starts the agent with it set, for example `PLAYWRIGHT_MCP_EXTENSION_TOKEN=<token> claude`. The MCP server inherits it from the agent's environment.
- Never write the token into a config file, memory or chat.
- Without the token, Chrome asks the user to approve each connection.
- Browser launch options do not apply: it drives the Chrome that is already open. Work in a new tab and leave the user's other tabs alone.

### Registering in Claude Code

```sh
claude mcp add -s user playwright -- npx -y @playwright/mcp@latest --config ~/.agents/mcp/playwright-headless.json
claude mcp add -s user playwright-extension -- npx -y @playwright/mcp@latest --extension --config ~/.agents/mcp/playwright-extension.json
```

Tools appear as `mcp__playwright__*` and `mcp__playwright-extension__*`. A project level `playwright` entry in `~/.claude.json` overrides the user one for that project.

### Other agents

Codex, Cursor and others register the same two commands in their own MCP config, using the same server names.
