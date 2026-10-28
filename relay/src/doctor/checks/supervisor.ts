/**
 * Is anything going to restart the daemon when it exits?
 *
 * This check exists because of a real two-day outage. The orchestrator's
 * health check exits non-zero after repeated Slack connectivity failures, on
 * purpose, with the comment "exiting so a supervisor can restart with a
 * fresh Socket Mode connection". Nothing was supervising it, so a transient
 * DNS failure took Relay down and it stayed down. Nothing reported that,
 * because a dead process reports nothing.
 *
 * `degraded` rather than `failed`: Relay works perfectly well until the
 * first blip, so this is not a broken installation. It is a statement that
 * the next network hiccup ends the session permanently, which is exactly the
 * kind of thing an operator should be told BEFORE it happens rather than
 * after.
 */

import { serviceInstalled, SERVICE_LABEL } from '../../cli/service.js'
import type { CheckResult } from '../checks.js'
import { registerCheck } from '../registry.js'

registerCheck({
  name: 'supervisor',
  async run(): Promise<CheckResult> {
    if (process.platform !== 'darwin') {
      return {
        name: 'supervisor',
        status: 'degraded',
        detail: 'no supervisor check on this platform; run the orchestrator under systemd with Restart=on-failure.',
      }
    }

    if (!serviceInstalled()) {
      return {
        name: 'supervisor',
        status: 'degraded',
        detail:
          'no launchd agent is installed, so nothing restarts the daemon when it exits. It exits deliberately after ' +
          'repeated Slack connectivity failures, which means the next transient network blip takes Relay down until ' +
          'someone notices by hand. This has already happened once, for two days.',
        remediation: 'Run `relay install-service --start`.',
      }
    }

    return { name: 'supervisor', status: 'ok', detail: `${SERVICE_LABEL} is installed, so a failure exit is restarted and Relay starts at login.` }
  },
})
