/**
 * `relay channel folder <channel-id> [folder] [--clear]`: the folder new
 * threads in a Slack channel start in, kept on the channel's project row
 * (the same row the setup page edits), so it wins over a folder named in the
 * channel description. Shown without a folder, set with one.
 */

import { homedir } from 'node:os'
import type { Pool } from 'pg'
import { clearChannelFolder, localProjectFolder, setChannelFolder, storedChannelFolder } from '../projects/store.js'
import { localFolder, storedFolder } from '../worker-env/scope.js'
import { resolveCliWorkspace } from './workspace.js'

export type ChannelCommandResult = { readonly exitCode: number; readonly message: string }

export type ChannelFolderInput = { readonly channel: string; readonly folder?: string; readonly clear: boolean; readonly workspaceId?: string }

export type ChannelFolderDeps = {
  readonly pool: Pool
  readonly isFolder: (path: string) => boolean
  readonly home?: string
  readonly cwd?: string
}

/** A public (C) or private (G) channel id; a DM has no project or channel folder. */
const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/

export async function runChannelFolder(input: ChannelFolderInput, deps: ChannelFolderDeps): Promise<ChannelCommandResult> {
  if (!CHANNEL_ID.test(input.channel)) {
    return refused(`"${input.channel}" is not a Slack channel id: use the id starting with C or G (channel details, at the bottom), e.g. C0123ABC.`)
  }
  if (input.clear && input.folder !== undefined) return refused('Give a folder or --clear, not both.')
  if (input.folder?.trim() === '') return refused('The folder is empty; give a path, or --clear to remove the stored one.')
  const choice = await resolveCliWorkspace(deps.pool, input.workspaceId)
  if (choice.kind === 'refused') return refused(choice.message)
  const workspaceId = choice.workspaceId

  if (input.clear) {
    const cleared = await clearChannelFolder(deps.pool, workspaceId, input.channel)
    if (cleared.kind === 'none') return refused(`${input.channel} has no folder stored; nothing was cleared.`)
    if (cleared.kind === 'kept') {
      return refused(
        `${input.channel} belongs to the project "${cleared.name}", and a project always has a folder. Change its folder, or delete the project on the setup page (relay ui).`,
      )
    }
    return { exitCode: 0, message: `Cleared the folder of ${input.channel}. New threads there use the folder in the channel description, if any.` }
  }

  if (input.folder === undefined) {
    const stored = await storedChannelFolder(deps.pool, workspaceId, input.channel)
    if (stored === undefined) return { exitCode: 0, message: `${input.channel} has no folder stored; new threads use the folder in the channel description, if any.` }
    const here = await localProjectFolder(deps.pool, stored.folder)
    return { exitCode: 0, message: `${stored.folder}${here === stored.folder ? '' : ` (on this laptop: ${here})`}` }
  }

  // The column holds an absolute path, expanded and resolved, as the setup page saves it.
  const home = deps.home ?? homedir()
  const folder = localFolder(storedFolder(input.folder, home, deps.cwd ?? process.cwd()), home)
  if (!deps.isFolder(folder)) return refused(`${folder} is not a folder on this laptop.`)
  const outcome = await setChannelFolder(deps.pool, workspaceId, input.channel, folder)
  const made = outcome === 'created' ? ` Made a project named ${input.channel} for it; rename it on the setup page (relay ui).` : ''
  return { exitCode: 0, message: `New threads in ${input.channel} start in ${folder}.${made}` }
}

function refused(message: string): ChannelCommandResult {
  return { exitCode: 1, message }
}
