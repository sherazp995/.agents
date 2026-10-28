import { describe, expect, it } from 'vitest'
import {
  buildClaudeSettings,
  buildCodexHookOverrides,
  codexHookTrustedHash,
  HOOK_TIMEOUT_SECONDS,
} from '../../src/autonomous/worker-config.js'

const HOOK = `'/opt/node' '/relay home/dist/scripts/hook-pretooluse.js'`

describe('worker hook config', () => {
  it('registers the Bash PreToolUse hook for claude and nothing else', () => {
    expect(JSON.parse(buildClaudeSettings({ hookCommand: HOOK }))).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK, timeout: HOOK_TIMEOUT_SECONDS }] }] },
    })
  })

  it('reproduces codex-cli 0.164.0 trusted hashes', () => {
    // Recorded by codex in the operator's ~/.codex/config.toml for its hooks.json git-guard entry (default timeout 600).
    expect(
      codexHookTrustedHash({
        event: 'pre_tool_use',
        matcher: 'Bash',
        command: '/Users/hassan/.agents/hooks/adapters/run.py codex git-guard',
        timeoutSeconds: 600,
      }),
    ).toBe('sha256:a2b244b11e7e76e6b5bd856223175c2ab5b1183e336f7799c62adea110f13463')
    // Reported by `codex app-server` hooks/list as currentHash for a -c registered hook without a matcher.
    expect(codexHookTrustedHash({ event: 'pre_tool_use', command: '/bin/echo hi', timeoutSeconds: 600 })).toBe(
      'sha256:beae8b2d9cb65888d6c05a22a801005acd7ac279de0497a3478d47693ba59329',
    )
  })

  it('registers and trusts the hook for codex through -c overrides, running the script with --codex', () => {
    const [hooks, state] = buildCodexHookOverrides({ hookCommand: HOOK })
    const command = `${HOOK} --codex`
    expect(hooks).toBe(`hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(command)},timeout=30}]}]`)
    const hash = codexHookTrustedHash({ event: 'pre_tool_use', matcher: 'Bash', command, timeoutSeconds: HOOK_TIMEOUT_SECONDS })
    expect(state).toBe(`hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="${hash}"}}`)
  })
})
