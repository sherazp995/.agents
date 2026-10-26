"""with_lock.py time limit. Run with python3 -m unittest test_with_lock."""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

WITH_LOCK = Path(__file__).resolve().parent / "with_lock.py"


class WithLockTimeoutTest(unittest.TestCase):
    def run_locked(self, command, **env):
        lock = Path(self.temp.name) / "x.lock"
        return subprocess.run([sys.executable, "-I", str(WITH_LOCK), str(lock), "--", *command],
                              env=dict(os.environ, **env), capture_output=True, text=True, timeout=30)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_command_exit_code_passes_through(self):
        self.assertEqual(self.run_locked(["/bin/sh", "-c", "exit 7"]).returncode, 7)

    def test_overrun_kills_the_whole_group_and_returns_124(self):
        pidfile = Path(self.temp.name) / "child.pid"
        started = time.monotonic()
        done = self.run_locked(["/bin/sh", "-c", f"sleep 30 & echo $! > {pidfile}; wait"], WITH_LOCK_TIMEOUT="1")
        self.assertEqual(done.returncode, 124, done.stderr)
        self.assertLess(time.monotonic() - started, 10)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)

    def test_term_stops_the_group_instead_of_orphaning_it(self):
        pidfile = Path(self.temp.name) / "child.pid"
        lock = Path(self.temp.name) / "x.lock"
        proc = subprocess.Popen([sys.executable, "-I", str(WITH_LOCK), str(lock), "--",
                                 "/bin/sh", "-c", f"sleep 30 & echo $! > {pidfile}; wait"])
        deadline = time.monotonic() + 5
        while not pidfile.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        proc.terminate()
        self.assertEqual(proc.wait(timeout=10), 128 + 15)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)

    def test_invalid_timeout_is_rejected_before_running(self):
        for value in ("abc", "0", "-1"):
            with self.subTest(value=value):
                self.assertEqual(self.run_locked(["/bin/sh", "-c", "exit 0"], WITH_LOCK_TIMEOUT=value).returncode, 2)


if __name__ == "__main__":
    unittest.main()
