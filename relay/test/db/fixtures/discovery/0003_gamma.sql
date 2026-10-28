-- Fixture migration for the discovery ordering test in
-- test/db/migrate.test.ts. Deliberately creates nothing: the test only
-- needs a statement applyMigrations can run, and a no-op keeps this fixture
-- exempt from the AP-8 workspace_id guard, which only inspects real tables.
SELECT 1;
