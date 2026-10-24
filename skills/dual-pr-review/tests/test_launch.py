"""Offline launcher regressions. Run with python3 tests/test_launch.py."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

LAUNCHER = Path(__file__).resolve().parents[1] / 'scripts' / 'launch.sh'
FIXTURE = '''#!/bin/bash
name=${0##*/}
if [[ "$name" == claude ]]; then
  report=/dev/stdout
  status=${CLAUDE_STATUS:-0}
  body=${CLAUDE_BODY-Review complete}
else
  while [[ "$1" != -o ]]; do shift; done
  report=$2
  status=${CODEX_STATUS:-0}
  body=${CODEX_BODY-Review complete}
fi
if [[ ${BLOCK:-0} == 1 ]]; then
  sleep 60 &
  echo $! > "$FIXTURE_DIR/$name.child"
  wait
else
  [[ "$name" != codex ]] || sleep 0.1
fi
if [[ "$name" == claude ]]; then
  printf '%s' "$body"
else
  printf '%s' "$body" > "$report"
fi
exit "$status"
'''


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for command in ('mkdir', 'date', 'rm', 'cat', 'grep', 'sleep'):
            (self.bin / command).symlink_to(shutil.which(command))
        for reviewer in ('claude', 'codex'):
            path = self.bin / reviewer
            path.write_text(FIXTURE)
            path.chmod(0o755)
        self.run = self.root / 'run'
        self.env = dict(os.environ, PATH=str(self.bin), FIXTURE_DIR=str(self.root))

    def launch(self, **environment):
        return subprocess.Popen(
            ['/bin/bash', str(LAUNCHER), str(self.root), str(self.run), 'Review this'],
            env=dict(self.env, **environment), stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True,
        )

    def result(self, expected, **environment):
        self.run = self.root / f'run-{time.monotonic_ns()}'
        process = self.launch(**environment)
        output = process.communicate(timeout=5)
        self.assertEqual(process.returncode, expected, output)
        self.assertEqual((self.run / 'launcher.exit').read_text().strip(), str(expected))
        self.assertTrue((self.run / 'finished_at').exists())
        return process

    def test_success_collects_both_reports(self):
        self.result(0)
        for reviewer in ('claude', 'codex'):
            self.assertEqual((self.run / f'{reviewer}.md').read_text(), 'Review complete')
            self.assertEqual((self.run / f'{reviewer}.exit').read_text().strip(), '0')

    def test_failures_preserve_status_and_wait_for_both(self):
        for claude, codex, expected in [('7', '0', 7), ('0', '9', 9), ('7', '9', 7)]:
            with self.subTest(claude=claude, codex=codex):
                self.result(expected, CLAUDE_STATUS=claude, CODEX_STATUS=codex)
                self.assertEqual((self.run / 'claude.exit').read_text().strip(), claude)
                self.assertEqual((self.run / 'codex.exit').read_text().strip(), codex)

    def test_empty_or_whitespace_report_is_failure(self):
        for env in ({'CLAUDE_BODY': ''}, {'CODEX_BODY': ' \n\t'}):
            with self.subTest(env=env):
                self.result(1, **env)

    def test_missing_executable_is_recorded(self):
        (self.bin / 'codex').unlink()
        self.result(127)
        self.assertFalse((self.run / 'codex.md').exists())
        self.assertEqual((self.run / 'claude.exit').read_text().strip(), '0')

    def test_reusing_run_directory_preserves_artifacts(self):
        self.result(0)
        before = {p.name: p.read_bytes() for p in self.run.iterdir() if p.is_file()}
        process = self.launch()
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, 2)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.run.iterdir() if p.is_file()})

    def test_interruption_records_failure_and_stops_only_owned_children(self):
        unrelated = subprocess.Popen(['/bin/sleep', '60'])
        self.addCleanup(lambda: unrelated.poll() is None and unrelated.kill())
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=sig):
                for path in self.root.glob('*.child'):
                    path.unlink()
                self.run = self.root / f'interrupted-{sig}'
                process = self.launch(BLOCK='1')
                deadline = time.monotonic() + 3
                while len(list(self.root.glob('*.child'))) < 2 and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual(len(list(self.root.glob('*.child'))), 2)
                process.send_signal(sig)
                output = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 128 + sig, output)
                self.assertTrue((self.run / 'interrupted').exists())
                for reviewer in ('claude', 'codex'):
                    self.assertNotEqual((self.run / f'{reviewer}.exit').read_text().strip(), '0')
                    child = int((self.root / f'{reviewer}.child').read_text())
                    with self.assertRaises(ProcessLookupError):
                        os.kill(child, 0)
                self.assertIsNone(unrelated.poll())
        unrelated.terminate()
        unrelated.wait(timeout=2)


SKILLS = Path(__file__).resolve().parents[2]
COMPOSED_LAUNCHER = Path(os.environ.get('TEST_LAUNCHER', LAUNCHER))


class RunnerCancellationTest(unittest.TestCase):
    def test_launcher_allows_runner_to_kill_its_detached_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / 'bin'
            binaries.mkdir()
            pidfile = root / 'agent.pid'
            fake = root / 'fake-agent'
            fake.write_text(f'''#!{shutil.which('node')}
const fs = require('node:fs');
process.on('SIGTERM', () => {{}});
fs.writeFileSync(process.env.AGENT_PID, String(process.pid));
process.stdin.resume();
setInterval(() => {{}}, 1000);
''')
            fake.chmod(0o755)
            claude = binaries / 'claude'
            claude.write_text('''#!/bin/bash
exec "$NODE" "$RUNNER" "$SECOND_OPINION" --args '{"prompt":"wait"}'
''')
            claude.chmod(0o755)
            codex = binaries / 'codex'
            codex.write_text('''#!/bin/bash
while [[ "$1" != -o ]]; do shift; done
printf 'review complete' > "$2"
''')
            codex.chmod(0o755)
            env = dict(os.environ, PATH=f'{binaries}:{os.environ["PATH"]}',
                       NODE=shutil.which('node'), AGENT_PID=str(pidfile),
                       RUNNER=str(SKILLS / 'workflow-runner/run-workflow.mjs'),
                       SECOND_OPINION=str(SKILLS / 'workflow-runner/second-opinion.js'),
                       WORKFLOW_RUNNER_CLAUDE=str(fake))
            process = subprocess.Popen(['/bin/bash', str(COMPOSED_LAUNCHER), str(root), str(root / 'run'), 'review'],
                                       env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            agent_pid = None
            try:
                deadline = time.monotonic() + 5
                while not pidfile.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(pidfile.exists(), 'agent must be running before interruption')
                agent_pid = int(pidfile.read_text())
                os.kill(agent_pid, 0)
                process.send_signal(signal.SIGTERM)
                output = process.communicate(timeout=6)
                self.assertEqual(process.returncode, 143, output)
                with self.assertRaises(ProcessLookupError, msg='detached agent survived launcher cancellation'):
                    os.kill(agent_pid, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=3)
                if agent_pid:
                    try:
                        os.kill(agent_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass



if __name__ == '__main__':
    unittest.main(verbosity=2)
