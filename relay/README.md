# Relay

Message Slack from your phone. Relay runs the work on your Mac, under policy,
and answers in the same thread.

It drives **Claude Code** as a subprocess on your own authenticated session.
There is no API key to supply, and adding one is not a supported shortcut.

```
you (Slack)  ──▶  Relay daemon  ──▶  claude -p (headless)
                       │                    │
                       │                    ├── browser, in a scoped Chrome profile
                       │                    └── shell, git, files
                       └──▶  policy, approvals, budget, audit
```

---

## Before you start

**macOS is the fully supported platform.** Linux runs Slack, approvals and
the browser: set `secrets.provider: libsecret` and store the tokens with
`secret-tool store --label="Relay" service relay-slack-bot-token`. What Linux
does not have is the sandbox, which is built on macOS `sandbox-exec`, so
`shell` calls there fail closed rather than running unconfined (FR-SH-7).
Windows is unsupported.

Tokens live in an OS keystore on both platforms and never in an environment
variable, which is FR-SLA-6 and is why the environment-backed secret provider
is deliberately unreachable from configuration.

You need:

| | |
|---|---|
| macOS | Keychain is the only supported secret store |
| Node 22+ | `node --version` |
| pnpm | `npm i -g pnpm` |
| Postgres 17 and Redis | the system services (Homebrew), see below |
| Claude Code CLI | signed in; Relay spawns it |
| Google Chrome | only if you want the browser capability |

---

## Install

```bash
git clone <this repo> relay && cd relay
pnpm install
pnpm build
```

Relay uses the system's own Postgres 17 and Redis, not containers. With
Homebrew they run as login services and come back after a reboot:

```bash
brew install postgresql@17 redis
brew services start postgresql@17
brew services start redis
psql -d postgres -c "CREATE ROLE relay LOGIN CREATEDB CREATEROLE PASSWORD 'relay'"
psql -d postgres -c "CREATE DATABASE relay OWNER relay"
psql -d postgres -c "CREATE DATABASE relay_test OWNER relay"   # tests only; never the dev database
```

Relay's config points at Postgres on 5432 and Redis database 13 on 6379;
the tests use `relay_test` and Redis database 8, so neither touches other
apps' data on the same servers.

Or install the package and keep your configuration somewhere of your own:

```bash
npm install -g relay
relay init                    # writes config into ~/.relay
relay doctor
```

Relay looks for its configuration in this order: `RELAY_HOME` if you set it,
then the current directory if it actually contains
`config/relay.config.yaml`, then `~/.relay`. The current directory is checked
first so that working inside a checkout never silently picks up an installed
copy's configuration. `relay doctor` tells you which one it chose.

Postgres and Redis are still needed either way, set up as above.

### Create the Slack app

1. Go to <https://api.slack.com/apps>, choose **Create New App → From a
   manifest**, and paste `docs/slack-app-manifest.yaml`.

   The manifest encodes exactly the scopes the code declares. If you widen
   them, `relay doctor` fails on purpose: Relay sees only the channels it is
   invited to plus its own DMs, and a scope set that exceeds that is a
   difference you should have to acknowledge.

2. Install it to your workspace, then collect two tokens:
   - **Bot token**, `xoxb-…`, from *OAuth & Permissions*
   - **App-level token**, `xapp-…`, from *Basic Information → App-Level
     Tokens*, with the `connections:write` scope. Socket Mode needs this, so
     Relay never accepts an inbound webhook and needs no public URL.

3. Put both in the Keychain. These commands prompt for the value rather than
   taking it as an argument, because process arguments are readable by any
   user on the machine:

   ```bash
   security add-generic-password -s relay-slack-bot-token -a "$USER" -w
   security add-generic-password -s relay-slack-app-token -a "$USER" -w
   ```

   `relay secrets migrate` (below) recreates both so only Relay's helper can
   read them.

4. **Already installed the app before autonomous tasks?** Reinstall it from
   `docs/slack-app-manifest.yaml`: the bot now needs `reactions:write` so the
   agent can react to a message (`relay live react`). `relay doctor` fails until the token has it.

### Install the supervisor and lock down Relay's own secrets

```bash
relay install-service         # builds relay-secrets, stops the daemon
relay secrets migrate         # database URL into the Keychain, relay_app role, receipt key
relay install-service --start # writes the launchd agent with a PATH for claude/codex/node/gh, loads it
```

Building the helper and starting the daemon are separate on purpose: a
fresh helper build is on no Keychain item's access list until `migrate`
recreates them, and a daemon started before that would raise Keychain
dialogs from launchd.

`install-service` refuses, naming the binary, when claude (or, with
autonomous tasks on, codex or gh) cannot be found: launchd has no shell PATH,
so the plist carries one. It also compiles `native/relay-secrets` into
`<RELAY_HOME>/bin/relay-secrets` and signs it ad hoc. That helper is the only
program on the access list of Relay's Keychain items, and it answers only
the running daemon.

`secrets migrate` is safe to run again; it skips finished steps and never
prints a value. It:

- creates a `relay_app` Postgres role with a generated password, makes it the
  owner of Relay's tables (so startup migrations still run), stores its URL
  in the Keychain as `relay-database-url`, keeps the old URL as
  `relay-database-admin-url`, and rewrites `database.url` in
  `config/relay.config.yaml` to `keystore:relay-database-url`;
- creates the approval receipt key, `relay-approval-receipt-key`;
- recreates any Relay item that `/usr/bin/security` can still read.

Run it after every `install-service` (the Keychain trusts the exact helper
build), then `relay install-service --start`. The helper also answers only a
parent running the node binary it was built against, so a node upgrade that
moves that binary means running all three again.

Values a worker needs at spawn (the MCP `env_vars` named in
`~/.agents/mcp/servers.json`, the read-only and write GitHub tokens) go in
through stdin, never an argument:

```bash
printf %s "$VALUE" | relay secrets set <name>      # --replace to overwrite
```

**When macOS asks whether a program may use a `relay-…` Keychain item:**
click *Allow* for a `relay` command you just ran yourself, and *Deny* for
anything else. Never click *Always Allow*: it adds that program to the
item's access list, which is exactly what a worker's shell would need to read
Relay's database password or receipt key.

### Stop everything

```bash
relay kill engage "reason"    # a running daemon stops all work within one tick
relay kill clear
```

### Check it

```bash
node dist/src/cli.js init --yes    # writes starter config and policy
node dist/src/cli.js doctor        # every dependency, truthfully
```

`doctor` reports what is actually true rather than what is configured. No
profiles configured is reported as `ok`, because a browser call is then
refused with a clear reason, which is a safe state and not a broken one.

### Run it

```bash
node dist/scripts/relay-orchestrator.js
```

Watch for this line, and do not settle for the process merely existing:

```
orchestrator is running: Socket Mode is connected
```

A running process is not evidence. Relay has shipped a bug where the daemon
stayed alive having never completed the Socket Mode handshake.

Then mention Relay in a channel it is in, or DM it.

---

## Browser profiles

Relay will not touch your everyday Chrome. Chrome 136 and later ignore
remote-debugging switches for the default user-data directory, and a
user-data directory permits only one running browser instance, which yours
already holds. So Relay drives a **dedicated** directory.

The quickest route keeps your existing logins. Quit Chrome fully first, with
Cmd-Q rather than closing the windows: its cookie store is live SQLite, and
copying it mid-write yields a clone that is silently signed out.

```bash
node dist/src/cli.js profile-list                       # folder names Chrome never shows you
node dist/src/cli.js profile-clone --from "Profile 3" --to acme --origin acme.com
node dist/src/cli.js profile-registry                   # what is registered, and what it may reach
```

Cloning copies cookies and saved passwords to a second place on disk, which
Relay then drives unattended. Delete the directory under `~/chrome-profiles`
to revoke it.

Starting with no login instead:

```bash
node dist/src/cli.js profile-add acme --dir ~/chrome-profiles/acme --origin acme.com
node dist/src/cli.js profile-login acme     # sign in by hand, then quit the window
```

Widen an allowlist as real tasks hit it:

```bash
node dist/src/cli.js profile-origins acme --allow billing.acme.com
```

`config/profiles.yaml` is gitignored. It names real clients and points at
directories holding copies of their cookies.

---

## What is actually enforced

Worth reading before you trust it with anything.

- **Origin scoping on tier 2 is prevented, not detected.** Every request a
  driven page makes is paused at the CDP `Fetch` layer and checked against
  the profile's allowlist before it leaves the browser. Popups the page opens
  are guarded too.
- **Tier 1, the browser extension, can only detect.** The extension owns
  navigation, so Relay can refuse to issue one and then observe where the
  browser went. Client profiles default to a tier 2 pin for this reason.
- **Page content reaching the model is treated as untrusted** and wrapped so
  instructions inside a page are data, not directions.
- **The secret scrubber only redacts values Relay itself brokered.** It
  cannot catch a key you pasted into a prompt.
- **Commands run under OS-level confinement.** Every `shell` call goes through
  a generated `sandbox-exec` profile: it may write only inside the working
  directory you name, and the kernel denies it any direct network. Its only
  route out is Relay's own loopback proxy, which terminates a connection to
  any host outside the run's declared list and logs every attempt.
  `relay doctor` proves this on your machine rather than reporting that it is
  configured, by attempting a forbidden write and a forbidden connection.
  If confinement is unavailable, commands are refused rather than run
  unconfined.
- **The confinement is about writes and network, not reads.** A run can read
  what your user account can read. It is not a complete jail.
- **Relay's own secrets are narrowed, not walled off.** After
  `relay secrets migrate`, no database password sits in a file, the daemon
  connects as `relay_app`, every resolved approval carries a receipt signed
  with a key only the daemon reads, and Relay's Keychain items answer only
  its helper. A same-user process that rewrites Relay's source, its plist,
  the helper or its pid file can still get past that. The `relay` owner
  role's password (`relay`, in the test suite's defaults) is unchanged by the
  migration; that role is not a superuser.

---

## Not built yet

Stated plainly so nobody discovers it the hard way.

- **The repository and coding capability.** `shell` runs one command at a
  time. The worktree-per-run isolation, the publish-for-review gate, and the
  mandatory Codex review are specified and not built, so Relay cannot yet be
  handed a repository and asked to open a pull request.
- **The filesystem capability.** `shell` deliberately refuses `rm`, pointing
  at a preview-and-trash path (FR-SH-3, FR-SH-4) that does not exist yet.
- **Linux confinement.** The keystore works; the sandbox does not exist
  there, so `shell` is refused. It would need bubblewrap or an equivalent.
- **The Linux keystore has not been run on a real Linux machine.** Its logic
  is covered by tests to the same standard as the macOS one, but nobody has
  watched it work against a live Secret Service.
- Cron and webhook triggers, recipes, memory, document parsing.
- File upload from the browser, deliberately: a model reading an
  attacker-controlled page choosing which local file to upload is a direct
  exfiltration route. It needs path scoping first.

---

## Developing

```bash
pnpm test         # full suite
pnpm typecheck
node dist/src/cli.js smoke        # readiness; --run-agent spends real money
```

Browser suites drive a real headless Chrome against a local fixture server.
Without Chrome they skip and say so rather than passing quietly.

`docs/HANDOVER.md` is the orientation document for anyone picking this up:
current state, what is done, what is next, and a list of things that are true
and non-obvious that each cost real time to discover.
