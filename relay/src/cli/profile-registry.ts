/**
 * `relay profile-add`, `relay profile-origins`, `relay profile-remove`, and
 * `relay profile-registry`: managing the profile registry as a registry
 * rather than as a file the operator hand-edits.
 *
 * WHAT WAS WRONG BEFORE. `relay profile-clone` finished by printing a YAML
 * block to paste into `config/profiles.yaml`. That is fine exactly once. It
 * scales to nothing: a fourth profile means learning the schema, and
 * re-scoping an existing profile, which is the edit that actually recurs as
 * real tasks hit the allowlist, had no command at all. Worse, the one file
 * that decides which logged-in browser Relay may drive was maintained by
 * copy-paste.
 *
 * THE WRITE IS ATOMIC, via a temporary file and a rename. A half-written
 * registry is not a cosmetic problem: `profiles.yaml` is the boundary that
 * stops a task about one client acting inside another client's signed-in
 * browser, and a truncated one either fails to load or, in the worse shape,
 * loads with an entry's origin list cut short. Rename on the same filesystem
 * is the standard way to make a reader see either the old file or the new
 * one and never a partial one.
 *
 * The validity gate lives in `src/profiles/registry-file.ts`, which refuses
 * to produce text that would not load. This module only decides where the
 * bytes go.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { defaultConfigPath, defaultPolicyPath, defaultProfilesPath } from '../config/paths.js'

import {
  addProfile,
  editOrigins,
  listRegisteredProfiles,
  removeProfile,
  type ProfileInput,
  type RegistryEdit,
} from '../profiles/registry-file.js'
import { PROFILE_CLASSIFICATIONS, type ProfileClassification } from '../profiles/schema.js'

export const DEFAULT_PROFILES_PATH = defaultProfilesPath()

export type CommandResult = { readonly report: string; readonly exitCode: number }

export type RegistryFileDependencies = {
  readonly readFile?: (path: string) => string | undefined
  readonly writeFile?: (path: string, contents: string) => void
}

function defaultReadFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * Write, then rename. The temporary file is created beside the target so the
 * rename stays within one filesystem, where it is atomic; a temp directory
 * elsewhere would silently degrade to a copy.
 */
function defaultWriteFile(path: string, contents: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`)
  try {
    writeFileSync(temporary, contents, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // The rename failure is the one worth reporting.
    }
    throw error
  }
}

/** Applies an edit to the registry file, or reports why it was refused without touching the file. */
function applyEdit(
  profilesPath: string,
  deps: RegistryFileDependencies,
  edit: (source: string | undefined) => RegistryEdit,
): CommandResult {
  const readFile = deps.readFile ?? defaultReadFile
  const writeFile = deps.writeFile ?? defaultWriteFile
  const path = resolve(profilesPath)

  let source: string | undefined
  try {
    source = readFile(path)
  } catch (error) {
    return { report: `Could not read ${profilesPath}: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 }
  }

  const result = edit(source)
  if (!result.ok) return { report: result.reason, exitCode: 1 }

  try {
    writeFile(path, result.text)
  } catch (error) {
    return {
      report: `The edit was valid but could not be written to ${profilesPath}: ${error instanceof Error ? error.message : String(error)}. The file is unchanged.`,
      exitCode: 1,
    }
  }

  return { report: `${result.summary}. Run \`relay doctor\` to confirm Relay agrees.`, exitCode: 0 }
}

export type ProfileAddOptions = {
  readonly name: string
  readonly dir: string
  readonly origins: readonly string[]
  readonly description?: string
  readonly project?: string
  readonly profileDirectory?: string
  readonly classification?: string
  readonly tier?: number
  readonly extension?: boolean
  readonly force?: boolean
  readonly profilesPath?: string
  readonly deps?: RegistryFileDependencies
  /** Injected so the "directory does not exist" check is testable without a filesystem. */
  readonly pathExists?: (path: string) => boolean
}

/**
 * Registers a profile directory Relay can drive.
 *
 * A `client` profile defaults to a tier 2 pin, per FR-PRF-4a: on tier 2
 * origin scoping is ENFORCED by the driver rather than detected after the
 * fact, and a client profile is exactly the case where acting in the wrong
 * account is the failure worth making impossible. The default is applied
 * rather than merely recommended because a recommendation in a help string
 * is not a control.
 */
export function runProfileAdd(options: ProfileAddOptions): CommandResult {
  const pathExists = options.pathExists ?? existsSync
  const classification = (options.classification ?? 'client') as ProfileClassification

  if (!PROFILE_CLASSIFICATIONS.includes(classification)) {
    return {
      report: `"${options.classification}" is not a classification. Use one of: ${PROFILE_CLASSIFICATIONS.join(', ')}.`,
      exitCode: 1,
    }
  }

  if (options.origins.length === 0 && classification !== 'personal') {
    return {
      report:
        'A profile needs at least one --origin. This is FR-PRF-1, and it is deliberate: an empty allowlist reads ' +
        'both as "nothing permitted" and as "not configured yet", and a registry that cannot tell those apart will ' +
        'eventually be asked to guess.\n\n' +
        `  relay profile-add ${options.name} --dir ${options.dir} --origin example.com --origin '*.example.com'\n\n` +
        'Start narrow. An off-list navigation on tier 2 is refused and reported, so too tight shows up immediately ' +
        'as a blocked step, while too broad is the failure nobody notices.',
      exitCode: 1,
    }
  }

  const directory = resolve(options.dir)
  if (!pathExists(directory)) {
    return {
      report:
        `There is no directory at ${directory}, so registering it would produce a profile that fails on first use.\n\n` +
        'If you meant to copy a signed-in Chrome profile into it, do that first:\n' +
        `  relay profile-clone --from "Profile 10" --to ${options.name}`,
      exitCode: 1,
    }
  }

  // FR-PRF-5: a personal profile is listed only to declare it excluded, so
  // it is registered unusable and without a tier pin, which the schema
  // refuses to accept together anyway.
  const isPersonal = classification === 'personal'
  const pinnedTier = isPersonal ? undefined : ((options.tier ?? (classification === 'client' ? 2 : undefined)) as 2 | 3 | undefined)

  if (pinnedTier !== undefined && pinnedTier !== 2 && pinnedTier !== 3) {
    return {
      report: `--tier must be 2 or 3. Tier 1 is the browser extension, where Relay can only detect where the browser went, not prevent it, so a pin to it could not be honoured (FR-PRF-4).`,
      exitCode: 1,
    }
  }

  const input: ProfileInput = {
    name: options.name,
    description: options.description ?? `${options.name} profile, registered by relay profile-add.`,
    ...(options.project === undefined ? {} : { project: options.project }),
    user_data_dir: directory,
    profile_directory: options.profileDirectory ?? 'Default',
    classification,
    // A personal profile is excluded from agent use entirely, so its origin
    // list is meaningless, but the schema still requires one (FR-PRF-1
    // deliberately has no "empty means nothing" spelling). `.invalid` is
    // reserved by RFC 2606 and guaranteed never to resolve, so the
    // placeholder cannot accidentally name a reachable host.
    allowed_origins: isPersonal && options.origins.length === 0 ? ['excluded.invalid'] : [...options.origins],
    ...(pinnedTier === undefined ? {} : { pinned_tier: pinnedTier }),
    ...(options.extension === undefined ? {} : { extension: options.extension }),
    ...(isPersonal ? { usable: false } : {}),
  }

  return applyEdit(options.profilesPath ?? DEFAULT_PROFILES_PATH, options.deps ?? {}, (source) =>
    addProfile(source, input, { replace: options.force === true }),
  )
}

export type ProfileOriginsOptions = {
  readonly name: string
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  readonly remove?: readonly string[]
  readonly profilesPath?: string
  readonly deps?: RegistryFileDependencies
}

/** Widens or tightens what a registered profile may reach. The edit that recurs. */
export function runProfileOrigins(options: ProfileOriginsOptions): CommandResult {
  const hasChange = [options.allow, options.deny, options.remove].some((list) => list !== undefined && list.length > 0)
  if (!hasChange) {
    return {
      report:
        `Nothing to change. Pass --allow, --deny or --remove.\n\n` +
        `  relay profile-origins ${options.name} --allow app.example.com\n` +
        `  relay profile-origins ${options.name} --remove '*.example.com'\n\n` +
        'To see what a profile currently reaches, run `relay profile-registry`.',
      exitCode: 1,
    }
  }

  return applyEdit(options.profilesPath ?? DEFAULT_PROFILES_PATH, options.deps ?? {}, (source) =>
    editOrigins(source, options.name, {
      ...(options.allow === undefined ? {} : { allow: options.allow }),
      ...(options.deny === undefined ? {} : { deny: options.deny }),
      ...(options.remove === undefined ? {} : { remove: options.remove }),
    }),
  )
}

export type ProfileRemoveOptions = {
  readonly name: string
  readonly profilesPath?: string
  readonly deps?: RegistryFileDependencies
}

/**
 * Unregisters a profile. It does NOT delete the cloned directory: that
 * directory holds a real copy of cookies and saved passwords, and deleting
 * credential material as a side effect of a config edit is the wrong default
 * in the direction that cannot be undone. The report says where it is.
 */
export function runProfileRemove(options: ProfileRemoveOptions): CommandResult {
  return applyEdit(options.profilesPath ?? DEFAULT_PROFILES_PATH, options.deps ?? {}, (source) =>
    removeProfile(source, options.name),
  )
}

/** Shows what is registered and what each profile may reach, which is the question `profile-list` does not answer. */
export function runProfileRegistry(options: { readonly profilesPath?: string; readonly deps?: RegistryFileDependencies } = {}): CommandResult {
  const readFile = options.deps?.readFile ?? defaultReadFile
  const path = resolve(options.profilesPath ?? DEFAULT_PROFILES_PATH)
  const source = readFile(path)

  const profiles = listRegisteredProfiles(source)
  if (profiles.length === 0) {
    return {
      report:
        'No profiles are registered.\n\n' +
        'Clone a signed-in Chrome profile, then register it:\n' +
        '  relay profile-list\n' +
        '  relay profile-clone --from "Profile 10" --to acme --origin acme.com\n',
      exitCode: 0,
    }
  }

  const width = Math.max(...profiles.map((profile) => profile.name.length))
  const lines = profiles.map((profile) => {
    const label = `${profile.name.padEnd(width)}  ${(profile.classification ?? '?').padEnd(8)}`
    return `${label}  ${profile.origins.join(', ')}`
  })

  return {
    report: `${profiles.length} registered profile${profiles.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}\n\nChange what one may reach with \`relay profile-origins <name> --allow <host>\`.`,
    exitCode: 0,
  }
}
