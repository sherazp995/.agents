# One shared agent setup

`~/.agents` is the one home for what every coding agent on a machine shares:
rules, skills, agent definitions, slash commands, Ponytail, memory, chat
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
./update-ponytail.sh                     # first time only: fetch and patch Ponytail
python3 ~/.agents/check.py               # verify
```

Python 3.11 or newer must be installed somewhere; the tools find it even when
`python3` on PATH is older, so nothing pins one interpreter version. The
installer links each agent's rules and skill folders to this repo, writes the
Cursor rule, links Claude's agents and commands, generates Codex's agent files,
writes the hooks declared in `registry.toml` plus Claude's memory hook, puts
`agents-hub` in `~/.local/bin`, and schedules `agents-hub scheduled` every 15
minutes (launchd on macOS, a systemd user timer on Linux, cron otherwise). It
never overwrites anything it did not write: a file in the way is reported as a
conflict for you to move aside, and a missing Ponytail is only a note.

## Rules

Edit global rules in `AGENTS.md` (an index) and the files it links to. Each
agent loads it through a symlink or a reference the installer creates, and its
links use `~/.agents/...` so they resolve from any of those places.

## Skills

Add or edit personal skills in `skills/<name>/SKILL.md`; every agent with a
skills folder sees them through one symlinked directory. `selected-skills.json`
lists every authored skill; `check.py` requires them and warns about unlisted
ones. Folders owned by an app, not by you, stay out of git: `skills/synced`
(Claude organization skills), `skills/.system` (Codex system skills) and the
`skills/ponytail*` links that `update-ponytail.sh` manages.

## Agents and commands

`agents/<name>.md` is the one definition of each subagent, in Claude's format
(front matter with `name` and `description`, then the instructions).
`~/.claude/agents` links to this folder, and the installer generates
`~/.codex/agents/<name>.toml` from each file (marked as generated; edit the
`.md`, never the `.toml`). `commands/<name>.md` are Claude slash commands, each
linked into `~/.claude/commands`; other files there are left alone.

## Ponytail

`update-ponytail.sh [ref]` installs or updates the single shared Ponytail copy
in `plugins/ponytail` from upstream plus `ponytail-explicit-only.patch`, points
Claude and Codex at it, and restores the previous copy if a step fails. The
plugin code itself is not tracked here. Ponytail is **off by default** and runs
only when you ask for it by name (see `AGENTS-CONFIG.md`); shared defaults live
in `ponytail.json`.

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
login (`.claude.json`, or Codex's `auth.json`, `config.toml` and databases).
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

## Verify

`python3 check.py` runs every section (skills and rules, clients, Ponytail, hub)
and lists all failures and warnings. Run it after installing, after an agent
update (an app can replace a symlink), and whenever something looks off.
`python3 check.py --repo-only` checks only the checkout (selected skills and
AGENTS.md links), without a provisioned home; CI runs it.
