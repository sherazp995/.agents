# Relay handover

Written 2026-08-11 for a fresh session picking this up. Read this file, then
`docs/specs/2026-08-08-relay-requirements.md`. Everything else is detail.

Revised 2026-08-11, later the same day, after the tier 2 browser driver
landed. Section 4's first item has changed substantially: GT-1 passes now.

---

## 1. What Relay is

The operator messages Slack from their phone. Relay runs the work on their
Mac, under policy, and answers in the same thread. It drives **headless
Claude Code** as a subprocess (`claude -p --output-format stream-json`) on the
operator's own authenticated session. **There is no API key, and adding one is
not an acceptable simplification** (DEC-1).

Repo: `/Users/hassan/.projects/relay`. Branch `p0.4-policy-approvals`. Tags
`p0.1` through `p0.5`. Node 22, pnpm, TypeScript strict, Vitest, Postgres 17
and Redis 8. Since 2026-10-29 these are the system's own Homebrew services
(Postgres on 5432, Redis on 6379 database 13, tests on `relay_test` and Redis
database 8), not Docker; the Docker data was copied over with `pg_dump`.

---

## 2. State right now

**1330 tests passing, 1 gated live skip, typecheck clean, tree clean.**
Phase 0 is substantively complete through P0.6. The tier 2 browser driver
landed after that, and **GT-1 passes**.

The browser suites drive a real headless Chrome against a local fixture
server (`test/support/fixture-site.ts`). They need Chrome installed; where
it is absent they skip and say so rather than passing quietly. They cost no
money and add roughly ten seconds to a full run.

```bash
pnpm test                      # full suite, ~60s
pnpm typecheck
node dist/src/cli.js doctor    # every dependency, truthfully
node dist/src/cli.js smoke     # readiness; --run-agent spends real money
```

The live daemon is `node dist/scripts/relay-orchestrator.js`. It is running
against the operator's real Slack workspace. Restart it after any build:

```bash
pnpm build && relay install-service --start    # reload the launchd agent; the helper is not rebuilt
```

### Relay's own secrets (user decision 7)

`relay install-service` now compiles `native/relay-secrets` into
`<RELAY_HOME>/bin/relay-secrets`, signs it ad hoc, and stops the daemon and
removes its plist; `relay install-service --start` writes the plist (with a
PATH holding the claude, codex, node and gh directories, since launchd has
none) and loads it. The daemon reads the Keychain only through that helper
(`src/secrets/daemon.ts`), which answers only a parent whose pid is in
`<RELAY_HOME>/run/relay-daemon.pid` (written 0600 at start, removed at exit)
and whose executable is the node binary baked in at build. CLI commands
keep `/usr/bin/security`, which makes macOS ask the operator.

**The sequence on this machine is `relay install-service`, then
`relay secrets migrate`, then `relay install-service --start`, after every
rebuild of the helper.** Until then `relay doctor` fails `database-secret`
(config still holds the database password) and `receipt-key`. It moves the
database URL into the Keychain, connects the daemon as a `relay_app` role
that owns Relay's tables, rewrites `database.url` to
`keystore:relay-database-url`, creates `relay-approval-receipt-key`, and
recreates Relay's older items so only the helper can read them. Every
consumer of `database.url` goes through `resolveDatabaseUrl`
(`src/config/database-url.ts`).

The governed loop's `requestApproval` is **still unwired**: the daemon's
`startOrchestrator` call (`scripts/relay-orchestrator.ts`) passes none, so
`src/agent/loop.ts:1412` falls back to denying every call that needs an
approval. Autonomous tasks use their own approvals and are not affected.

### Live control, which the operator uses to talk to a working session

A Slack thread attached to a running Claude Code session has its messages
**parked** rather than answered by Relay's own loop, and then **PUSHED** into
that session: Relay spawns a short-lived courier `claude` whose only job is
to `SendMessage` into it. Measured at about one second, mid-turn, into a
session that was actively working.

The push replaced a pull, and the pull's two failure shapes are why. A
message sent mid-turn waited for that turn to end. A message sent while the
session was IDLE waited for a turn end that would never come, and was
eventually answered from a cold session. The second is the one a `Stop` hook
cannot fix by construction.

The `Stop` hook running `relay live drain` still exists and still works. It
is now a redundant second path, and running two paths over one queue is a
race: the push claims on confirmed delivery, and a claim lost to a
concurrent drain is logged as a duplicate. **Prefer removing the hook.**

Either way the session replies the same way, by running
`relay live say --channel <id> --thread <ts> --text "..."`. Relay is not in
the reply path; that command posts straight to Slack.

---

## 3. What is done

| Milestone | Delivers |
|---|---|
| P0.1 | Config and policy loading that fails closed, migrations, Redis, `relay doctor` |
| P0.2 | Chat contract, Slack adapter over Socket Mode, conformance suite |
| P0.3 | Sessions, runs, steps, the agent loop, cancellation within 5s, final reports |
| P0.4 | Capability registry, policy engine, Slack approvals, engine hook bridge, kill switch, budget caps, session attachment, live control |
| P0.5 / P0.6 | Browser profiles and tiers, origin enforcement, profile launch, `relay init`, `relay smoke`, egress inventory, log rotation |
| P1.1 | **Tier 2 CDP driver.** A CDP transport over Node 22's own WebSocket (no new dependency), Chrome launch and DevTools endpoint discovery, a page driver with the FR-BR-5 primitives, FR-BR-6 dialog handling, and FR-PRF-4 origin enforcement at the CDP `Fetch` layer. **GT-1 passes.** |
| P1.2 | Capability results travel back into the next decision call, tagged as untrusted data per AP-2, so the model can answer from what a step actually returned |
| P1.3 | The model is told how to CALL each capability (description, risk tier, registration-validated input examples), not merely its name |
| P1.4 | `relay smoke` launches a real browser and proves origin scoping is enforced on this machine, rather than reporting configuration |
| P1.5 | FR-BR-8 / FR-BR-10: CAPTCHAs, bot walls, 2FA, rate limits and signed-out sessions are detected and reported as needing a human. **GT-12 passes.** |
| P1.6 | FR-BR-7 selector resilience: elements are addressed by accessible role and name first, then selector, then text; a `read_elements` step lists what is targetable; ambiguity is refused rather than resolved |
| P1.7 | **GT-10 passes**: a real hostile page is read, and the injection defence path is proven end to end from the browser to the exact bytes that would reach the model |
| P1.8 | FR-BR-5 downloads: files are fetched into a Relay-named path, bounded and cancelled past the cap. **GT-2's driver half passes**; its artifact-upload half needs an artifact store that does not exist |
| P1.9 | **Closed an origin-scoping hole**: a page opened by `window.open` had no request interception at all. Every target now auto-attaches, paused, and is guarded before it runs |
| P1.10 | FR-PRF-10 and FR-BR-8 reach the OPERATOR, not just the model: capabilities declare their own report lines, so the profile that acted and any page needing a human appear in the Slack report whether or not the model mentions them |
| P1.11 | FR-BR-5's remaining cheap primitives: back, forward, reload, hover, PDF export |
| P1.12 | `relay profile-login <name>`, and a **daemon zombie fix**: a startup that finished after its deadline had been given up on installed timers on a closed pool, erroring every two seconds forever while the process stayed alive and unconnected |
| P1.13 | **Live control outage fixed.** `relay smoke` created a second workspace, `relay live drain` refused on the resulting ambiguity, and the operator's `\|\| true` hook swallowed the refusal. Silently undelivered for a day and a half. Ambiguity is now judged by what is actually waiting, and a refusal goes to stdout so the session sees it |
| P1.14 | **Push replaces pull for live control.** A courier `claude` delivers into the running session mid-turn, proven in both the busy and idle states. Four defects found in review and fixed: a fence-injection hole in the courier prompt, a 90s inline await in the inbound handler, a discarded claim result allowing double delivery, and an unrunnable reply command |
| P1.15 | **The profile registry is maintained by commands, not by pasting.** `profile-add`, `profile-origins`, `profile-remove`, `profile-registry`, and `--origin` on `profile-clone` so a clone registers itself. Edits go through the yaml Document API so comments survive, and every edit re-parses through the schema before it is written, so a refusal leaves the original intact. Writes are atomic. `config/profiles.yaml` is now **gitignored**; `config/profiles.example.yaml` is the tracked template |
| P1.16 | **FR-SH-6 confinement.** Generated `sandbox-exec` profile, the enforcing egress proxy that exists because sandbox-exec cannot filter by host, and FR-SH-7's fail-closed self-test wired into `relay doctor` |
| P1.17 | **`shell` capability** (FR-SH-1), the sandbox's first caller. Binary plus argv, never a command line, so pipes and chaining are impossible by construction. Environment allowlist, output cap, cancellation that kills the process group |
| P1.18 | **Linux keystore** (`libsecret`), added without weakening FR-SLA-6: both accepted providers are OS keystores, `env` is still unreachable from config. Not run on real Linux |
| P1.27 | **FR-POL-7's rate and count limits**: a sliding per-origin window in Redis, and a per-capability call cap that names a loop rather than a cap |
| P1.26 | **The publish-for-review gate** (FR-CODE-41/41a/45/46/47/47a/47d): push and draft PR as one approvable unit, metadata-only in chat, every precondition re-checked at the action |
| P1.25 | **The three publish gates**: FR-CODE-44 secret scanning that blocks outright, FR-CODE-42/43 git hard blocks with no approval path, and FR-REV-5/6/7 severity times origin classification |
| P1.24 | **FR-SEC-6 screenshot redaction.** Credential fields are covered in the DOM BEFORE capture, so the bytes never hold the value; a view with a cross-origin frame is refused rather than persisted unmasked |
| P1.23 | **The audit log** (FR-AUD-1/2/3): per-workspace hash chain, Keychain-signed heads, redaction on write, and a `relay doctor` check that reports chain and signature as separate facts |
| P1.22 | **`code.task`** (FR-CODE-20/22/25/30): the engine runs inside the sandbox, reaching only Anthropic through the enforcing proxy, with FR-CODE-25's failure taxonomy kept distinct and verification deciding success |
| P1.21 | **Repo registry and worktree isolation** (FR-CODE-1/2/4/10-16). NFR-20 proved against a real repository: HEAD, branch and status byte-identical after a run edits the worktree |
| P1.20 | **The filesystem capability** (FR-SH-2/3/4): path scope resolved through symlinks, dry-run preview, and deletes that stay recoverable for 7 days |
| P1.19 | **Installable.** Config resolves through `RELAY_HOME`, then the current directory if it holds the config, then `~/.relay`. Migrations are copied into `dist` and resolved relative to the module. Proven by packing, installing into a clean directory, and getting a green `relay doctor` |

---

## 4. What is next

Counted from an audit of `src/`, not from memory. **Four phase-1 items and
six later ones.**

### Phase 1

1. **Wire the publish path into a capability and invoke Codex for real.**
   The gates all exist and are tested (`src/repos/publish.ts`,
   `review.ts`, `secrets-gate.ts`, `git-safety.ts`), and `code.task` stops
   at a verified branch in a worktree. What is missing is the glue: run
   `codex exec` with `buildReviewerPrompt`, parse its template into findings,
   and offer `buildPublishApprovalMessage` through the existing approval
   path. FR-REV-4 also needs the operator's explicit consent recorded before
   any diff leaves the machine.
2. **Server-side branch protection** (FR-ATT-42a), configured and verified at
   repository registration. FR-ATT-42's hook is bypassable and says so.
3. **The hosted run page** (FR-RPT-7), which is where diffs and long content
   live, since FR-RPT-10 forbids them in chat and FR-CODE-47c makes it the
   review surface for a repo with no GitHub remote.
4. **Browser depth**: cross-call sessions (the browser dies with each call),
   an artifact store so downloads are not orphaned, tier 1 extension
   discovery (FR-PRF-6), tier 3 vision (FR-BR-3), FR-BR-7's "then position"
   rung, and file upload (FR-BR-5), which path scoping now unblocks.

### Carried from the autonomous build

- **Wire `requestApproval` into the governed loop** (`src/agent/loop.ts:1412`,
  the daemon's `startOrchestrator` call). Out of scope for autonomous tasks,
  which approve through their own path; until then a governed run that needs
  an approval is denied.

### Later phases

5. Cron and webhook triggers, recipes (FR-TRG, FR-REC).
6. Memory (FR-MEM): site knowledge, failure memory, preference memory.
7. Document parsing and structured output (FR-CAP-20, 21).
8. §24's tmux and pty-proxy attachment. Read §24.0 and §24.0.1 first: the
   shipped pull-based mechanism is *safer* than the specified push design.
9. Linux confinement. The keystore works there; the sandbox is
   `sandbox-exec` and has no Linux equivalent, so `shell` and `code` fail
   closed. It would need bubblewrap or similar.
10. Retention: `outbound_dispatch_refs`, FR-AUD-4's tiered purge, and the
    download cleanup that shares their shape.

---

## 5. Things that are true and non-obvious

- **Writing to `/dev/null` is a file write.** A blanket `(deny file-write*)`
  catches it, and since `2>/dev/null` is in practically every command, the
  first sandbox profile did not confine runs so much as stop them working.
  Enumerate the safe character devices; do NOT grant `(subpath "/dev")`,
  which includes the raw disks and is an escape from everything else.
- **The `claude` CLI honours `HTTPS_PROXY`.** Measured, not assumed, and the
  whole sandboxed-engine design rests on it: the sandbox denies direct egress
  at the kernel, so an engine that opened its own socket could not be
  confined at all. Pointed at Relay's proxy with nothing declared, it issued
  `CONNECT api.anthropic.com:443`.
- **The `claude` CLI also phones `http-intake.logs.us5.datadoghq.com`.**
  Third-party telemetry, which FR-DATA-3 forbids and the egress inventory
  does not declare. It is not on the engine's allowlist, so every coding run
  terminates it and names it in `blocked_destinations`. Worth knowing before
  anyone widens that list.
- **An unhandled socket error in the proxy killed the whole daemon.** A
  client hanging up on a refusal raises ECONNRESET, and with no listener Node
  turns that into an unhandled 'error' event. Attach handlers before anything
  can fail; a proxy any client can crash by disconnecting is a denial of
  service on everything else.
- **SBPL network rules need `localhost`, NOT `127.0.0.1`.** Verified against
  the real sandbox: `(allow network* (remote ip "127.0.0.1:PORT"))` is
  refused by the kernel filter, so a profile written that way blocks the
  egress proxy along with everything else. It fails CLOSED, so the symptom is
  "the run has no network" and the proxy never sees a connection, which is
  easy to misread as the proxy working.
- **SBPL matches RESOLVED paths.** `/tmp` is a symlink to `/private/tmp`, so
  a profile granting an unresolved path denies the writes it meant to allow.
- **A self-attack that changes nothing means the test was wrong.** Removing
  `(deny file-write*)` broke no test, because the only escape test named its
  target in `readOnlyPaths` and an explicit deny caught it. A run writing to
  the operator's home would have been allowed silently. Any guard test must
  name no grant and no denial for the thing it claims to prove.
- **`tsc` emits only JavaScript**, so `.sql` migrations never reached `dist`.
  A migration runner pointed at a missing directory applies nothing and
  reports success, which reads exactly like "already up to date".
- **The egress audit cannot run in an installed package**, which has no
  `src/` to scan. It is recorded at build time and reported with its
  timestamp; deriving it with an empty capability list fabricates an
  inconsistency.
- **Cloning a signed-in Chrome profile WORKS, confirmed on this machine.**
  The open question was whether cookies encrypted against a Keychain key
  would decrypt from a copied directory. They do: `Storage.getCookies` over
  CDP returned 543 of 547 values readable on one clone, 248 of 248 and 124
  of 124 on the others, and the operator confirmed visually that the clone
  opens signed in to the right account. So the clone path is proven end to
  end, not merely plausible.
- **Chrome never deletes `DevToolsActivePort` on exit.** A present file
  proves a browser started, not that one is alive. `profile-login` gated on
  it and refused forever after the first unclean exit, naming a dead port.
  Check the process table for the user-data directory instead.

Each of these cost real time to discover. Do not re-derive them.

- **`--max-turns` does not exist.** DEC-1 once claimed it did.
- **A `PreToolUse` hook FAILS OPEN on timeout.** Proven empirically. The tool
  call proceeds and the hook's output is discarded. A blocking approval hook
  is therefore not viable; `permissionDecision: "defer"` is what P0.4 uses.
- **Resuming a live Claude Code session silently loses a turn.** Two
  concurrent resumes fork from the same parent and one branch becomes
  invisible to every future resume. No lock exists. See §24.0.
- **`--settings` accepts inline JSON**, contradicting the docs page, so Relay
  never mutates the operator's global settings.
- **Chrome 136+ ignores remote-debugging switches for the default
  user-data directory.** Tier 2 *cannot* drive the everyday browser.
- **`claude -c` exposes no session id in argv.** Identify sessions by working
  directory via `lsof`, not by command line.
- **The secret scrubber only redacts values Relay itself brokered.** It cannot
  catch a key the operator pasted. Never derive anything shown to the operator
  from transcript content.
- **`normalizeDestination` is a hostname canonicaliser, not a URL parser.**
  Given `https://admin.acme.com/x` it returns the hostname `https`, because
  its "strip anything after a colon" step reads the scheme as a port. It
  failed closed, so nothing caught it until a URL became load-bearing. Pipe
  a destination through `destinationHost` (`src/browser/url.ts`) first.
- **CDP request interception does not pause `data:` or `blob:` URLs.**
  Verified against a real Chrome, with a regression test, because the
  origin guard's whole design depends on it: a host-based guard would
  otherwise block every inline image on the web.
- **A `beforeunload` dialog must be ACCEPTED, not dismissed.** Dismissing it
  cancels the navigation the driver itself just issued and strands the run
  on a page it asked to leave. `confirm` and `prompt` are still dismissed.
- **A capability's test double drifts, and a cast hides it.** `Tier2Page` is
  nominal (private fields), so a double had to be cast past the compiler,
  and it silently fell three versions behind in one milestone. Doubles are
  now typed against `DrivablePage`. Do not reintroduce the cast.

---

## 6. Working discipline

The operator chose **full review rigor**. These are not style preferences;
each was paid for by a defect that shipped.

- **Prove a guard by removing it.** Every fix gets a self-attack: break it,
  watch the specific test fail, restore, and confirm the restore is
  byte-identical. A guard that cannot be made to fail is not a guard.
- **A test that cannot fail is not a test.** Fixtures that describe a format
  the system does not use will pass forever. Twenty smoke tests passed while
  the nonce comparison could never be true.
- **Test through the production path.** A module with no caller is not a
  feature. This project has shipped complete, tested, uncalled modules more
  than once and mistaken them for working.
- **Run the real artifact.** Three of the last milestone's findings came from
  starting the daemon or running the CLI, not from reading code.
- **Verify every relayed finding before acting.** Roughly seven claims this
  project acted on turned out not to exist. Check the code, then decide.
- **Never `git add -A`.** Stage explicit paths.
- **Migrations are history.** Never edit an applied one; add a forward
  migration. Tests migrate an empty database and will never catch it.
- **Silence is the worst failure.** If something did not happen, say so.
- **Rule 45:** no dash as sentence punctuation, in prose or comments.

---

## 7. Carried items

- **The registry commands do a read-modify-write with no lock.** Two
  concurrent `relay profile-add` runs would lose one edit. Acceptable for a
  command an operator runs by hand; not acceptable if anything ever calls
  them programmatically.
- **`config/profiles.yaml` left this operator's `scratch` path in git
  history** before it was untracked. There is no remote, so the history is
  local only, and it is a path rather than a credential. Rewriting history
  would be disproportionate; worth knowing before a remote is ever added.

- A policy-refused run ends in DB state `failed`; the distinction lives only
  in the report text.
- FR-POL-7's global-per-day, token, per-origin-rate and per-capability-count
  caps are unbuilt; the three currency scopes exist.
- `outbound_dispatch_refs` has no retention plan.
- The resume-rejection detector keys on `total_cost_usd === 0`, which is
  fragile.
- Agents share one working tree. Prefer a git worktree per agent: stale
  in-memory copies overwrote one file four times in a single session.
- The browser capability declares `requiresMachineLock: true` for both
  tiers. FR-CAP-3's own example says a headless browser action does not
  need the lock, and this build's tier 2 browser is headless, so the
  declaration is conservative rather than accurate. A per-tier declaration
  is a change to the registry's contract.
- `detectHumanBlock` is a string-matching heuristic over known vendor
  markers and wording. It will miss a bot wall nobody here has seen. Its
  output carries evidence and a confidence for exactly that reason.
- **The daemon exits on purpose and needs a supervisor.** Its health check
  exits non-zero after three failed Slack connectivity checks, deliberately,
  because an in-process reconnect is one more thing that can fail silently.
  For months the documented start was `nohup ... &`, so nothing restarted it:
  on 2026-08-23 a transient `getaddrinfo ENOTFOUND slack.com` exited it and
  Relay stayed down for two days. `relay install-service --start` installs a launchd
  agent, and `relay doctor` now reports `supervisor` as degraded when one is
  missing. Never start it with a bare `nohup`.
- **A daemon that "is running" may never have connected.** Seen in
  production on 2026-08-11 after several restarts in quick succession:
  `pgrep` showed the process, Socket Mode had never completed its
  handshake, and the log was nothing but Bolt pong warnings followed by
  `Cannot use a pool after calling end on the pool` every two seconds. The
  cause was an orphaned startup outliving its own deadline; fixed, with a
  test. **The check that tells them apart is the log line "orchestrator is
  running: Socket Mode is connected".** A running process is not evidence.
- **The browser integration suites flake under parallel load, and it is
  contention rather than a logic bug.** Recorded precisely because an
  earlier entry here called it "one unexplained intermittent", which was
  the wrong diagnosis. Caught by running the suite repeatedly to a file:
  one run took **369 seconds against a normal 27**, and twelve tests in
  `page.integration.test.ts` timed out at 30s each, every one of them
  after the first, because they share a browser opened in `beforeAll`.
  Eight test files each launch a real Chrome and vitest runs files in
  parallel, so on a loaded machine a 30 second navigation timeout is
  genuinely reachable. Roughly one run in ten. If this becomes annoying
  the fix is to cap file parallelism for the browser suites, not to raise
  the timeouts, which would only hide it.
- **Relay's self-protection is a narrowing, not a boundary** (user decision
  7). A same-user process can rewrite the helper, its pid file, Relay's
  source or plist.
  `relay secrets migrate` does not change the `relay` owner role's password,
  which the test suite's defaults still use, so anything that reads them can
  connect as the owner of relay's databases (not a superuser; it has
  CREATEDB for the test databases and CREATEROLE to provision `relay_app`). Rotating it would mean moving the
  test database to another role first.
- **Unverified: `relay-secrets status` raising no dialog.** Its probe read
  sets `kSecUseAuthenticationUIFail`; whether that suppresses the legacy
  file-keychain ACL dialog (rather than only data-protection keychain UI) has
  not been tried against a real keychain. If it does not, an operator running
  `relay secrets migrate` or doctor on a stale item sees a dialog for the
  helper and should deny it.
- **The helper's parent check is pid file plus executable path.** A stale
  pid file (daemon killed with SIGKILL, so its exit handler never ran) still
  names a pid another process may reuse; that process must also be the
  daemon's node binary to be answered. A same-user process running its own
  node with a forged pid file is not stopped.
- Lows from the part E review, recorded rather than fixed: `provisionAppRole`
  hands relay's tables, sequences, types and functions to `relay_app` but not
  extensions (relay's migrations create none); `egress.ts` `wiredBy` and
  `VENDOR_LAUNCHER_SPAWNS` compare against paths as the scanner reports them,
  `src/...` relative to the repository root, so a scan from another root
  reports the browser and git remote entries as inconsistent.
- **Clicking "Always Allow" on a `relay-…` Keychain dialog undoes the
  access list** for that item: it adds the asking program, and a worker's
  shell can then read it through `security`. The operator allows once, never
  always. Rebuilding the helper changes its signature, so items prompt again
  until `relay secrets migrate` recreates them.
- The governed loop's `requestApproval` is still unwired; see section 4.
- A page read is bounded at 100,000 characters, a step observation shown to
  the model at 20,000, and console and network capture at 200 records each.
  Every bound reports when it bites. None of them is measured; they are
  chosen.

---

## 8. Instruction for the next session

Work autonomously. Do not stop after each task, and do not ask for approval
between milestones; the operator has given standing authorisation to continue
until Relay is complete or you are genuinely blocked.

Use subagents for parallel work on disjoint files, and give each one explicit
file ownership plus a required self-attack. Dispatch the next task as soon as
one reports rather than waiting.

Stop only for: a decision that is genuinely the operator's, a destructive or
outward-facing action needing confirmation, or a blocker you cannot resolve.

When something you told the operator turns out to be wrong, correct it
plainly and immediately. That happened several times here and mattered more
than the code did.
