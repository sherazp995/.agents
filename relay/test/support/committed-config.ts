import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The committed config/relay.config.yaml, copied beside a relay.local.yaml
 * that names a laptop, so tests read it the way a set-up laptop does even on
 * a fresh checkout, where the git-ignored local file does not exist.
 */
export function committedConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-committed-config-'))
  const path = join(dir, 'relay.config.yaml')
  copyFileSync('config/relay.config.yaml', path)
  writeFileSync(join(dir, 'relay.local.yaml'), 'failover:\n  host: test-mbp\n', 'utf8')
  return path
}
