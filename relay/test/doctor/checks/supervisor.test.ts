import { describe, expect, it } from 'vitest'

import { serviceUnitPath } from '../../../src/cli/service.js'
import { checkSupervisor } from '../../../src/doctor/checks/supervisor.js'
import type { CheckContext } from '../../../src/doctor/registry.js'

/** The supervisor check reads only the filesystem, never the context. */
const IGNORED_CONTEXT = {} as CheckContext

describe('checkSupervisor on Linux', () => {
  it('is ok when the systemd user unit is installed', async () => {
    const result = await checkSupervisor({ platform: 'linux', home: '/home/op', pathExists: (path) => path === serviceUnitPath('/home/op') }).run(IGNORED_CONTEXT)

    expect(result.status).toBe('ok')
    expect(result.detail).toContain('relay.service is installed as a systemd user unit')
  })

  it('is degraded, naming the command, when nothing supervises the daemon', async () => {
    const result = await checkSupervisor({ platform: 'linux', home: '/home/op', pathExists: () => false }).run(IGNORED_CONTEXT)

    expect(result.status).toBe('degraded')
    expect(result.remediation).toBe('Run `relay install-service --start`.')
  })
})
