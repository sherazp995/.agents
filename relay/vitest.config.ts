import { defineConfig } from 'vitest/config'

// Local defaults for the two integration-test env vars: the system's own
// Postgres and Redis on their default ports (Redis database 8, apart from
// relay's own 13 and other apps' databases). Without these, `pnpm test` used to silently
// skip the Postgres and Redis integration suites whenever a developer forgot
// to export the vars by hand, while still reporting overall success. Setting
// them here means a plain `pnpm test` run always exercises integration
// coverage locally; a caller that genuinely needs to point at a different
// database or Redis still overrides these via the real environment.
const DEFAULT_TEST_DATABASE_URL = 'postgres://relay:relay@localhost:5432/relay_test'
const DEFAULT_TEST_REDIS_URL = 'redis://localhost:6379/8'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // Gives every Vitest worker its own Postgres database (see
    // test/support/global-setup.ts and test/support/database.ts) instead of
    // every test file sharing relay_test. Runs with Vitest's default file
    // parallelism; it does not turn parallelism off.
    globalSetup: ['test/support/global-setup.ts'],
    env: {
      RELAY_TEST_DATABASE_URL: process.env.RELAY_TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
      RELAY_TEST_REDIS_URL: process.env.RELAY_TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL,
    },
  },
})
