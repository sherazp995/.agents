"""relay/bin/relay (the PATH wrapper) and relay/bin/relay-update, run against a copy with fake pnpm, node and systemctl."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

CHECKOUT = Path(__file__).resolve().parents[2]


def fake(bin_dir, name, body):
    path = bin_dir / name
    path.write_text(f'#!/usr/bin/env bash\necho "{name} $*" >> "$CALLS"\n{body}\n')
    path.chmod(0o755)


class RelayUpdateCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.relay = root / 'agents' / 'relay'
        (self.relay / 'bin').mkdir(parents=True)
        for name in ('relay', 'relay-update'):
            shutil.copy(CHECKOUT / 'relay' / 'bin' / name, self.relay / 'bin' / name)
        self.bin = root / 'fakebin'
        self.bin.mkdir()
        self.calls = root / 'calls.log'
        self.calls.touch()
        fake(self.bin, 'pnpm', 'exit "${PNPM_EXIT:-0}"')
        fake(self.bin, 'node', 'exit 0')
        fake(self.bin, 'git', 'echo abc1234')
        fake(self.bin, 'systemctl', '[ "$2" = is-active ] && exit "${ACTIVE_EXIT:-0}"; exit 0')
        fake(self.bin, 'launchctl', 'exit 1')

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, path, *args, **env):
        return subprocess.run([str(path), *args], capture_output=True, text=True, timeout=30,
                              env={**os.environ, 'PATH': f'{self.bin}:/usr/bin:/bin', 'CALLS': str(self.calls), **env})

    def calls_made(self):
        return self.calls.read_text().splitlines()

    def status(self):
        return (self.relay / 'tmp' / 'update.status').read_text().strip()

    def test_the_wrapper_through_a_symlink_runs_the_cli_with_its_arguments(self):
        (self.relay / 'dist' / 'src').mkdir(parents=True)
        (self.relay / 'dist' / 'src' / 'cli.js').touch()
        link = Path(self.tmp.name) / 'relay'
        link.symlink_to(self.relay / 'bin' / 'relay')

        result = self.run_script(link, 'doctor', '--config', 'x')

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'node {self.relay}/dist/src/cli.js doctor --config x', self.calls_made())

    def test_the_wrapper_without_a_build_says_to_run_relay_update(self):
        result = self.run_script(self.relay / 'bin' / 'relay', 'doctor')

        self.assertEqual(result.returncode, 1)
        self.assertIn('Run: relay update', result.stderr)

    def test_a_passing_build_restarts_a_running_daemon_and_records_ok(self):
        result = self.run_script(self.relay / 'bin' / 'relay', 'update')

        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls_made()
        self.assertIn('pnpm install --frozen-lockfile', calls)
        self.assertIn('pnpm exec tsc -p tsconfig.json --noEmitOnError', calls)
        self.assertIn('systemctl --user restart relay.service', calls)
        self.assertEqual(self.status(), 'ok abc1234')
        self.assertFalse((self.relay / 'tmp' / 'update.lock').exists())

    def test_a_stopped_daemon_is_left_stopped(self):
        result = self.run_script(self.relay / 'bin' / 'relay-update', ACTIVE_EXIT='3')

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('systemctl --user restart relay.service', self.calls_made())
        self.assertIn('none was restarted', result.stdout)

    def test_a_failing_build_restarts_nothing_and_records_the_failure(self):
        result = self.run_script(self.relay / 'bin' / 'relay-update', PNPM_EXIT='1')

        self.assertEqual(result.returncode, 1)
        self.assertNotIn('systemctl --user restart relay.service', self.calls_made())
        self.assertEqual(self.status(), 'failed abc1234: pnpm install failed')
        self.assertIn('update.log', result.stderr)

    def test_a_second_run_while_one_holds_the_lock_exits_at_once(self):
        (self.relay / 'tmp' / 'update.lock').mkdir(parents=True)

        result = self.run_script(self.relay / 'bin' / 'relay-update')

        self.assertEqual(result.returncode, 0)
        self.assertIn('already running', result.stdout)
        self.assertEqual(self.calls_made(), [])

    def test_a_lock_left_by_a_run_that_died_is_cleared(self):
        lock = self.relay / 'tmp' / 'update.lock'
        lock.mkdir(parents=True)
        an_hour_ago = time.time() - 3600
        os.utime(lock, (an_hour_ago, an_hour_ago))

        result = self.run_script(self.relay / 'bin' / 'relay-update')

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.status(), 'ok abc1234')


if __name__ == '__main__':
    unittest.main()
