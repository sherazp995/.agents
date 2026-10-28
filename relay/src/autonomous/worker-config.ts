/**
 * What the scheduler hands each worker CLI at spawn so relay's PreToolUse
 * hook (scripts/hook-pretooluse.ts) gates every shell call (plan step 8).
 *
 * Claude: a `--settings` JSON registering the hook for Bash, and turning the
 * Playwright plugin off so the only browser is relay's proxy-enforced one.
 *
 * Codex: `-c` overrides. Codex runs a hook only when its hash is recorded as
 * trusted under `hooks.state`; overrides land in the `sessionFlags` layer,
 * whose hooks are keyed `/<session-flags>/config.toml:<event>:<group>:<handler>`.
 * The trusted hash is `sha256:` + hex SHA-256 of the handler's normalized
 * identity serialized as compact JSON with sorted keys:
 * `{"event_name","hooks":[{"async","command","timeout","type"}],"matcher"}`.
 * Established against codex-cli 0.164.0: its app-server `hooks/list`
 * reports that `currentHash` for an override-registered hook, the same
 * formula reproduces the operator's recorded trusted_hash for
 * ~/.codex/hooks.json's git-guard entry, and an inline-table override of
 * `hooks.state` merges with (never replaces) the operator's own trust
 * entries. Nothing here writes to any codex home.
 */

import { createHash } from 'node:crypto'
import { canonicalise } from '../audit/chain.js'

/** Seconds each client gives the hook: above the script's own 8 s deadline, so the script's deny always wins the race. */
export const HOOK_TIMEOUT_SECONDS = 30

export const CODEX_SESSION_FLAGS_SOURCE = '/<session-flags>/config.toml'
const DISABLED_PLUGINS = ['playwright@claude-plugins-official'] as const

export type HookCommandParams = {
  /** The shell command that runs scripts/hook-pretooluse.js, e.g. `'/path/node' '/path/dist/scripts/hook-pretooluse.js'`. */
  hookCommand: string
}

export function buildClaudeSettings(params: HookCommandParams): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: params.hookCommand, timeout: HOOK_TIMEOUT_SECONDS }] }],
    },
    enabledPlugins: Object.fromEntries(DISABLED_PLUGINS.map((plugin) => [plugin, false])),
  })
}

/** The hash codex records as `trusted_hash` for one command hook; see this file's header. */
export function codexHookTrustedHash(hook: { event: string; matcher?: string; command: string; timeoutSeconds: number }): string {
  const identity = {
    event_name: hook.event,
    hooks: [{ async: false, command: hook.command, timeout: hook.timeoutSeconds, type: 'command' }],
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
  }
  return `sha256:${createHash('sha256').update(canonicalise(identity)).digest('hex')}`
}

/** A TOML basic string: JSON's escaping is a subset TOML accepts for the characters a command can hold. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * The `-c` values (without the `-c` itself) registering the hook as codex's
 * only session-flags PreToolUse hook, matcher `Bash`, and trusting it. The
 * script runs with `--codex` so it speaks codex's output dialect.
 */
export function buildCodexHookOverrides(params: HookCommandParams): string[] {
  const command = `${params.hookCommand} --codex`
  const key = `${CODEX_SESSION_FLAGS_SOURCE}:pre_tool_use:0:0`
  const trustedHash = codexHookTrustedHash({ event: 'pre_tool_use', matcher: 'Bash', command, timeoutSeconds: HOOK_TIMEOUT_SECONDS })
  return [
    `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${tomlString(command)},timeout=${HOOK_TIMEOUT_SECONDS}}]}]`,
    `hooks.state={${tomlString(key)}={trusted_hash=${tomlString(trustedHash)}}}`,
  ]
}
