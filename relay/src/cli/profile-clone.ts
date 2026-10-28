/**
 * `relay profile-clone --from "Profile 10" --to acme`: copy an existing,
 * already-signed-in Chrome profile out of Chrome's own directory into a
 * dedicated automation one Relay can actually drive.
 *
 * WHY THIS EXISTS AT ALL. The operator's reasonable expectation is "my
 * profiles are already logged in, just point Relay at them". That cannot
 * work, for two independently fatal reasons:
 *
 *   - Chrome 136 and later ignore remote-debugging switches for the DEFAULT
 *     user-data directory (FR-PRF-6a). A profile there is undrivable on
 *     tier 2 no matter what else is true.
 *   - A user-data directory permits one running browser instance. The
 *     everyday Chrome already holds that one.
 *
 * The logins, though, are not tied to the user-data directory. They live in
 * the PROFILE directory: cookies, tokens, local storage. So the sessions can
 * be carried across by copying that directory, and the operator does not
 * have to sign in again anywhere. That is the whole trick.
 *
 * THIS DUPLICATES CREDENTIAL MATERIAL, and the command says so out loud
 * rather than burying it. A cloned profile is a second copy of cookies and
 * saved passwords, on disk, which Relay will then drive unattended. It is
 * scoped afterwards by the profile's origin allowlist, but a copy is a copy,
 * and an operator should make that trade knowingly.
 *
 * CHROME MUST BE QUIT. Its cookie store is live SQLite. Copying it mid-write
 * yields a file that is subtly corrupt rather than obviously broken: it
 * copies fine, Chrome opens it, and the sessions are simply gone, with
 * nothing saying why. So this refuses while Chrome is running instead of
 * producing that.
 *
 * ONLY `os_crypt` IS CARRIED OVER FROM `Local State`. That file also holds
 * `profile.info_cache`, which lists every OTHER profile's display name and
 * signed-in email address. Copying it wholesale would scatter the operator's
 * full account list into each automation directory for no benefit. A minimal
 * Local State carrying only the encryption section is written instead, which
 * is correct on the platforms that keep the key there and harmless on macOS,
 * which keeps it in the Keychain.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import { isDefaultChromeUserDataDir } from '../profiles/tiers.js'

/** Where cloned automation profiles live by default. Visible and easy to delete, unlike a dotted directory. */
export const DEFAULT_CLONE_ROOT = 'chrome-profiles'

/**
 * Directories inside a Chrome profile that are pure cache.
 *
 * Excluded because they are large, regenerate themselves, and carry nothing
 * a session needs. A real profile's caches routinely run to gigabytes,
 * which turns a two second copy into a two minute one for no gain.
 */
export const CACHE_DIRECTORY_NAMES: readonly string[] = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'component_crx_cache',
  'extensions_crx_cache',
  'optimization_guide_model_store',
  'optimization_guide_prediction_model_downloads',
]

export type ProfileCloneOptions = {
  /** The Chrome profile directory name, as it appears in Chrome's own folder: "Default", "Profile 10". */
  readonly from: string
  /** The Relay profile name, which is also the new user-data directory's name. */
  readonly to: string
  readonly home?: string
  readonly platform?: NodeJS.Platform
  /** Where cloned profiles are written. Defaults to `<home>/chrome-profiles`. */
  readonly root?: string
  readonly chromeUserDataDir?: string
  readonly force?: boolean
  /** Set when the caller will register the profile itself, so the report does not also tell the operator to paste a block by hand. */
  readonly suppressRegistryBlock?: boolean
  /** Test seams. Production checks the real process table and copies real files. */
  readonly chromeRunningCheck?: (platform: NodeJS.Platform) => ChromeRunningCheck
  readonly copyProfile?: (from: string, to: string) => void
  readonly makeDirectory?: (path: string) => void
  readonly removeDirectory?: (path: string) => void
  readonly readLocalState?: (path: string) => string | undefined
  readonly writeLocalState?: (path: string, contents: string) => void
  readonly pathExists?: (path: string) => boolean
}

export type ProfileCloneResult = {
  readonly report: string
  readonly exitCode: number
  /**
   * Where the clone landed, on success. Present so the caller can register
   * it without re-deriving the path: two independent computations of the
   * same directory is how a registry entry ends up pointing at nothing.
   */
  readonly destination?: string
}

/**
 * The process-name fragments a running Chrome shows under, per platform.
 *
 * Platform-specific because the names genuinely differ, and getting this
 * wrong is not a cosmetic bug: a guard that matches nothing reports "no
 * Chrome running" and produces exactly the silently-signed-out clone it
 * exists to prevent. The first version matched only the macOS name
 * "Google Chrome", so on Linux, where the binary is `chrome` or
 * `google-chrome`, it failed OPEN.
 *
 * Matched case-insensitively against the full command line, so a path like
 * /opt/google/chrome/chrome matches on its own.
 */
export function chromeProcessNames(platform: NodeJS.Platform): readonly string[] {
  if (platform === 'darwin') return ['google chrome', 'chromium']
  return ['google-chrome', 'chromium', '/chrome']
}

export type ChromeRunningCheck = 'running' | 'not_running' | 'unsupported_platform'

/**
 * Whether a Chrome is running at all.
 *
 * Deliberately not "is a Chrome running against THIS user-data directory".
 * Chrome is routinely launched with no explicit `--user-data-dir`, so that
 * flag is absent from the argv of exactly the process this needs to find,
 * and a check keyed on it would return "clear" for the one case that
 * matters. Refusing while any Chrome runs is a coarser answer and the only
 * one that is not confidently wrong.
 *
 * Windows returns `unsupported_platform` rather than a guess. `ps` does not
 * exist there, and the first version's `catch` turned that into "running",
 * which meant the command refused forever with a reason that was not true.
 * A stated "not implemented here" is worth more than either a permanent
 * false refusal or a dangerous false clear.
 */
function defaultChromeRunningCheck(platform: NodeJS.Platform): ChromeRunningCheck {
  if (platform === 'win32') return 'unsupported_platform'
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' }).toLowerCase()
    const names = chromeProcessNames(platform)
    const running = out
      .split('\n')
      .some((line) => !line.includes('--headless') && names.some((name) => line.includes(name)))
    return running ? 'running' : 'not_running'
  } catch {
    // Unable to tell. Treated as running, so the refusal is the default:
    // guessing "not running" risks the silent corruption this guard exists
    // to prevent.
    return 'running'
  }
}

/**
 * Whether a profile name is one this command will accept.
 *
 * Both `--from` and `--to` are pasted into a path, so a value containing a
 * separator or `..` escapes the directory it is supposed to stay inside:
 * `--from ../../..` reads outside Chrome's folder, `--to ../../elsewhere`
 * writes outside the clone root. `--to` additionally becomes a profile name
 * in profiles.yaml, where a slash is meaningless.
 *
 * A leading dot is refused too, so a clone cannot be hidden from the
 * operator who later has to find and delete it.
 */
export function isSafeProfileName(name: string): boolean {
  if (name.trim().length === 0) return false
  if (name.startsWith('.')) return false
  return !/[\\/]/.test(name) && !name.includes('..')
}

/** Whether `child` is inside `parent`, by path segment rather than by string prefix. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  // A bare `startsWith` prefix match wrongly refused siblings:
  // ".../Google/Chrome-automation" starts with ".../Google/Chrome".
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function defaultCopyProfile(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    // Dereferenced rather than preserved: a symlink pointing back into the
    // live profile would make the clone follow the original's state.
    dereference: true,
    filter: (source) => !CACHE_DIRECTORY_NAMES.includes(basename(source)),
  })
}

/** The Chrome directory a profile is cloned FROM, per platform. Mirrors src/profiles/tiers.ts's own list rather than re-deriving it. */
export function defaultChromeUserDataDir(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Google', 'Chrome')
  if (platform === 'win32') return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  return join(home, '.config', 'google-chrome')
}

/**
 * Builds the `Local State` the clone gets: the source's `os_crypt` section
 * and nothing else. See this file's header comment on why the rest is
 * deliberately left behind.
 */
export function minimalLocalState(sourceContents: string | undefined): string {
  let osCrypt: unknown = {}
  if (sourceContents !== undefined) {
    try {
      const parsed: unknown = JSON.parse(sourceContents)
      if (typeof parsed === 'object' && parsed !== null) {
        const section = (parsed as Record<string, unknown>)['os_crypt']
        if (typeof section === 'object' && section !== null) osCrypt = section
      }
    } catch {
      // An unreadable Local State is not fatal: on macOS the key lives in
      // the Keychain, so an empty os_crypt still yields a working clone.
      // Writing a valid, empty one beats writing nothing.
    }
  }
  return JSON.stringify({ os_crypt: osCrypt }, null, 2)
}

export type ChromeProfileSummary = {
  /** The FOLDER name, which is what `--from` takes: "Default", "Profile 10". */
  readonly directory: string
  /** Chrome's own display name for it. */
  readonly name: string
  /** The signed-in account, where there is one. */
  readonly account?: string
}

/**
 * Lists the Chrome profiles available to clone.
 *
 * Exists because `--from` takes the FOLDER name and Chrome only ever shows
 * the display name. "Profile 10" and "you@acme.example" are the same
 * profile, and an operator has no way to know that without this. Cloning
 * the wrong one means driving the wrong account, which is the single
 * failure the whole profile design exists to prevent.
 */
export function listChromeProfiles(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  readLocalState?: (path: string) => string | undefined,
): readonly ChromeProfileSummary[] {
  const chromeDir = defaultChromeUserDataDir(home, platform)
  const read = readLocalState ?? ((path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))
  const contents = read(join(chromeDir, 'Local State'))
  if (contents === undefined) return []

  let cache: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(contents)
    const profile = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['profile'] : undefined
    const info = typeof profile === 'object' && profile !== null ? (profile as Record<string, unknown>)['info_cache'] : undefined
    if (typeof info === 'object' && info !== null) cache = info as Record<string, unknown>
  } catch {
    return []
  }

  return Object.entries(cache)
    .map(([directory, raw]) => {
      const entry = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      const account = typeof entry['user_name'] === 'string' && entry['user_name'].length > 0 ? entry['user_name'] : undefined
      return {
        directory,
        name: typeof entry['name'] === 'string' ? entry['name'] : directory,
        ...(account !== undefined ? { account } : {}),
      }
    })
    .sort((a, b) => a.directory.localeCompare(b.directory))
}

export function formatChromeProfiles(profiles: readonly ChromeProfileSummary[]): string {
  if (profiles.length === 0) {
    return 'No Chrome profiles were found. Chrome may not be installed, or its Local State file could not be read.'
  }
  const rows = profiles.map(
    (profile) => `  ${profile.directory.padEnd(12)} ${profile.name.padEnd(28)} ${profile.account ?? '(no account)'}`,
  )
  return [
    'Chrome profiles available to clone. The FIRST column is what --from takes:',
    '',
    ...rows,
    '',
    'Clone one with: relay profile-clone --from "<folder>" --to <relay-name>',
  ].join('\n')
}

/**
 * Clones `from` into a new automation user-data directory, or explains why
 * it will not.
 *
 * Never throws for an ordinary problem. This is a setup command and its
 * whole job is to say what to do next.
 */
export function runProfileClone(options: ProfileCloneOptions): ProfileCloneResult {
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const exists = options.pathExists ?? existsSync
  const chromeDir = options.chromeUserDataDir ?? defaultChromeUserDataDir(home, platform)
  const root = options.root ?? join(home, DEFAULT_CLONE_ROOT)
  const destination = resolve(join(root, options.to))
  const source = join(chromeDir, options.from)

  if (!isSafeProfileName(options.from) || !isSafeProfileName(options.to)) {
    return {
      report:
        'Both --from and --to are pasted into a filesystem path, so neither may contain a path separator, "..", ' +
        'or a leading dot. --from is a Chrome profile FOLDER name such as "Profile 10"; --to is a short name for ' +
        'the Relay profile, such as "acme".',
      exitCode: 1,
    }
  }

  // See defaultChromeRunningCheck: copying a live cookie store yields a
  // clone whose sessions are silently gone rather than one that fails
  // loudly.
  const running = (options.chromeRunningCheck ?? defaultChromeRunningCheck)(platform)
  if (running === 'unsupported_platform') {
    return {
      report:
        `This command cannot tell whether Chrome is running on ${platform}, and copying a live cookie store ` +
        'produces a clone that is silently signed out. Rather than guess, it declines here. Quit Chrome and copy ' +
        'the profile directory by hand if you need this on this platform.',
      exitCode: 1,
    }
  }
  if (running === 'running') {
    return {
      report:
        'Chrome is running, so this would copy a cookie database that is being written to. The copy would ' +
        'succeed, and the cloned profile would silently be signed out, with nothing explaining why. Quit Chrome ' +
        'completely (Cmd-Q, not just closing the windows) and run this again.',
      exitCode: 1,
    }
  }

  if (!exists(source)) {
    return {
      report:
        `No Chrome profile directory at "${source}". The name is the FOLDER name, such as "Default" or ` +
        '"Profile 10", not the display name Chrome shows you. Run `relay profile-list` to see them with their ' +
        'accounts.',
      exitCode: 1,
    }
  }

  // The whole point is to land OUTSIDE Chrome's own directory. A destination
  // inside it would reproduce exactly the condition (FR-PRF-6a) that makes
  // the original undrivable.
  if (isDefaultChromeUserDataDir(destination, home, platform) || isInside(chromeDir, destination)) {
    return {
      report:
        `"${destination}" is inside Chrome's own user-data directory. Cloning there would reproduce the exact ` +
        'problem this command exists to solve: Chrome 136 and later ignore remote-debugging switches for that ' +
        'directory, so Relay could never drive the clone either (FR-PRF-6a). Choose a destination outside it.',
      exitCode: 1,
    }
  }

  if (exists(destination) && options.force !== true) {
    return {
      report:
        `"${destination}" already exists. Refusing to overwrite a profile directory: if Relay has already driven ` +
        'it, it holds cookies that are now newer than the ones being copied over them. Delete it yourself, or ' +
        'pass --force if that is what you intend.',
      exitCode: 1,
    }
  }

  const profileDestination = join(destination, 'Default')
  try {
    // REPLACED, not merged. `cp -r` over an existing profile overwrites the
    // files it copies and leaves everything else in place, so a re-clone
    // would keep stale state from the previous one: old local storage, old
    // preferences, files the source no longer has. A profile that is half
    // one snapshot and half another is not a profile anybody reasoned about.
    if (options.force === true) {
      ;(options.removeDirectory ?? ((path: string) => rmSync(path, { recursive: true, force: true })))(profileDestination)
    }
    ;(options.makeDirectory ?? ((path: string) => mkdirSync(path, { recursive: true })))(destination)
    ;(options.copyProfile ?? defaultCopyProfile)(source, profileDestination)
  } catch (error) {
    return {
      report: `Copying "${source}" failed: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    }
  }

  const readState = options.readLocalState ?? ((path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))
  const writeState = options.writeLocalState ?? ((path: string, contents: string) => writeFileSync(path, contents, 'utf8'))
  writeState(join(destination, 'Local State'), minimalLocalState(readState(join(chromeDir, 'Local State'))))

  // The paste-this-block ending is the FALLBACK, used only when the caller
  // is not going to register the profile itself. Printing a block to copy
  // when the very next line of output says "registered profile" would be
  // two contradictory instructions for one action.
  const registryInstructions = options.suppressRegistryBlock === true
    ? ['Registering it now, with the origins you passed.']
    : [
        'Its cookies came with it, so you do not need to sign in again. Add this to config/profiles.yaml,',
        'replacing the origins with the sites this profile should be allowed to reach:',
        '',
        `  - name: ${options.to}`,
        `    description: Cloned from Chrome's "${options.from}"`,
        `    project: ${options.to}`,
        `    user_data_dir: ${destination}`,
        '    profile_directory: Default',
        '    classification: client',
        '    allowed_origins:',
        "      - 'example.com'",
        "      - '*.example.com'",
        '    extension: false',
        '    pinned_tier: 2',
        '',
        'Anything not in allowed_origins is PREVENTED, not merely discouraged, so list every host the task needs.',
        'Then run: relay doctor',
        '',
        'Or skip the paste entirely and let Relay write it:',
        `  relay profile-add ${options.to} --dir ${destination} --origin example.com`,
      ]

  return {
    report: [
      `Cloned "${options.from}" to ${destination}.`,
      '',
      ...registryInstructions,
      '',
      'Note: this is a second copy of that profile\'s cookies and saved passwords, and Relay will drive it',
      'unattended. Delete the directory above to revoke it.',
    ].join('\n'),
    exitCode: 0,
    destination,
  }
}
