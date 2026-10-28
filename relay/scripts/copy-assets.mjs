/**
 * Copies non-TypeScript assets into `dist` after a build.
 *
 * `tsc` emits only JavaScript, so the `.sql` migrations stay behind in
 * `src/`. That is invisible while developing, because the source tree is
 * right there, and fatal once the package is installed somewhere else: the
 * migrations directory is simply absent.
 *
 * The failure it would cause is the quiet kind. A migration runner pointed
 * at an empty or missing directory applies nothing and reports success,
 * which reads exactly like "already up to date" while the schema is in fact
 * never created.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const assets = [['src/db/migrations', 'dist/src/db/migrations']]

for (const [from, to] of assets) {
  const source = join(root, from)
  if (!existsSync(source)) {
    console.error(`copy-assets: ${from} does not exist, so the build is incomplete rather than finished.`)
    process.exit(1)
  }
  mkdirSync(dirname(join(root, to)), { recursive: true })
  cpSync(source, join(root, to), { recursive: true })
}

/**
 * Records the FR-DATA-14 egress audit as of this build.
 *
 * The audit is a scan of `src/`, which an installed package does not
 * contain. Running it at doctor time there found no source, concluded every
 * declared destination was unwired, and reported FAILED, so a perfectly
 * healthy installation looked broken.
 *
 * Reporting "ok" in that situation would have been a lie, and skipping the
 * check would have been the silence this project treats as the worst
 * failure. So the audit runs HERE, where the source genuinely exists, and
 * its verdict travels with the package for doctor to report as what it is:
 * a build-time result, with the build's own timestamp.
 */
const { scanSourceForEgressEvidence, compareEgressToSource, EGRESS_INVENTORY } = await import(
  join(root, 'dist/src/data/egress.js')
)

const { registerBuiltinCapabilities } = await import(join(root, 'dist/src/capabilities/wiring.js'))
const { listCapabilities } = await import(join(root, 'dist/src/capabilities/registry.js'))
registerBuiltinCapabilities()
// The built-in capabilities that declare a destination. Passing an empty
// list here instead fabricated an "inconsistent" finding: the inventory
// declares approved_action_target as wired, nothing was found to match it,
// and the recorded audit reported FAILED on a perfectly good build.
const destinations = listCapabilities()
  .filter((definition) => definition.destinationOf !== undefined)
  .map((definition) => definition.name)

const evidence = scanSourceForEgressEvidence(join(root, 'src'))
const comparison = compareEgressToSource(EGRESS_INVENTORY, evidence, destinations)

writeFileSync(
  join(root, 'dist', 'egress-audit.json'),
  `${JSON.stringify({ builtAt: new Date().toISOString(), verified: comparison.verified, assumed: comparison.assumed, findings: comparison.findings }, null, 2)}\n`,
)
