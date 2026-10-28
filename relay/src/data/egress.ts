/**
 * FR-DATA-2 and FR-DATA-14: the declared egress inventory, and the
 * comparison that checks it against what Relay's own code actually
 * reaches.
 *
 * THE BOUNDARY THIS FILE DOES NOT CROSS, stated up front because it matters
 * more here than the mechanism does. FR-SH-6 describes an ENFORCING local
 * proxy: every process Relay spawns is denied direct outbound networking
 * and forced through it, so an undeclared destination cannot be reached at
 * all, regardless of what any inventory says. That proxy does not exist in
 * this codebase. This file is the other half FR-DATA-14 asks for on its
 * own: a truthful list of where task data is meant to go, and a check that
 * compares it against what the source tree actually contains today. A
 * reader must not conclude that anything in this file BLOCKS a call to an
 * undeclared destination. It only reports one, after the fact, the same
 * way `relay doctor`'s other checks report a problem rather than fix it.
 * An honest inventory with no enforcement behind it yet is still worth
 * more than a proxy built against an incomplete one, which is the order
 * this milestone does the work in.
 *
 * THE SCANNER IS A HEURISTIC TEXT SCAN, NOT A CALL-GRAPH ANALYSIS. It reads
 * every `.ts` file under a root directory and looks for two literal
 * shapes: a `fetch`-like call whose first argument is an `http(s)://` URL
 * literal, and a `spawn`/`execFile` call whose first argument is a string
 * literal or a same-file `const` it can resolve to one. It cannot see a
 * destination built at runtime, concatenated from parts, read from config,
 * or reached through a vendor SDK's own internals (`@slack/bolt`,
 * `@slack/web-api`) rather than a direct call in this repository's own
 * source. Every such gap is named explicitly in `compareEgressToSource`'s
 * `assumed` list, rather than silently treated as "checked and clean".
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { originMatches } from '../policy/origin-match.js'

// ---------------------------------------------------------------------------
// The declared inventory, per FR-DATA-2's closed list.
// ---------------------------------------------------------------------------

export const EGRESS_CATEGORIES = [
  'chat_platform',
  'model_provider',
  'code_reviewer',
  'git_remote',
  'approved_action_target',
  'autonomous_browser_read',
] as const
export type EgressCategory = (typeof EGRESS_CATEGORIES)[number]

export type EgressDestination = {
  readonly name: string
  readonly category: EgressCategory
  /** Why Relay reaches this destination, tied to the requirement that names it. */
  readonly reason: string
  /** Fixed hostnames this destination is known to answer to. Empty for a destination with no single fixed host (see `hosts.length === 0` entries below). */
  readonly hosts: readonly string[]
  /** The vendor CLI binary Relay spawns to reach this destination, when reached that way rather than by a direct fetch. */
  readonly vendorBinary?: string
  /** FR-SET-10 / FR-REV-4: whether first use requires the operator's explicit, logged acknowledgement, distinct from every other declared destination that needs none because using the feature at all already implies consent. */
  readonly requiresOperatorAcknowledgement: boolean
  /**
   * Whether Relay's OWN code, in this build, actually contains a call path
   * that reaches this destination. `false` is not an error: it means
   * "declared ahead of the capability that will use it", per FR-DATA-2
   * naming the whole closed list up front rather than growing it capability
   * by capability. `compareEgressToSource` treats a mismatch between this
   * flag and what it actually finds as the problem, not the flag itself.
   */
  readonly wiredInThisBuild: boolean
  /** Named gaps this inventory does not claim to close for this destination. Empty when there is nothing to disclose. */
  readonly knownGaps: readonly string[]
  /** For a dynamic destination with no fixed host: the source file whose presence under the scanned root is its structural evidence. */
  readonly wiredBy?: string
}

export const EGRESS_INVENTORY: readonly EgressDestination[] = [
  {
    name: 'Slack',
    category: 'chat_platform',
    reason:
      "The configured chat platform (FR-DATA-2): where task requests arrive and where the single-sink result is " +
      'delivered (FR-DATA-1a, FR-DATA-5), plus relay doctor\'s own token and connectivity checks.',
    hosts: ['slack.com', 'files.slack.com'],
    requiresOperatorAcknowledgement: false,
    wiredInThisBuild: true,
    knownGaps: [
      'Reached both directly (src/doctor/checks/slack.ts\'s own fetch calls) and through the @slack/bolt and ' +
        '@slack/web-api SDKs (src/chat/slack/adapter.ts). This inventory does not independently verify the SDKs\' ' +
        'own internal calls: they may use additional Slack-owned subdomains, for example Socket Mode\'s wss:// ' +
        'endpoint, that a text scan of Relay\'s own source cannot see, since the SDK makes those calls itself.',
      'files.slack.com is where autonomous file intake (src/autonomous/files.ts) downloads a thread\'s attachments ' +
        'from their url_private, a URL Slack returns at runtime, so the scan cannot see it as a literal.',
    ],
  },
  {
    name: 'Anthropic (model provider, via the claude CLI)',
    category: 'model_provider',
    reason:
      "The configured model provider (FR-DATA-2, FR-DATA-6): the agent loop's planning and decision calls. Relay " +
      'never calls the model provider\'s API directly; it spawns the operator\'s already-authenticated `claude` CLI ' +
      '(src/agent/loop.ts, DEC-1), and the CLI makes its own network calls on Relay\'s behalf.',
    hosts: ['api.anthropic.com'],
    vendorBinary: 'claude',
    requiresOperatorAcknowledgement: false,
    wiredInThisBuild: true,
    knownGaps: [
      'api.anthropic.com is declared from the vendor\'s own published API endpoint, not confirmed by anything in ' +
        'this repository: Relay\'s source never names this host, since the CLI, not Relay, owns the connection. ' +
        'This inventory cannot see inside the claude binary.',
      'Any telemetry, crash reporting, or update-check traffic the claude CLI itself makes is not independently ' +
        'enumerated here. Per FR-DATA-3, Relay sets the vendor telemetry opt-out where the CLI offers one, but does ' +
        'not control or verify the CLI\'s own network behaviour beyond that.',
    ],
  },
  {
    name: 'OpenAI Codex (external code reviewer, via the codex CLI)',
    category: 'code_reviewer',
    reason:
      "The external code reviewer the operator has explicitly accepted (FR-REV-4, FR-DATA-11): `codex exec` " +
      'transmits a repository\'s diff for review, and an autonomous task may run on a codex account from the pool ' +
      '(src/autonomous/worker.ts), which sends the task\'s context the same way. This is the one deliberate ' +
      'exception to the single-sink rule, named and acknowledged rather than hidden.',
    hosts: ['api.openai.com'],
    vendorBinary: 'codex',
    requiresOperatorAcknowledgement: true,
    wiredInThisBuild: true,
    knownGaps: [
      'Spawned through the start gate in src/process/gated-spawn.ts at the configured autonomous.codex_bin path, so ' +
        'the scan sees the /bin/sh launcher there, not a literal codex (VENDOR_LAUNCHER_SPAWNS).',
      'api.openai.com is declared from the vendor\'s own published endpoint, not confirmed by anything in this ' +
        'repository.',
      'Vendor telemetry beyond the review API is not independently enumerated here, matching the same gap named ' +
        'for Anthropic above.',
    ],
  },
  {
    name: 'Registered git remotes',
    category: 'git_remote',
    reason:
      "A registered repository's own configured remote (FR-DATA-2): where a Relay-initiated push or PR goes, " +
      'gated by the code.publish capability (FR-CODE-22).',
    hosts: [],
    requiresOperatorAcknowledgement: false,
    wiredInThisBuild: true,
    wiredBy: 'src/autonomous/remote-write.ts',
    knownGaps: [
      'Reached by relay itself, never the worker: an approved autonomous remote write runs git and gh from ' +
        'src/autonomous/remote-write.ts, with a relay-owned git config and one approval per operation.',
      'Genuinely dynamic: the destination is whichever remote the operator registered for that ' +
        'repository, reached by a direct git remote URL or by the gh CLI for PR operations. There is no single ' +
        'fixed host this inventory can name in advance, unlike the other entries above.',
    ],
  },
  {
    name: 'The explicit, approved target of the current action',
    category: 'approved_action_target',
    reason:
      "FR-DATA-1(b): the explicit target of a task action the operator has approved, for example a browser " +
      'navigation. Resolved per call, never a fixed host: every capability that reaches one declares it via ' +
      'CapabilityDefinition.destinationOf, so the policy engine can govern it before the capability runs (see ' +
      'src/agent/capabilities/browser.ts).',
    hosts: [],
    requiresOperatorAcknowledgement: false,
    wiredInThisBuild: true,
    knownGaps: [
      'This inventory does not enumerate individual destinations for this category; there is no fixed list to ' +
        'name. It verifies structurally that at least one registered capability declares destinationOf, and relies ' +
        'on that capability\'s own origin enforcement (a browser profile\'s allowlist, FR-PRF-4) to bound where it ' +
        'can actually go, which this file does not re-check.',
      'That reliance is only as strong as the tier the call lands on, and the two differ. On TIER 2 the bound is ' +
        'now real: src/browser/tier2/page.ts pauses every request the page makes at the CDP Fetch layer and fails ' +
        'the ones outside the profile\'s allowlist, so an undeclared destination is not reached. On TIER 1 the ' +
        'Claude-in-Chrome extension owns navigation, so Relay refuses to issue an off-allowlist navigation and ' +
        'detects one afterwards, and this category is bounded by detection rather than by prevention there. Tier 3 ' +
        'has no driver in this build at all.',
    ],
  },
  {
    name: 'Autonomous worker browsing (headless Playwright behind the egress proxy)',
    category: 'autonomous_browser_read',
    reason:
      "An autonomous worker's headless Playwright browser reads remote pages for its task (plan decision 2). It " +
      'launches through src/autonomous/egress-proxy.ts, which lets every method reach loopback and only GET and HEAD ' +
      'reach any other host, terminating TLS with a per-task certificate authority so HTTPS methods are seen too.',
    hosts: [],
    requiresOperatorAcknowledgement: false,
    wiredInThisBuild: true,
    wiredBy: 'src/autonomous/egress-proxy.ts',
    knownGaps: [
      'Any host, by design: the proxy bounds the method, not the destination, so a remote GET with a side effect is ' +
        'not stopped, and what a page sends in a GET query string is not inspected.',
      'Checked structurally, by the proxy module being present under the scanned source; this file does not ' +
        're-check that every worker browser is actually launched through it.',
      'playwright-extension (the operator\'s own Chrome) cannot sit behind the proxy; it runs only on a per-task ' +
        'grant and its interactions go through the MCP gateway\'s per-operation approval instead.',
    ],
  },
]

// ---------------------------------------------------------------------------
// The scanner: what Relay's own source under `rootDir` literally contains.
// ---------------------------------------------------------------------------

export type FetchHostEvidence = { readonly host: string; readonly file: string; readonly line: number }
export type SpawnedBinaryEvidence = { readonly binary: string; readonly file: string; readonly line: number }
/** A spawn/execFile call site whose target could not be resolved to a literal: either a genuinely dynamic value, or a same-file `const` this scanner's simple pattern did not match. Always reported, never silently dropped. */
export type UnresolvedSpawnEvidence = { readonly identifier: string; readonly file: string; readonly line: number }

export type SourceEgressEvidence = {
  /** Every file the scan read, for a dynamic destination's `wiredBy`. */
  readonly scannedFiles: readonly string[]
  readonly fetchHosts: readonly FetchHostEvidence[]
  readonly spawnedBinaries: readonly SpawnedBinaryEvidence[]
  readonly unresolvedSpawnTargets: readonly UnresolvedSpawnEvidence[]
}

/** Binaries known to reach only the local machine, never the network, so a match here is not compared against the egress inventory at all. Each entry is grounded in a specific call site this scanner actually finds, not a guess. */
export const LOCAL_ONLY_SPAWN_BINARIES: Readonly<Record<string, string>> = {
  security: 'the macOS Keychain CLI (src/secrets/keychain.ts); reads local Keychain items over IPC, no network call',
  'secret-tool':
    'the freedesktop Secret Service CLI (src/secrets/libsecret.ts), the Linux counterpart of the Keychain entry ' +
    'above; reads local keystore items over D-Bus, no network call',
  openssl:
    'generates the egress proxy\'s per-task certificate authority and leaf certificates on disk ' +
    '(src/autonomous/egress-proxy.ts); no network call',
}

/**
 * A spawn site whose literal binary is only a launcher that execs a vendor
 * CLI chosen at runtime. Its spawn counts as evidence for those vendor
 * binaries instead of reading as an undeclared `sh`.
 */
export const VENDOR_LAUNCHER_SPAWNS: Readonly<Record<string, { readonly launcher: string; readonly vendorBinaries: readonly string[] }>> = {
  // `/bin/sh -c 'read -r go && exec "$0" "$@"' <bin>`: the start gate for
  // direct sessions and autonomous workers, whose <bin> is claude or codex.
  'src/process/gated-spawn.ts': { launcher: 'sh', vendorBinaries: ['claude', 'codex'] },
}

/** A file whose unresolved spawn target has a known, specific explanation, so the finding is reported WITH that explanation rather than reading as a bare unknown. Every entry here is grounded in a file this project's author has actually read, per this task's own honesty requirement, not assumed safe by pattern. */
export const KNOWN_UNRESOLVED_SPAWN_NOTES: Readonly<Record<string, string>> = {
  'src/browser/cdp/endpoint.ts':
    'Launches the local Chrome or Chromium executable chosen by defaultChromeExecutablePath() as a Relay-owned ' +
    'tier 2 automation browser. The browser process is not itself an egress destination. Unlike the tier 1 launch ' +
    'in src/browser/launch.ts, this one IS driven by Relay, and every request the driven page makes, of any kind, ' +
    'is paused at the CDP Fetch layer and checked against the bound profile\'s origin allowlist before it leaves ' +
    'the browser (src/browser/tier2/page.ts, FR-PRF-4). Where it is permitted to go therefore falls under the ' +
    '"explicit, approved target of the current action" entry above, not under an undeclared destination. The ' +
    'launch also passes --disable-background-networking, --disable-component-update and --disable-sync, so ' +
    "Chrome's own update, variation and sync traffic, none of which this inventory declares, is not made at all.",
  'src/secrets/libsecret.ts':
    "A generic execFile wrapper's own `file` parameter (defaultExecFile), not a fixed destination by itself; the " +
    'actual binary it is invoked with (secret-tool) is resolved and matched separately, above. Same shape as ' +
    'src/secrets/keychain.ts, and for the same reason.',
  'src/sandbox/exec.ts':
    'Spawns /usr/bin/sandbox-exec, the macOS confinement wrapper, which then execs the command it was given ' +
    '(FR-SH-6). sandbox-exec is not itself a network destination, and the process it wraps is the most tightly ' +
    'constrained one in this codebase: the generated profile denies ALL direct outbound networking at the kernel, ' +
    "so a confined run cannot reach any host on its own. Its only route out is Relay's own enforcing egress proxy " +
    '(src/sandbox/proxy.ts) on loopback, which terminates any connection to a host outside the run\'s declared ' +
    'destination list and records every attempt. Where a confined run is permitted to go therefore falls under the ' +
    '"explicit, approved target of the current action" entry, and the sandbox is what makes that list enforceable ' +
    'rather than advisory.',
  'src/cli/profile-login.ts':
    'Launches the local Chrome or Chromium executable chosen by defaultChromeExecutablePath() as an ORDINARY, ' +
    'visible browser window, so the operator can sign in to the sites a profile is for. Relay does not drive this ' +
    'window and issues it no instructions: where it goes is wherever the person at the keyboard goes, which is ' +
    'their own browsing and not Relay egress. It is the one browser launch in this codebase with no Relay-side ' +
    'origin enforcement, and deliberately so, because enforcing an allowlist against a human signing in would ' +
    'block the very login the command exists to enable.',
  'src/browser/launch.ts':
    'Launches the local Chrome or Chromium executable chosen by defaultChromeExecutablePath(). The browser ' +
    'process itself is not a network egress destination; where it subsequently navigates is governed separately ' +
    'by src/browser/enforcement.ts (FR-PRF-4), not by this inventory.',
  'src/secrets/keychain.ts':
    'A generic execFile wrapper\'s own `file` parameter (defaultExecFile), and the configured KeychainReader\'s ' +
    'file: /usr/bin/security or <RELAY_HOME>/bin/relay-secrets (native/relay-secrets), both local Keychain reads ' +
    'with no network call.',
  'src/cli/secrets.ts':
    'Runs <RELAY_HOME>/bin/relay-secrets (native/relay-secrets) and /usr/bin/security to create, read and delete ' +
    'relay\'s own Keychain items; both are local Keychain calls with no network call.',
  'src/autonomous/remote-write.ts':
    'runTool\'s `bin` is git or gh (deps.gitBin, deps.ghBin), run by relay for an approved remote write to the ' +
    'operation\'s registered remote; the "Registered git remotes" entry above.',
  'src/autonomous/mcp-gateway.ts':
    'Starts the MCP server a worker\'s gateway entry fronts, from the command in ~/.agents/mcp/servers.json. Where ' +
    'that server goes is its own business; every call a worker makes to it is gated by the gateway (read-only tools ' +
    'in policy, proxy-enforced servers, or a per-operation approval), and the headless Playwright server runs ' +
    'behind the egress proxy.',
  'src/sessions/liveness.ts':
    'A generic execFile wrapper\'s own `file` parameter (defaultExecFile), not a fixed destination by itself; the ' +
    'real invocation (`ps`, a local process listing) is made through an injected function this text scan does not ' +
    'trace through.',
}

function binaryBaseName(pathOrName: string): string {
  const segments = pathOrName.split('/')
  return segments[segments.length - 1] ?? pathOrName
}

function listTypeScriptFiles(rootDir: string): readonly string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let info: ReturnType<typeof statSync>
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        walk(full)
        continue
      }
      if (extname(full) === '.ts') out.push(full)
    }
  }
  walk(rootDir)
  return out
}

function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++
  return line
}

/**
 * The three quote characters a call's first argument may be delimited by,
 * built as one constant rather than written inline into each pattern
 * below. Building FETCH_URL_RE and SPAWN_TARGET_RE as `new RegExp(...)`
 * from template-literal strings, rather than as `/pattern/` literals, is
 * deliberate, not a style choice: a `/pattern/` literal containing a
 * character class of quote characters (`['"`) is exactly the shape that
 * broke this scanner against its OWN source while it was being built
 * (this file's stripComments doc comment tells that story). A `new
 * RegExp` call's pattern is an ordinary string, delimited by one
 * consistent quote character throughout, which is unambiguous to
 * stripComments's own simple lexer; a bare `/regex/` literal is not,
 * since stripComments does not understand regex-literal syntax at all.
 */
const QUOTE_CHARS = `'"\``

/** Matches a `fetch`-shaped call (`fetch(`, `fetchImpl(`, ...) whose first argument is an http(s) URL literal, and captures the hostname. */
const FETCH_URL_RE = new RegExp(`\\bfetch\\w*\\s*\\(\\s*[${QUOTE_CHARS}]https?://([a-zA-Z0-9.-]+)`, 'g')
/** Matches a `spawn(` or `execFile(` call and captures either a quoted literal (group 2) or a bare identifier (group 3) as its first argument. Does not follow member access (`params.executablePath` resolves only as far as `params`), which is a deliberate scope limit for a regex scanner: see this file's own header comment on what it cannot see. */
const SPAWN_TARGET_RE = new RegExp(
  `\\b(?:spawn|execFile)\\s*\\(\\s*(?:([${QUOTE_CHARS}])([^${QUOTE_CHARS}]+)\\1|([A-Za-z_$][\\w$]*))`,
  'g',
)

function resolveConstString(content: string, identifier: string): string | undefined {
  const re = new RegExp(`\\bconst\\s+${identifier}\\s*(?::[^=]+)?=\\s*['"\`]([^'"\`]+)['"\`]`)
  return re.exec(content)?.[1]
}

/**
 * Blanks out `//` and `/* *\/` comments, replacing their content with
 * spaces (newlines preserved) rather than deleting it, so every match
 * index found downstream still lines up with the ORIGINAL file's line
 * numbers. Without this, a doc comment that mentions `spawn(` or `fetch(`
 * in prose, exactly the kind this file's own header comment and this
 * scanner's own doc comments contain, would be scanned as if it were a
 * real call site. That is not a hypothetical: this file matching itself
 * was the first thing this scanner got wrong while it was being built.
 *
 * A string literal's own contents are left untouched (tracked via
 * `inString`), so a URL inside a string, `'https://example.com'`, keeps
 * its `//` rather than having the rest of the line blanked out as a
 * comment. This is a small hand-written lexer, not a real tokenizer: it
 * does not understand regex literals, so a `/pattern/` containing an
 * unescaped bare `//` could still confuse it. None of this codebase's own
 * regex literals do (their `/` is always backslash-escaped), which is
 * exactly the kind of gap this file's header comment discloses rather than
 * silently relying on.
 */
function stripComments(content: string): string {
  let out = ''
  let i = 0
  let inLineComment = false
  let inBlockComment = false
  let inString: string | undefined
  while (i < content.length) {
    const c = content[i]
    const next = content[i + 1]
    if (inLineComment) {
      out += c === '\n' ? '\n' : ' '
      if (c === '\n') inLineComment = false
      i++
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        out += '  '
        inBlockComment = false
        i += 2
        continue
      }
      out += c === '\n' ? '\n' : ' '
      i++
      continue
    }
    if (inString !== undefined) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (c === inString) inString = undefined
      i++
      continue
    }
    if (c === '/' && next === '/') {
      inLineComment = true
      out += '  '
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      inBlockComment = true
      out += '  '
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c
      out += c
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Scans every `.ts` file under `rootDir` for the two egress-relevant call
 * shapes this file's header comment describes. Default `rootDir` is `src`,
 * Relay's own production source; a test points this at a small fixture
 * directory instead, so a test proving "an undeclared destination is
 * reported" does not depend on, or need to modify, the real source tree.
 */
export function scanSourceForEgressEvidence(rootDir = 'src'): SourceEgressEvidence {
  const fetchHosts: FetchHostEvidence[] = []
  const spawnedBinaries: SpawnedBinaryEvidence[] = []
  const unresolvedSpawnTargets: UnresolvedSpawnEvidence[] = []
  const scannedFiles = listTypeScriptFiles(rootDir)

  for (const file of scannedFiles) {
    const raw = readFileSync(file, 'utf8')
    const content = stripComments(raw)

    for (const match of content.matchAll(FETCH_URL_RE)) {
      const host = match[1]
      if (host === undefined) continue
      fetchHosts.push({ host: host.toLowerCase(), file, line: lineOf(content, match.index ?? 0) })
    }

    for (const match of content.matchAll(SPAWN_TARGET_RE)) {
      const literal = match[2]
      const identifier = match[3]
      const line = lineOf(content, match.index ?? 0)
      if (literal !== undefined) {
        spawnedBinaries.push({ binary: literal, file, line })
        continue
      }
      if (identifier === undefined) continue
      const resolved = resolveConstString(content, identifier)
      if (resolved !== undefined) {
        spawnedBinaries.push({ binary: resolved, file, line })
      } else {
        unresolvedSpawnTargets.push({ identifier, file, line })
      }
    }
  }

  return { scannedFiles, fetchHosts, spawnedBinaries, unresolvedSpawnTargets }
}

// ---------------------------------------------------------------------------
// The comparison: declared inventory versus what the scan actually found.
// ---------------------------------------------------------------------------

export type EgressFinding =
  /** A declared destination, and the scan found matching evidence for it. */
  | { readonly kind: 'confirmed'; readonly destination: string; readonly evidence: string }
  /** A declared destination the scan found no evidence for, consistent with its own `wiredInThisBuild: false`. Expected, not a problem. */
  | { readonly kind: 'declared_inactive'; readonly destination: string; readonly note: string }
  /** A declared destination whose `wiredInThisBuild` flag disagrees with what the scan found, in either direction. The one finding kind this file's own gate treats as a real fault. */
  | { readonly kind: 'inconsistent'; readonly destination: string; readonly detail: string }
  /** Evidence the scan found with NO owning inventory entry. The core "reported rather than ignored" case FR-DATA-14 exists for. */
  | { readonly kind: 'undeclared'; readonly via: 'fetch' | 'spawn'; readonly target: string; readonly file: string; readonly line: number }
  /** A spawn/execFile call site the scanner could not resolve to a literal binary name. Always reported; `note` carries a specific, file-grounded explanation where one is known, per KNOWN_UNRESOLVED_SPAWN_NOTES. */
  | { readonly kind: 'unresolved'; readonly identifier: string; readonly file: string; readonly line: number; readonly note: string | undefined }

export type EgressComparison = {
  readonly findings: readonly EgressFinding[]
  /** What this comparison actually checked, in plain English, per this task's own requirement to state it. */
  readonly verified: readonly string[]
  /** What it could not check, or took from vendor documentation rather than this repository's own source, per this task's own requirement to name it rather than omit it. */
  readonly assumed: readonly string[]
}

/**
 * Compares `inventory` against `evidence`, plus the names of every
 * currently registered capability that declares `destinationOf` (the one
 * structural signal available for the dynamic `approved_action_target`
 * category, which has no fixed host to text-scan for). Pure and
 * synchronous: every fact it needs is a parameter, so the whole decision
 * table is exhaustively testable without touching a filesystem or a
 * registry, matching src/browser/enforcement.ts's own "pure, no I/O" shape.
 */
export function compareEgressToSource(
  inventory: readonly EgressDestination[],
  evidence: SourceEgressEvidence,
  capabilitiesWithDestination: readonly string[],
): EgressComparison {
  const findings: EgressFinding[] = []
  const fixedEntries = inventory.filter((entry) => entry.hosts.length > 0 || entry.vendorBinary !== undefined)
  const dynamicEntries = inventory.filter((entry) => entry.hosts.length === 0 && entry.vendorBinary === undefined)

  const ownerOfHost = (host: string): EgressDestination | undefined =>
    fixedEntries.find((entry) => entry.hosts.some((declared) => originMatches(host, declared)))
  const ownerOfBinary = (binary: string): EgressDestination | undefined => {
    const base = binaryBaseName(binary)
    return fixedEntries.find((entry) => entry.vendorBinary !== undefined && binaryBaseName(entry.vendorBinary) === base)
  }
  // A launcher spawn stands for the vendor binaries it execs, so each one
  // counts as spawned at that site.
  const launchedBinaries: SpawnedBinaryEvidence[] = []
  const directSpawns = evidence.spawnedBinaries.filter((seen) => {
    const launcher = VENDOR_LAUNCHER_SPAWNS[seen.file]
    if (launcher === undefined || binaryBaseName(seen.binary) !== launcher.launcher) return true
    for (const binary of launcher.vendorBinaries) launchedBinaries.push({ binary, file: seen.file, line: seen.line })
    return false
  })
  const spawned = [...directSpawns, ...launchedBinaries]

  for (const seen of evidence.fetchHosts) {
    const owner = ownerOfHost(seen.host)
    if (owner) {
      findings.push({ kind: 'confirmed', destination: owner.name, evidence: `fetch to ${seen.host} at ${seen.file}:${seen.line}` })
    } else {
      findings.push({ kind: 'undeclared', via: 'fetch', target: seen.host, file: seen.file, line: seen.line })
    }
  }

  for (const seen of spawned) {
    if (LOCAL_ONLY_SPAWN_BINARIES[binaryBaseName(seen.binary)] !== undefined) continue
    const owner = ownerOfBinary(seen.binary)
    if (owner) {
      findings.push({ kind: 'confirmed', destination: owner.name, evidence: `spawned ${seen.binary} at ${seen.file}:${seen.line}` })
    } else {
      findings.push({ kind: 'undeclared', via: 'spawn', target: seen.binary, file: seen.file, line: seen.line })
    }
  }

  for (const seen of evidence.unresolvedSpawnTargets) {
    findings.push({ kind: 'unresolved', identifier: seen.identifier, file: seen.file, line: seen.line, note: KNOWN_UNRESOLVED_SPAWN_NOTES[seen.file] })
  }

  for (const entry of fixedEntries) {
    const foundAsHost = entry.hosts.some((declared) => evidence.fetchHosts.some((seen) => originMatches(seen.host, declared)))
    const foundAsBinary =
      entry.vendorBinary !== undefined &&
      spawned.some((seen) => binaryBaseName(seen.binary) === binaryBaseName(entry.vendorBinary as string))
    const found = foundAsHost || foundAsBinary
    if (found === entry.wiredInThisBuild) {
      if (!found) {
        findings.push({ kind: 'declared_inactive', destination: entry.name, note: 'no matching fetch host or spawned binary found under the scanned source, consistent with wiredInThisBuild: false' })
      }
      // found && wiredInThisBuild: already recorded as 'confirmed' above, once per evidence site.
      continue
    }
    findings.push({
      kind: 'inconsistent',
      destination: entry.name,
      detail: found
        ? `wiredInThisBuild is false, but matching evidence was found under the scanned source`
        : `wiredInThisBuild is true, but no matching fetch host or spawned binary was found under the scanned source`,
    })
  }

  for (const entry of dynamicEntries) {
    const byCapability = entry.category === 'approved_action_target' && capabilitiesWithDestination.length > 0
    const byFile = entry.wiredBy !== undefined && evidence.scannedFiles.includes(entry.wiredBy)
    const found = byCapability || byFile
    if (found === entry.wiredInThisBuild) {
      if (!found) {
        findings.push({ kind: 'declared_inactive', destination: entry.name, note: 'no structural evidence checked for this dynamic destination, consistent with wiredInThisBuild: false' })
      } else {
        findings.push({
          kind: 'confirmed',
          destination: entry.name,
          evidence: byCapability
            ? `capabilities declaring destinationOf: ${capabilitiesWithDestination.join(', ')}`
            : `${entry.wiredBy} is present under the scanned source`,
        })
      }
      continue
    }
    findings.push({
      kind: 'inconsistent',
      destination: entry.name,
      detail: found
        ? byCapability
          ? `capabilities declaring destinationOf were found (${capabilitiesWithDestination.join(', ')}), but wiredInThisBuild is false`
          : `${entry.wiredBy} is present under the scanned source, but wiredInThisBuild is false`
        : entry.wiredBy !== undefined
          ? `wiredInThisBuild is true, but ${entry.wiredBy} is not under the scanned source`
          : 'wiredInThisBuild is true, but no registered capability currently declares destinationOf',
    })
  }

  return {
    findings,
    verified: [
      'Every fetch()-style call under the scanned source whose first argument is a literal http(s) URL, matched ' +
        'against each declared destination\'s hosts.',
      'Every spawn()/execFile() call under the scanned source whose target is a string literal, or a same-file ' +
        'const it resolves to, matched against each declared destination\'s vendorBinary.',
      "Each fixed-host or vendor-CLI entry's own wiredInThisBuild flag, against whether matching evidence was " +
        'actually found.',
      "The approved_action_target entry's wiredInThisBuild flag, against whether any currently registered " +
        'capability declares CapabilityDefinition.destinationOf.',
    ],
    assumed: [
      'Destinations reached only through a vendor SDK\'s own internals (for example @slack/bolt\'s Socket Mode ' +
        'connection, or whatever the claude and codex CLIs do beyond the endpoint this inventory names) are not ' +
        'independently verified; this scan can only see calls this repository\'s own source makes directly.',
      'A destination built at runtime (string concatenation, a value read from config or from a registry entry) is ' +
        'invisible to this text scan; the git_remote and approved_action_target categories are exactly this shape, ' +
        'which is why they are checked structurally above rather than by hostname.',
      'Vendor-declared hosts (api.anthropic.com, api.openai.com) are taken from each provider\'s own published API ' +
        'documentation, not confirmed against anything in this repository, since Relay never calls them directly.',
    ],
  }
}
