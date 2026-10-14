# One shared agent setup

`~/.agents` is the one home for what every coding agent on a machine shares:
rules, skills, agent definitions, slash commands, memory, chat
history and hooks. It works on macOS and
Linux with Claude Code, Codex, Cursor, OpenCode, aider and Continue; agents
that are not installed are simply skipped. `registry.toml` lists the clients,
their first logins and how each one is wired; extra logins are in
`accounts.toml` (see Accounts).

## Install on a machine

```sh
git clone <this repo> ~/.agents
python3 ~/.agents/install.py --dry-run   # see what it would do
python3 ~/.agents/install.py             # do it; safe to rerun
python3 ~/.agents/check.py               # verify
```

Python 3.11 or newer must be installed somewhere; the tools find it even when
`python3` on PATH is older, so nothing pins one interpreter version. The
installer links each agent's rules and skill folders to this repo, writes the
Cursor rule, links Claude's agents and commands, generates Codex's agent files,
writes the hooks declared in `registry.toml` plus Claude's memory hook, writes
the MCP servers in `mcp/servers.json` into every Claude and Codex login (see
`AGENTS-MCP.md`), puts
`agents-hub` in `~/.local/bin`, and schedules `agents-hub scheduled` every 15
minutes (launchd on macOS, a systemd user timer on Linux, cron otherwise). It
never overwrites anything it did not write: a file in the way is reported as a
conflict for you to move aside.

## Rules

Edit global rules in `AGENTS.md` (an index) and the files it links to. Each
agent loads it through a symlink or a reference the installer creates, and its
links use `~/.agents/...` so they resolve from any of those places.

## Skills

Add or edit personal skills in `skills/<name>/SKILL.md`; every agent with a
skills folder sees them through one symlinked directory. `selected-skills.json`
lists every authored skill; `check.py` requires them and warns about unlisted
ones. Folders owned by an app, not by you, stay out of git: `skills/synced`
(Claude organization skills) and `skills/.system` (Codex system skills).

## Agents and commands

`agents/<name>.md` is the one definition of each subagent, in Claude's format
(front matter with `name` and `description`, then the instructions).
`~/.claude/agents` links to this folder, and the installer generates
`~/.codex/agents/<name>.toml` from each file (marked as generated; edit the
`.md`, never the `.toml`). `commands/<name>.md` are Claude slash commands, each
linked into `~/.claude/commands`; other files there are left alone. An entry may
itself be a link to another checkout; on a machine without that checkout it is
skipped with a note. Codex gets no commands: codex-cli (0.162) no longer loads custom
prompts from `~/.codex/prompts`, so a workflow both agents need belongs in a
skill (`skills/`), which Codex loads.

## Accounts

Claude and Codex can have extra logins next to the first one (`~/.claude`,
`~/.codex`), for example a second subscription:

```sh
agents-hub account add claude claude1             # folder ~/.claude1, alias claude1
agents-hub account add codex work --dir ~/.codex-work
agents-hub account list                            # status of every account
agents-hub account remove claude claude1           # unlink; folder and login stay
```

The first login is wired to `~/.agents` as usual. An extra account shares the
entries listed as `account_links` in `registry.toml` (settings, history,
projects, skills, rules and so on) through relative links to the first login,
for example `~/.claude1/projects -> ../.claude/projects`, and keeps its own
login (`.claude.json`, or Codex's `auth.json`, `config.toml` and databases;
`config.toml` still gets the shared Codex settings, see Shared config).
`add` never replaces a file or a link pointing elsewhere: it reports the conflict
and changes nothing. It records the account in `~/.agents/accounts.toml`
(machine-local, not in git) and appends
`alias claude1='CLAUDE_CONFIG_DIR="$HOME/.claude1" claude'  # agents-hub account`
to `~/.zshrc` or `~/.bashrc` (other shells get the line to add by hand). Then
run the alias and sign in. The alias must be a new name: `add` refuses an app's
command (`claude`, `codex`), a command on PATH, and an alias or function already
defined in a shell startup file (`.zshrc`, `.bashrc`, `.bash_aliases`,
`.profile` and so on). Adding the same account again changes nothing.
`remove` deletes only the shared links, its marked alias line and the record.
`install.py` re-creates missing account links on every run and rewrites an
older full-path link into a relative one with the same target; `check.py`
verifies that every account link resolves to the first login's entry.

## Memory, chats, hooks and learning

`agents-hub` (in `hub/`) is the shared engine; `AGENTS.md` tells every agent how
to use it.
- **Memory:** `memory/scopes/<project>` per project and `memory/global` for all.
  Claude's project memory folders link there with relative links; other agents
  use `agents-hub memory show` and `agents-hub memory add`. `install.py` moves
  any real Claude memory folder in (backup first, in `backup/`) and rewrites
  full-path links as relative ones.
- **Chat history:** each app's own history lives in `history/<app>/`:
  Claude's `~/.claude/projects` and Codex's `~/.codex/sessions` (the `history`
  key in `registry.toml`). `install.py` moves them there with a rename on the
  same disk (instant, nothing copied) and leaves a relative link at the old
  place, so the apps and extra accounts keep working unchanged, for example
  `~/.claude1/projects -> ../.claude/projects -> ../.agents/history/claude/projects`.
  It moves only while Claude and Codex are closed: otherwise it notes that the
  move waits, and `check.py` warns until it is done. Close every Claude and
  Codex window and run `python3 ~/.agents/install.py` from a plain terminal
  (`--running-ok` moves anyway, at your own risk). It never merges or overwrites:
  history on another disk, a `history/<app>` folder that already has files, an
  app recreating its folder during the move, or a move that stopped halfway is
  reported as a conflict with what to do. To undo by hand with the apps closed:
  `rm ~/.claude/projects && mv ~/.agents/history/claude/projects ~/.claude/`
  (memory links inside are relative and then point to the wrong place; Claude's
  memory hook re-links each one the next time you open that project).
- **Chats:** `agents-hub search`, `recent`, `read` and `handoff` read a search
  index over the transcripts of Claude, Codex, OpenCode, Continue and aider,
  kept fresh by the scheduled job. User and assistant text only, secrets
  redacted. Search is scoped to the current project by default; aider's history
  records no working folder, so its sessions appear only with `--all-scopes`.
- **Hooks:** each client entry in `registry.toml` lists its hooks. A `command`
  hook runs a shared script from `hooks/bin` through `hooks/adapters/run.py`
  (Claude and Codex); a `prompt` hook is a Claude agent hook whose prompt is
  `hooks/prompts/<name>.md`. The installer replaces only hooks it wrote and
  lists any others it left alone.
- **Learning:** the `learn` skill promotes recurring memories into skills.
- **Workflow:** substantial work follows the `doing-substantial-work` skill.

`memory/`, `history/`, `chats/`, `handoffs/`, `backup/`, `plans/` and
`accounts.toml` are machine-local and never committed. `history/` and `memory/`
stay in Time Machine backups; the rebuildable `chats/` index does not.

## Shared config: tracked, machine-local, per login

- **Tracked (in git):** rules, skills, agents, commands, hooks, `mcp/servers.json`,
  and `registry.toml`. Edit them here; every login on every
  machine gets them.
- **Machine-local (git-ignored `local/`):** config every login on this machine
  shares but that differs between machines. `install.py` moves each
  `local_shared` entry of the first login into `local/<client>/` (backup first,
  in `backup/`) and links it back: Claude's `settings.json` and
  `settings.local.json`, Codex's `hooks.json`, `prompts/` and `rules/`. Extra
  accounts reach them through their links to the first login. Codex's
  `config.toml` cannot be one file (each login has its own trusted projects and
  app state), so its shared keys live in `local/codex/config.shared.toml`:
  the keys listed as `shared_config` in `registry.toml` (model settings,
  `project_doc_max_bytes`, `marketplaces`, `plugins`, `notice`,
  `tui.model_availability_nux`). The first run seeds it from `~/.codex/config.toml`;
  every run merges it into the `config.toml` of the first login and of each
  Codex account, changing only those keys' lines and reading the result back.
  Each login's `agents-hub-config.json` records every shared key as it last
  matched the shared file. A login value that differs and was never recorded is
  brought in line once (reported, `config.toml` backed up in `backup/`). After
  that, a value changed in the login, by hand or by Codex itself (`/model`, a
  marketplace refresh), is a conflict and is never overwritten: put the value you
  want in `config.shared.toml` and make the login match. A key removed from the
  shared file is removed only from logins where `install.py` wrote it. Moving
  `local_shared` entries waits until Claude and Codex are closed (or
  `--running-ok`), like chat history.
- **Per login (never shared):** sign-in state (`~/.claude.json` and each
  account's `.claude.json`, Codex's `auth.json` and installation id), Codex's
  `config.toml` keys that are not listed (`projects` trust, `hooks.state`, the
  rest of `tui`), and download caches (`plugins/`). MCP servers stay with
  `mcp/servers.json`, written into each login's own config.

## Verify

`python3 check.py` runs every section (skills and rules, clients, hub)
and lists all failures and warnings. Run it after installing, after an agent
update (an app can replace a symlink), and whenever something looks off.
`python3 check.py --repo-only` checks only the checkout (selected skills and
AGENTS.md links), without a provisioned home; CI runs it.
