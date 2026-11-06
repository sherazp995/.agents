/**
 * FR-SH-7: "Sandbox integrity is verified, not assumed."
 *
 * The requirement is specific about the method: a startup self-test
 * "attempts a known-forbidden write and a known-forbidden connection,
 * refusing to start if either succeeds". This implements exactly that,
 * against the real confinement on the real machine (`sandbox-exec` on macOS,
 * pasta and bubblewrap on Linux), because every test in
 * `test/sandbox/` proves the profile TEXT is right and none of them proves
 * the kernel honoured it here.
 *
 * BOTH HALVES MUST HOLD, and each has a way of passing vacuously that the
 * other catches:
 *
 *   - "the forbidden write was denied" passes trivially if the command never
 *     ran at all, if the binary was missing, if the profile failed to parse.
 *     So the test also requires that an ALLOWED write inside the worktree
 *     SUCCEEDED, in the same profile, in the same invocation. One assertion
 *     proves the machinery ran; the other proves it confined.
 *   - the same is true of the connection half, which is why a failure to
 *     connect is only accepted as proof when the allowed write worked.
 *
 * A vacuous pass here is worse than no test: it is the specific failure this
 * project has shipped before, where twenty smoke tests passed while the
 * thing they checked could never have been true.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSandboxed, sandboxAvailability } from './exec.js'
import type { SandboxExecDependencies } from './exec.js'

/** Written by the allowed write, read back afterwards. Distinctive enough that reading it cannot be a coincidence. */
const MARKER = 'relay-sandbox-self-test-ok'

/** The host the forbidden connection targets. Chosen because it is a documentation address that routes nowhere, so a machine WITHOUT a sandbox still fails to reach it slowly rather than contacting a real service. */
const FORBIDDEN_HOST = 'example.com'

export type SandboxSelfTestOutcome =
  | { readonly outcome: 'passed'; readonly detail: string }
  | { readonly outcome: 'failed'; readonly reason: string }
  /** Confinement is not available on this platform at all. Distinct from a failure: it is why coding runs are refused, not evidence the sandbox is broken. */
  | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * Runs the self-test. Never throws: the caller is a readiness report or a
 * startup gate, and both need an outcome to act on rather than an exception
 * to translate.
 */
export async function runSandboxSelfTest(deps: SandboxExecDependencies = {}): Promise<SandboxSelfTestOutcome> {
  const availability = sandboxAvailability(deps)
  if (!availability.available) return { outcome: 'unavailable', reason: availability.reason }

  const linux = (deps.platform ?? process.platform) === 'linux'
  const worktree = mkdtempSync(join(tmpdir(), 'relay-sandbox-selftest-'))
  // In the home folder, not the temporary one: the Linux sandbox covers /tmp
  // with an empty folder, so a probe target there would fail with "no such
  // file" and pass without the read-only mount ever being tested.
  const outside = mkdtempSync(join(homedir(), '.relay-sandbox-outside-'))
  const allowedFile = join(worktree, 'allowed.txt')
  const forbiddenFile = join(outside, 'forbidden.txt')
  let socketServer: Server | undefined

  try {
    // Linux only: a Unix socket the run can see must still be refused, which
    // is the socket filter's job (src/sandbox/seccomp.ts). The socket is this
    // test's own, in a visible folder, so the probe does not depend on a
    // session bus being present. Success needs EPERM specifically: a probe
    // that failed to start must not read as a refusal.
    let socketProbe: string[] = []
    if (linux) {
      const socketPath = join(outside, 'probe.sock')
      socketServer = await listenOn(socketPath)
      const probeScript = join(worktree, 'socket-probe.cjs')
      writeFileSync(
        probeScript,
        `require('node:net').connect(${JSON.stringify(socketPath)})` +
          ".on('connect', () => { console.log('LOCAL_SOCKET_OPENED'); process.exit(0) })" +
          ".on('error', (e) => { console.log('LOCAL_SOCKET_REFUSED_' + e.code); process.exit(0) })\n",
      )
      socketProbe = [`"${process.execPath}" "${probeScript}"`]
    }

    // One invocation, one profile, three probes. Deliberately a single shell
    // command so that a sandbox that silently failed to apply cannot pass
    // one probe and be absent for the next.
    const script = [
      `printf '%s' "${MARKER}" > "${allowedFile}" 2>/dev/null && echo WROTE_ALLOWED`,
      `printf 'x' > "${forbiddenFile}" 2>/dev/null && echo WROTE_FORBIDDEN`,
      // -m keeps a machine with no sandbox from hanging here for a minute.
      `/usr/bin/curl -s -m 5 -o /dev/null https://${FORBIDDEN_HOST} 2>/dev/null && echo CONNECTED`,
      ...socketProbe,
      'echo PROBES_DONE',
    ].join('\n')

    const result = await runSandboxed(
      {
        // `outside` is deliberately NOT listed in readOnlyPaths.
        //
        // It used to be, and that made this whole test vacuous in the way
        // that matters: the forbidden write was caught by its own explicit
        // deny, so the BLANKET `(deny file-write*)` was never exercised at
        // all. Deleting that rule from the generated profile left this
        // self-test still passing, while a run could write anywhere the
        // operator's account could. Naming no grant and no denial for the
        // probe path is what makes the denial evidence of the default.
        //
        // No proxyPort either, so this profile denies networking outright.
        // The connection probe therefore tests the kernel denial itself
        // rather than the proxy's allowlist, which is the layer FR-SH-6 says
        // must make bypassing the proxy impossible.
        spec: { worktree },
        command: '/bin/sh',
        args: ['-c', script],
        timeoutMs: 30_000,
      },
      deps,
    )

    if (result.outcome === 'unavailable') return { outcome: 'unavailable', reason: result.reason }
    if (result.timedOut) {
      return { outcome: 'failed', reason: 'the sandbox self-test did not finish within 30s, so confinement could not be confirmed' }
    }
    if (!result.stdout.includes('PROBES_DONE')) {
      return {
        outcome: 'failed',
        reason:
          'the sandbox self-test did not run to completion, so nothing it reports can be trusted. ' +
          `sandbox-exec exited ${result.exitCode ?? 'null'}: ${result.stderr.trim() || '(no stderr)'}`,
      }
    }

    // Half one: the machinery actually ran. Without this the two denials
    // below would pass on a sandbox that blocked everything, including the
    // work a real run needs to do.
    if (!result.stdout.includes('WROTE_ALLOWED')) {
      return {
        outcome: 'failed',
        reason:
          'a write INSIDE the worktree was denied, so the profile is not merely strict, it is broken. ' +
          'A run under it could not do its work, and the denials this test also observed prove nothing.',
      }
    }
    let readBack: string
    try {
      readBack = readFileSync(allowedFile, 'utf8')
    } catch {
      readBack = ''
    }
    if (readBack !== MARKER) {
      return { outcome: 'failed', reason: 'the allowed write reported success but its content could not be read back, so the sandbox cannot be relied on' }
    }

    // Half two: the forbidden write really was denied.
    if (result.stdout.includes('WROTE_FORBIDDEN')) {
      return {
        outcome: 'failed',
        reason:
          `a write to ${forbiddenFile}, OUTSIDE the worktree, SUCCEEDED. Confinement is not in effect, so no coding ` +
          'run may start (FR-SH-7). Every guarantee about the operator\'s checkout rests on this denial.',
      }
    }

    // Half three: the forbidden connection really was denied.
    if (result.stdout.includes('CONNECTED')) {
      return {
        outcome: 'failed',
        reason:
          `a direct network connection to ${FORBIDDEN_HOST} SUCCEEDED from inside the sandbox. The FR-SH-6 egress ` +
          'proxy can then be bypassed by opening a socket around it, so its destination list enforces nothing.',
      }
    }

    // Half four, Linux: a visible local socket was refused by the filter.
    if (linux && !result.stdout.includes('LOCAL_SOCKET_REFUSED_EPERM')) {
      return {
        outcome: 'failed',
        reason: result.stdout.includes('LOCAL_SOCKET_OPENED')
          ? 'a local (Unix) socket outside the worktree was OPENED from inside the sandbox. Through the session bus ' +
            'that starts unconfined programs, so no coding run may start (FR-SH-7).'
          : 'the local socket probe did not report the filter refusing it, so the socket filter cannot be confirmed: ' +
            (result.stdout.match(/LOCAL_SOCKET_\w+/)?.[0] ?? 'the probe printed nothing'),
      }
    }

    return {
      outcome: 'passed',
      detail:
        'confinement verified on this machine: a write inside the worktree succeeded and was read back, a write ' +
        `outside it was denied by the kernel, and a direct connection to ${FORBIDDEN_HOST} was refused` +
        (linux ? ', and a visible local socket was refused by the socket filter.' : '.'),
    }
  } finally {
    socketServer?.close()
    rmSync(worktree, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
}

function listenOn(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end())
    server.once('error', reject)
    server.listen(path, () => resolve(server))
  })
}
