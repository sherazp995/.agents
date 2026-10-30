"""launch.sh with fake claude, codex and relay on PATH: one detached session per repo, guarded, never silent."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from helpers import SKILL, make_repo, write_plan

LAUNCHER = SKILL / 'launch.sh'
FAKE = '''#!/bin/bash
name=${0##*/}
python3 - "$name" "$@" <<'EOF'
import json, os, sys, time
record = {'name': sys.argv[1], 'argv': sys.argv[2:], 'cwd': os.getcwd(),
          'env': {k: os.environ.get(k) for k in ('AGENTS_AUTONOMOUS_RUN', 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS')}}
path = os.path.join(os.environ['FAKE_LOG'], '%s-%d-%d.json' % (sys.argv[1], os.getpid(), time.time_ns()))
open(path, 'w').write(json.dumps(record))
EOF
[[ "$name" == relay ]] && exit 0
sleep "${FAKE_SLEEP:-0}"
exit "${FAKE_STATUS:-0}"
'''


class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.bin, self.log, self.runs = self.root / 'bin', self.root / 'log', self.root / 'runs'
        for folder in (self.bin, self.log):
            folder.mkdir()
        (self.bin / 'python3').symlink_to(sys.executable)
        self.repo = make_repo(self.root / 'repo')
        self.other = make_repo(self.root / 'other')
        self.env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin', FAKE_LOG=str(self.log),
                        AGENTS_AUTONOMOUS_ROOT=str(self.runs), AGENTS_PLANS_DIR=str(self.root / 'plans'))
        for name in ('AUTONOMOUS_ENGINE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CODEX_THREAD_ID'):
            self.env.pop(name, None)
        # The chat a here run runs in: this test process stands in for the live Claude host.
        self.chat = {'CLAUDE_CODE_SESSION_ID': 'chat-1', 'CLAUDE_PID': str(os.getpid())}
        self.addCleanup(self.kill_sessions)

    def fakes(self, *names):
        for name in names:
            (self.bin / name).write_text(FAKE)
            (self.bin / name).chmod(0o755)

    def launch(self, *args, **env):
        started = time.monotonic()
        result = subprocess.run(['/bin/bash', str(LAUNCHER), *map(str, args)], capture_output=True, text=True,
                                env=dict(self.env, **env), timeout=30)
        return result, time.monotonic() - started

    def run_dir(self, result):
        line = next(l for l in result.stdout.splitlines() if l.startswith('run '))
        return self.runs / line.split()[1]

    def records(self, name, count, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = [json.loads(p.read_text()) for p in sorted(self.log.glob(f'{name}-*.json')) if p.stat().st_size]
            if len(found) >= count:
                return found
            time.sleep(0.1)
        self.fail(f'{count} {name} session(s) expected, found {len(list(self.log.glob(f"{name}-*.json")))}')

    def kill_sessions(self):
        for state in self.runs.glob('*/state.json'):
            for group in json.loads(state.read_text()).get('groups', []):
                if group.get('pid'):
                    try:
                        os.killpg(group['pid'], signal.SIGKILL)
                    except OSError:
                        pass

    def plans(self):
        a = write_plan(self.root / 'a.md', self.repo)
        b = write_plan(self.root / 'b.md', self.other)
        c = write_plan(self.root / 'c.md', self.repo)
        bad = write_plan(self.root / 'bad.md', self.repo)
        bad.write_text(bad.read_text().replace('Rename the class.', 'Rename it all.'))
        return a, b, c, bad

    def test_one_detached_claude_session_per_repo_returns_at_once(self):
        self.fakes('claude', 'codex', 'relay')
        result, seconds = self.launch(*self.plans(), FAKE_SLEEP='20')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(seconds, 10)
        run_dir = self.run_dir(result)
        self.assertRegex(result.stdout, r'stopped bad \(.*bad\.md\): approval: the Confirmed intent, Steps or Checks')
        sessions = {r['cwd']: r for r in self.records('claude', 2)}
        self.assertEqual(set(sessions), {str(self.repo), str(self.other)})
        self.assertEqual(list(self.log.glob('codex-*')), [])
        for record in sessions.values():
            argv = record['argv']
            self.assertEqual(argv[argv.index('--permission-mode') + 1], 'bypassPermissions')
            self.assertEqual(record['env'], {'AGENTS_AUTONOMOUS_RUN': str(run_dir),
                                             'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS': '0'})
            settings = json.loads(Path(argv[argv.index('--settings') + 1]).read_text())
            hook = settings['hooks']['PreToolUse'][0]
            self.assertIn('Bash', hook['matcher'])
            self.assertTrue(hook['hooks'][0]['command'].endswith('run.py claude no-remote-writes --fail-closed'))
        self.assertIn('Tasks in order: a, c.', sessions[str(self.repo)]['argv'][1])
        self.assertIn('Tasks in order: b.', sessions[str(self.other)]['argv'][1])
        state = json.loads((run_dir / 'state.json').read_text())
        self.assertEqual(state['tasks']['bad']['status'], 'stopped')
        self.assertTrue(all(g['pid'] and g['status'] == 'running' for g in state['groups']))

    def test_codex_runs_with_the_same_guard_when_claude_is_missing(self):
        self.fakes('codex', 'relay')
        result, _ = self.launch(write_plan(self.root / 'a.md', self.repo))
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = self.records('codex', 1)[0]['argv']
        self.assertEqual(argv[:2], ['exec', '--dangerously-bypass-approvals-and-sandbox'])
        self.assertEqual(argv[argv.index('-C') + 1], str(self.repo))
        overrides = [argv[i + 1] for i, a in enumerate(argv) if a == '-c']
        self.assertTrue(overrides[0].startswith('hooks.PreToolUse=[{matcher="Bash"'))
        self.assertIn('run.py codex no-remote-writes --fail-closed', overrides[0])
        self.assertRegex(overrides[1], r'^hooks.state=\{"/<session-flags>/config.toml:pre_tool_use:0:0"='
                                       r'\{trusted_hash="sha256:[0-9a-f]{64}"\}\}$')

    def test_refuses_without_an_engine_or_a_verified_plan(self):
        self.fakes('relay')
        plan = write_plan(self.root / 'a.md', self.repo)
        result, _ = self.launch(plan)
        self.assertEqual(result.returncode, 1)
        self.assertIn('neither claude nor codex is installed', result.stderr)
        self.assertFalse(self.runs.exists())
        self.fakes('claude')
        plan.write_text(plan.read_text().replace('python3 -m unittest', 'true'))
        result, _ = self.launch(plan)
        self.assertEqual(result.returncode, 1)
        self.assertIn('stopped a', result.stdout)
        self.assertIn('no plan verified, nothing started', result.stdout)

    def test_no_paths_takes_approved_unfinished_plans_and_names_the_rest(self):
        self.fakes('claude', 'relay')
        plans = self.root / 'plans'
        plans.mkdir()
        write_plan(plans / 'open.md', self.repo)
        done = write_plan(plans / 'done.md', self.repo)
        done.write_text(done.read_text().replace('- [ ]', '- [x]'))
        (plans / 'unsigned.md').write_text('# x\n\n## Steps\n- [ ] 1. y\n')
        result, _ = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('done.md: every step is ticked', result.stderr)
        self.assertIn('unsigned.md: the plan is not signed', result.stderr)
        state = json.loads((self.run_dir(result) / 'state.json').read_text())
        self.assertEqual(state['order'], ['open'])

    def test_a_session_that_dies_early_reports_to_the_thread_and_resumes(self):
        self.fakes('claude', 'relay')
        result, _ = self.launch('--slack-channel', 'C1', '--slack-thread', '17.5',
                                write_plan(self.root / 'a.md', self.repo), FAKE_STATUS='3')
        self.assertEqual(result.returncode, 0, result.stderr)
        run_dir = self.run_dir(result)
        say = self.records('relay', 1)[0]['argv']
        self.assertEqual(say[:2], ['live', 'say'])
        self.assertEqual((say[say.index('--channel') + 1], say[say.index('--thread') + 1]), ('C1', '17.5'))
        self.assertEqual(say[say.index('--file') + 1], str(run_dir / 'report.md'))
        self.assertIn(f'--resume {run_dir.name}', say[say.index('--text') + 1])
        state = json.loads((run_dir / 'state.json').read_text())
        self.assertEqual((state['groups'][0]['status'], state['groups'][0]['exit']), ('crashed', 3))
        resumed, _ = self.launch('--resume', run_dir.name, FAKE_SLEEP='20')
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertIn(f'run {run_dir.name} resumed', resumed.stdout)
        self.records('claude', 2)


    def test_here_records_the_run_and_its_prompts_and_starts_no_session(self):
        self.fakes('claude', 'relay')
        result, _ = self.launch('--here', *self.plans(), **self.chat)
        self.assertEqual(result.returncode, 0, result.stderr)
        run_dir = self.run_dir(result)
        self.assertIn('ready to run here', result.stdout)
        self.assertRegex(result.stdout, r'stopped bad \(.*bad\.md\): approval')
        time.sleep(0.5)
        self.assertEqual(list(self.log.glob('claude-*')), [])
        state = json.loads((run_dir / 'state.json').read_text())
        self.assertEqual(state['mode'], 'here')
        self.assertEqual(state['engine'], 'claude')
        self.assertEqual(state['owner'], {'session': 'chat-1', 'pid': os.getpid()})
        self.assertEqual((self.runs / 'here-sessions' / 'chat-1').read_text(), str(run_dir))
        self.assertTrue(all(g['pid'] is None for g in state['groups']))
        prompt = (run_dir / 'group-0.prompt.txt').read_text()
        self.assertIn('in the user\'s own chat', prompt)
        self.assertIn('Tasks in order: a, c.', prompt)
        self.assertIn(str(run_dir / 'group-0.prompt.txt'), result.stdout)

    def test_here_runs_resume_here_and_refuse_slack(self):
        self.fakes('claude', 'relay')
        result, _ = self.launch('--here', write_plan(self.root / 'a.md', self.repo), **self.chat)
        run_dir = self.run_dir(result)
        resumed, _ = self.launch('--resume', run_dir.name, **self.chat)
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertIn(str(run_dir / 'group-0.prompt.txt'), resumed.stdout)
        time.sleep(0.5)
        self.assertEqual(list(self.log.glob('claude-*')), [])
        refused, _ = self.launch('--here', '--slack-channel', 'C1', '--slack-thread', '1.1',
                                 write_plan(self.root / 'b.md', self.repo), **self.chat)
        self.assertEqual(refused.returncode, 2)
        self.assertIn('Slack', refused.stderr)

    def test_here_needs_a_chat_and_no_headless_engine(self):
        plan = write_plan(self.root / 'a.md', self.repo)
        outside, _ = self.launch('--here', plan)
        self.assertEqual(outside.returncode, 2)
        self.assertIn('chat', outside.stderr)
        self.assertFalse(self.runs.exists() and any(self.runs.glob('*/state.json')))
        # No claude or codex on PATH: a here run never starts one, so it still launches.
        result, _ = self.launch('--here', plan, **self.chat)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_codex_chat_owns_its_here_run_through_its_codex_process(self):
        codex = self.root / 'host' / 'codex'  # a process named codex above the launcher, like the Codex host
        codex.parent.mkdir()
        codex.symlink_to(sys.executable)
        script = 'import subprocess, sys; sys.exit(subprocess.run(sys.argv[1:]).returncode)'
        result = subprocess.run([str(codex), '-c', script, '/bin/bash', str(LAUNCHER), '--here',
                                 str(write_plan(self.root / 'a.md', self.repo))], capture_output=True, text=True,
                                env=dict(self.env, CODEX_THREAD_ID='thread-1'), timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads((self.run_dir(result) / 'state.json').read_text())
        self.assertEqual(state['engine'], 'codex')
        self.assertEqual(state['owner']['session'], 'thread-1')

    def test_another_live_chat_cannot_take_a_here_run(self):
        result, _ = self.launch('--here', write_plan(self.root / 'a.md', self.repo), **self.chat)
        run_dir = self.run_dir(result)
        taken, _ = self.launch('--resume', run_dir.name, CLAUDE_CODE_SESSION_ID='chat-2', CLAUDE_PID=str(os.getpid()))
        self.assertEqual(taken.returncode, 1)
        self.assertIn('still owns this run', taken.stderr)
        state = json.loads((run_dir / 'state.json').read_text())
        state['owner']['pid'] = 999999  # the first chat has closed
        (run_dir / 'state.json').write_text(json.dumps(state))
        moved, _ = self.launch('--resume', run_dir.name, CLAUDE_CODE_SESSION_ID='chat-2', CLAUDE_PID=str(os.getpid()))
        self.assertEqual(moved.returncode, 0, moved.stderr)
        self.assertEqual(json.loads((run_dir / 'state.json').read_text())['owner']['session'], 'chat-2')
        self.assertFalse((self.runs / 'here-sessions' / 'chat-1').exists())
        self.assertTrue((self.runs / 'here-sessions' / 'chat-2').exists())

if __name__ == '__main__':
    unittest.main()
