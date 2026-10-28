/**
 * `relay profile login <name>`: open a registered profile's browser, as a
 * normal visible window, so the operator can sign in to the sites that
 * profile is for.
 *
 * WHY THIS EXISTS AS A COMMAND RATHER THAN AN INSTRUCTION. Everything else
 * about a tier 2 profile is automated, and this one step cannot be: Relay
 * has no credentials and must never have any. So the operator signs in by
 * hand, once, and after that the profile's own cookie jar is what carries
 * the session.
 *
 * The reason it is not simply written in a README as "run Chrome with
 * --user-data-dir=..." is FR-PRF-6a. Getting that flag wrong, or omitting
 * it, signs the operator into their EVERYDAY Chrome profile instead, which
 * is the one profile tier 2 can never drive. They would then have done the
 * work and still have a profile that does not function, with nothing
 * pointing at why. This command reads the path from the registry, so the
 * directory it opens is by construction the directory Relay will later
 * drive.
 *
 * IT REFUSES A PROFILE IT WOULD BE WRONG TO OPEN. A `personal` profile is
 * excluded from all agent use (FR-PRF-5) and signing into it for Relay's
 * benefit is meaningless. A profile whose user-data directory is Chrome's
 * own default cannot be driven at all (FR-PRF-6a), so opening it would
 * produce a working login and a broken profile, which is the worst
 * combination: it looks like success.
 *
 * HEADFUL, AND IT SAYS SO. The whole point is a human at a keyboard.
 * `relay smoke` and every governed run use headless; this does not.
 */

import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { defaultConfigPath, defaultPolicyPath, defaultProfilesPath } from '../config/paths.js'

import { ConfigError } from '../config/errors.js'
import { loadProfileRegistryIfPresent } from '../config/load.js'
import { defaultChromeExecutablePath } from '../browser/launch.js'
import { readExistingDevToolsEndpoint } from '../browser/cdp/endpoint.js'
import { isDefaultChromeUserDataDir } from '../profiles/tiers.js'
import type { ProfileEntry, ProfileRegistry } from '../profiles/schema.js'

export const DEFAULT_PROFILES_PATH = defaultProfilesPath()

export type ProfileLoginOptions = {
  readonly name: string
  readonly profilesPath?: string
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly executablePath?: string
  /** Test seams. Production spawns a real Chrome and reads the real registry. */
  readonly loadRegistry?: (path: string) => ProfileRegistry
  readonly spawnChrome?: (executablePath: string, args: readonly string[]) => { readonly pid: number | undefined }
  readonly existingEndpoint?: (userDataDir: string) => { readonly port: number } | undefined
  readonly browserIsRunningOn?: (userDataDir: string, platform: NodeJS.Platform) => boolean | undefined
}

export type ProfileLoginResult = { readonly report: string; readonly exitCode: number }

function defaultSpawn(executablePath: string, args: readonly string[]): { readonly pid: number | undefined } {
  // Detached and unref'd: the operator is going to spend minutes in this
  // window, and the CLI has no business staying attached for it.
  const child = spawn(executablePath, args as string[], { stdio: 'ignore', detached: true })
  child.unref()
  return { pid: child.pid }
}

/**
 * Whether a browser process is actually holding this user-data directory.
 *
 * `DevToolsActivePort` is NOT proof, and its own docstring says so: Chrome
 * writes the file on start and does not remove it on exit, so any unclean
 * shutdown leaves one behind. Refusing on the file alone means the command
 * refuses forever after the first crash, naming a port nothing is listening
 * on, and the only cure is deleting a file the operator has no reason to
 * know about.
 *
 * The process table is checked instead, matching on the directory path,
 * which is the thing actually contended. Returns `undefined` where it cannot
 * tell rather than guessing; the caller then falls back to trusting the
 * file, since a false refusal is the safer of the two wrong answers.
 */
function defaultBrowserIsRunningOn(userDataDir: string, platform: NodeJS.Platform): boolean | undefined {
  if (platform === 'win32') return undefined
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' })
    return out.split('\n').some((line) => line.includes(`--user-data-dir=${userDataDir}`))
  } catch {
    return undefined
  }
}

function describeAvailable(registry: ProfileRegistry): string {
  const usable = registry.profiles.filter((profile) => profile.usable && profile.classification !== 'personal')
  if (usable.length === 0) return 'no usable profiles are configured'
  return `configured profiles: ${usable.map((profile) => profile.name).join(', ')}`
}

/**
 * Opens `name`'s browser for a manual sign-in, or explains why it will not.
 *
 * Never throws for an ordinary problem: a missing registry, an unknown
 * name, an excluded profile and a non-drivable directory are all reported
 * with an exit code, because this is a setup command and its whole job is
 * to say what to do next.
 */
export function runProfileLogin(options: ProfileLoginOptions): ProfileLoginResult {
  const profilesPath = options.profilesPath ?? DEFAULT_PROFILES_PATH
  const loadRegistry = options.loadRegistry ?? loadProfileRegistryIfPresent
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform

  let registry: ProfileRegistry
  try {
    registry = loadRegistry(profilesPath)
  } catch (error) {
    const detail = error instanceof ConfigError ? error.reason : (error as Error).message
    return { report: `${profilesPath} could not be read: ${detail}`, exitCode: 1 }
  }

  if (registry.profiles.length === 0) {
    return {
      report:
        `No browser profiles are configured in ${profilesPath}, so there is nothing to sign in to. ` +
        'Run `relay init --with-example-profiles` to write a starter registry, edit it to point at a dedicated ' +
        'automation directory, then run this again.',
      exitCode: 1,
    }
  }

  const profile: ProfileEntry | undefined = registry.profiles.find(
    (entry) => entry.name.toLowerCase() === options.name.toLowerCase(),
  )
  if (profile === undefined) {
    return { report: `No profile named "${options.name}" in ${profilesPath}. ${describeAvailable(registry)}.`, exitCode: 1 }
  }

  // FR-PRF-5: a personal profile exists in the registry only to be
  // excluded. Opening it for Relay's benefit would be acting on it.
  if (profile.classification === 'personal' || !profile.usable) {
    return {
      report:
        `Profile "${profile.name}" is excluded from all agent use (FR-PRF-5), so signing into it for Relay would ` +
        'achieve nothing. Relay will never drive it.',
      exitCode: 1,
    }
  }

  // FR-PRF-6a: opening the everyday profile would give a working login and
  // a profile Relay can never drive, which looks like success.
  if (isDefaultChromeUserDataDir(profile.user_data_dir, home, platform)) {
    return {
      report:
        `Profile "${profile.name}" points at "${profile.user_data_dir}", which is Chrome's own default user-data ` +
        'directory. Chrome 136 and later ignore remote-debugging switches for it, so Relay can never drive it on ' +
        'tier 2 (FR-PRF-6a), and signing in here would leave you with a working login and a profile that does not ' +
        'work. Point this profile at a dedicated automation directory first, for example ' +
        `"${home}/chrome-profiles/${profile.name}", then run this again.`,
      exitCode: 1,
    }
  }

  // One browser instance per user-data directory. Launching a second would
  // hand off to the first and exit, which reads as nothing happening.
  const existing = (options.existingEndpoint ?? readExistingDevToolsEndpoint)(profile.user_data_dir)
  if (existing !== undefined) {
    // A port file with no process behind it is stale, not a running browser.
    const running = (options.browserIsRunningOn ?? defaultBrowserIsRunningOn)(profile.user_data_dir, platform)
    if (running !== false) {
      return {
        report:
          `Profile "${profile.name}" already has a browser open on this user-data directory (DevTools port ` +
          `${existing.port}). A user-data directory permits only one running browser instance, so use the window ` +
          'that is already open, or quit it before running this again.',
        exitCode: 1,
      }
    }
  }

  const executablePath = options.executablePath ?? defaultChromeExecutablePath(platform)
  const args = [
    `--user-data-dir=${profile.user_data_dir}`,
    `--profile-directory=${profile.profile_directory}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  const child = (options.spawnChrome ?? defaultSpawn)(executablePath, args)

  const originList = profile.allowed_origins.join(', ')
  return {
    report: [
      `Opened a browser window for profile "${profile.name}"${child.pid !== undefined ? ` (pid ${child.pid})` : ''}.`,
      `  user-data-dir: ${profile.user_data_dir}`,
      `  allowed origins: ${originList}`,
      '',
      'Sign in to the sites above in this window, and choose "remember me" or "stay signed in" where the site',
      'offers it. A cookie that expires with the browser session will not survive: Relay closes the browser when',
      'a run ends, so only a persistent cookie carries the login into the next run.',
      '',
      'Then quit this browser window before asking Relay to use the profile. A user-data directory permits only',
      'one running browser instance, so a window left open here stops Relay launching its own.',
      '',
      'Check it worked with: relay doctor',
    ].join('\n'),
    exitCode: 0,
  }
}
