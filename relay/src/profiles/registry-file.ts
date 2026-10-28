/**
 * Editing `config/profiles.yaml` as data rather than as text an operator
 * retypes.
 *
 * WHY THIS EXISTS. `relay profile-clone` used to finish by PRINTING a YAML
 * block for a human to paste. That made every new profile a manual file
 * edit, which is wrong in three separate ways: the paste can be mistyped
 * into a registry that governs what Relay is allowed to touch, the operator
 * has to learn the schema to add the fourth profile, and re-scoping an
 * existing profile (the thing that actually happens repeatedly, as real
 * tasks hit the allowlist) had no command at all. A registry that can only
 * be hand-edited is a registry that stops being edited.
 *
 * TWO PROPERTIES ARE LOAD-BEARING, and both are why this uses the `yaml`
 * package's Document API rather than parse-then-re-serialise:
 *
 *   - COMMENTS SURVIVE. profiles.yaml is more explanation than data: it
 *     carries the reason a clone is needed at all (FR-PRF-6a), what tier
 *     pinning buys, and how to widen an allowlist. Round-tripping through
 *     plain objects would silently delete all of it on the first edit, and
 *     the operator would never know what was lost.
 *   - NOTHING UNLOADABLE IS EVER WRITTEN. Every edit here re-parses its own
 *     output through `profileRegistrySchema` BEFORE returning it. An edit
 *     that would produce a registry Relay cannot load is refused with a
 *     reason, and the caller still holds the original text. The failure this
 *     prevents is not cosmetic: this file is the boundary that stops a task
 *     about one client acting inside another client's logged-in browser.
 *
 * Every function here is a pure function from text to text. The filesystem
 * lives in the CLI layer, so the rules can be tested without one.
 */

import { parseDocument, type Document } from 'yaml'
import type { YAMLMap, YAMLSeq } from 'yaml'

import { profileEntrySchema, profileRegistrySchema, type ProfileClassification } from './schema.js'

/**
 * The fields a caller may set. Deliberately narrower than `ProfileEntry`:
 * the schema's defaults (`denied_origins`, `extension`, `usable`) are not
 * written out unless asked for, so a generated entry reads like one a person
 * would write rather than a dump of every default.
 */
export type ProfileInput = {
  readonly name: string
  readonly description: string
  readonly project?: string
  readonly user_data_dir: string
  readonly profile_directory?: string
  readonly classification: ProfileClassification
  readonly allowed_origins: readonly string[]
  readonly denied_origins?: readonly string[]
  readonly pinned_tier?: 2 | 3
  readonly extension?: boolean
  readonly usable?: boolean
}

export type RegistryEdit =
  | { readonly ok: true; readonly text: string; readonly summary: string }
  | { readonly ok: false; readonly reason: string }

/**
 * The header written when there is no registry yet. Kept deliberately short:
 * the long-form guidance belongs to `relay init`'s starter file, and
 * duplicating it here would give two versions to drift apart.
 */
const NEW_FILE_HEADER = `# Relay browser profile registry, FR-PRF-1.
#
# Managed by \`relay profile-add\`, \`relay profile-origins\` and
# \`relay profile-remove\`. Hand edits are fine too; comments are preserved
# across command edits.
#
# Every entry states exactly which origins a profile may reach. On tier 2
# that is ENFORCED at the CDP request layer, not merely disapproved of
# (FR-PRF-4).
`

/** Matches the schema's own duplicate rule, which is case-insensitive. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function emptyRegistryDocument(): Document {
  const doc = parseDocument(`${NEW_FILE_HEADER}\nversion: 1\n\nprofiles: []\n`)
  return doc
}

function parseRegistry(source: string | undefined): { doc: Document } | { reason: string } {
  if (source === undefined || source.trim() === '') return { doc: emptyRegistryDocument() }

  const doc = parseDocument(source)
  if (doc.errors.length > 0) {
    return { reason: `config/profiles.yaml is not valid YAML, so it cannot be edited safely: ${doc.errors[0]?.message ?? 'unknown parse error'}` }
  }
  // An existing file whose `profiles` key is missing or is not a list is
  // repaired rather than refused: an empty registry is a legitimate state
  // and `relay init` writes exactly that shape.
  const profiles = doc.get('profiles')
  if (profiles === undefined || profiles === null) {
    doc.set('profiles', doc.createNode([]))
  }
  return { doc }
}

function profilesSeq(doc: Document): YAMLSeq | undefined {
  const node = doc.get('profiles')
  return node !== null && typeof node === 'object' && 'items' in (node as object) ? (node as YAMLSeq) : undefined
}

function entryName(item: unknown): string | undefined {
  if (item === null || typeof item !== 'object' || !('get' in (item as object))) return undefined
  const value = (item as YAMLMap).get('name')
  return typeof value === 'string' ? value : undefined
}

function findEntry(doc: Document, name: string): { index: number; map: YAMLMap } | undefined {
  const seq = profilesSeq(doc)
  if (seq === undefined) return undefined
  for (const [index, item] of seq.items.entries()) {
    const existing = entryName(item)
    if (existing !== undefined && sameName(existing, name)) return { index, map: item as YAMLMap }
  }
  return undefined
}

/**
 * The gate every edit passes through. Serialises the mutated document and
 * re-parses it through the real schema, so a refusal happens here rather
 * than at the next `relay doctor`, with the original file still intact.
 */
function serialiseIfValid(doc: Document, summary: string): RegistryEdit {
  let text: string
  try {
    text = doc.toString({ lineWidth: 0 })
  } catch (error) {
    return { ok: false, reason: `the edited registry could not be serialised: ${error instanceof Error ? error.message : String(error)}` }
  }

  const reparsed = parseDocument(text)
  if (reparsed.errors.length > 0) {
    return { ok: false, reason: `the edit would produce invalid YAML, so nothing was written: ${reparsed.errors[0]?.message ?? 'unknown parse error'}` }
  }

  const validated = profileRegistrySchema.safeParse(reparsed.toJS())
  if (!validated.success) {
    const first = validated.error.issues[0]
    const where = first?.path.join('.') ?? ''
    return {
      ok: false,
      reason: `the edit would produce a registry Relay cannot load, so nothing was written: ${first?.message ?? 'unknown validation error'}${where === '' ? '' : ` (at ${where})`}`,
    }
  }

  return { ok: true, text, summary }
}

/**
 * Adds a profile. Refuses a duplicate name rather than appending a second
 * entry, because the schema's own rule is that a name resolves to exactly
 * one profile, and appending would make the file unloadable in a way the
 * operator would only discover later.
 */
export function addProfile(source: string | undefined, input: ProfileInput, options: { readonly replace?: boolean } = {}): RegistryEdit {
  // Validate the entry on its own first, so the operator gets "an origin
  // pattern cannot contain spaces" rather than a whole-registry error.
  const candidate = profileEntrySchema.safeParse({
    ...input,
    profile_directory: input.profile_directory ?? 'Default',
    allowed_origins: [...input.allowed_origins],
    ...(input.denied_origins === undefined ? {} : { denied_origins: [...input.denied_origins] }),
  })
  if (!candidate.success) {
    const first = candidate.error.issues[0]
    return { ok: false, reason: `that profile is not valid: ${first?.message ?? 'unknown validation error'}${first === undefined || first.path.length === 0 ? '' : ` (at ${first.path.join('.')})`}` }
  }

  const parsed = parseRegistry(source)
  if ('reason' in parsed) return { ok: false, reason: parsed.reason }
  const { doc } = parsed

  const existing = findEntry(doc, input.name)
  if (existing !== undefined && options.replace !== true) {
    return {
      ok: false,
      reason: `a profile named "${input.name}" is already registered. Use --force to replace it, or \`relay profile-origins ${input.name}\` to change only what it may reach.`,
    }
  }

  // Only the fields the caller actually set are written. `profile_directory`
  // is always written because Chrome's identity is genuinely two-part and
  // leaving it implicit has bitten this project before.
  const written: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    ...(input.project === undefined ? {} : { project: input.project }),
    user_data_dir: input.user_data_dir,
    profile_directory: input.profile_directory ?? 'Default',
    classification: input.classification,
    allowed_origins: [...input.allowed_origins],
    ...(input.denied_origins === undefined || input.denied_origins.length === 0 ? {} : { denied_origins: [...input.denied_origins] }),
    ...(input.extension === undefined ? {} : { extension: input.extension }),
    ...(input.pinned_tier === undefined ? {} : { pinned_tier: input.pinned_tier }),
    ...(input.usable === undefined ? {} : { usable: input.usable }),
  }

  const node = doc.createNode(written)
  const seq = profilesSeq(doc)
  if (seq === undefined) return { ok: false, reason: 'config/profiles.yaml has a `profiles` key that is not a list, so it cannot be edited safely. Fix it by hand.' }

  if (existing !== undefined) {
    seq.items[existing.index] = node
    return serialiseIfValid(doc, `replaced profile "${input.name}"`)
  }
  seq.items.push(node)
  return serialiseIfValid(doc, `registered profile "${input.name}"`)
}

export function removeProfile(source: string | undefined, name: string): RegistryEdit {
  const parsed = parseRegistry(source)
  if ('reason' in parsed) return { ok: false, reason: parsed.reason }
  const { doc } = parsed

  const existing = findEntry(doc, name)
  if (existing === undefined) return { ok: false, reason: `no profile named "${name}" is registered.` }

  const seq = profilesSeq(doc)
  if (seq === undefined) return { ok: false, reason: 'config/profiles.yaml has no `profiles` list.' }
  seq.items.splice(existing.index, 1)

  // Unregistering does NOT delete the cloned directory, and the summary says
  // so: the directory holds real cookies, and a command that silently
  // deleted credential material as a side effect of a config edit would be
  // the wrong default in the irreversible direction.
  return serialiseIfValid(doc, `unregistered profile "${name}". Its directory and cookies were left on disk`)
}

export type OriginChanges = {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  readonly remove?: readonly string[]
}

/**
 * Adds to or removes from a profile's origin lists. This is the command that
 * gets used most: an allowlist is tightened on day one and widened whenever
 * a real task is refused, and before this existed that meant editing YAML.
 *
 * `remove` takes a pattern out of BOTH lists. Two flags to remove one string
 * would only ever produce "removed from the wrong list" bugs.
 */
export function editOrigins(source: string | undefined, name: string, changes: OriginChanges): RegistryEdit {
  const parsed = parseRegistry(source)
  if ('reason' in parsed) return { ok: false, reason: parsed.reason }
  const { doc } = parsed

  const existing = findEntry(doc, name)
  if (existing === undefined) return { ok: false, reason: `no profile named "${name}" is registered.` }

  const changed: string[] = []

  const currentOf = (key: 'allowed_origins' | 'denied_origins'): string[] => {
    const node = existing.map.get(key)
    if (node === null || node === undefined || typeof node !== 'object' || !('items' in (node as object))) return []
    return (node as YAMLSeq).items.map((item) => (typeof item === 'object' && item !== null && 'value' in item ? String((item as { value: unknown }).value) : String(item)))
  }

  const apply = (key: 'allowed_origins' | 'denied_origins', additions: readonly string[] | undefined): void => {
    const current = currentOf(key)
    const next = [...current]
    for (const addition of additions ?? []) {
      const trimmed = addition.trim()
      if (trimmed === '' || next.some((value) => value === trimmed)) continue
      next.push(trimmed)
      changed.push(`+${key === 'allowed_origins' ? 'allow' : 'deny'} ${trimmed}`)
    }
    if (next.length !== current.length) existing.map.set(key, doc.createNode(next))
  }

  apply('allowed_origins', changes.allow)
  apply('denied_origins', changes.deny)

  for (const pattern of changes.remove ?? []) {
    const trimmed = pattern.trim()
    for (const key of ['allowed_origins', 'denied_origins'] as const) {
      const current = currentOf(key)
      if (!current.includes(trimmed)) continue
      const next = current.filter((value) => value !== trimmed)
      // An emptied denylist is dropped entirely rather than left as `[]`,
      // but an emptied ALLOWLIST is kept so that `serialiseIfValid` refuses
      // it by FR-PRF-1 rather than this function quietly deciding.
      if (next.length === 0 && key === 'denied_origins') existing.map.delete(key)
      else existing.map.set(key, doc.createNode(next))
      changed.push(`-${key === 'allowed_origins' ? 'allow' : 'deny'} ${trimmed}`)
    }
  }

  if (changed.length === 0) return { ok: false, reason: `nothing to change: "${name}" already matches what you asked for.` }

  return serialiseIfValid(doc, `${name}: ${changed.join(', ')}`)
}

/** Reads the registry for display, without the schema's opinion. Used by `relay profile-list` so a broken file still lists what it can. */
export function listRegisteredProfiles(source: string | undefined): ReadonlyArray<{ readonly name: string; readonly classification?: string; readonly origins: readonly string[] }> {
  const parsed = parseRegistry(source)
  if ('reason' in parsed) return []
  const seq = profilesSeq(parsed.doc)
  if (seq === undefined) return []

  const out: Array<{ name: string; classification?: string; origins: string[] }> = []
  for (const item of seq.items) {
    const name = entryName(item)
    if (name === undefined) continue
    const map = item as YAMLMap
    const classification = map.get('classification')
    const originsNode = map.get('allowed_origins')
    const origins =
      originsNode !== null && typeof originsNode === 'object' && 'items' in (originsNode as object)
        ? (originsNode as YAMLSeq).items.map((entry) => (typeof entry === 'object' && entry !== null && 'value' in entry ? String((entry as { value: unknown }).value) : String(entry)))
        : []
    out.push({ name, ...(typeof classification === 'string' ? { classification } : {}), origins })
  }
  return out
}
