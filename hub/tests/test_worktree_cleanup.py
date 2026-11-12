"""The worktree-cleanup Stop hook: a worktree the session created is offered for removal once it is safe."""
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
import uuid

ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / 'hooks' / 'bin' / 'worktree-cleanup'
ADAPTER = ROOT / 'hooks' / 'adapters' / 'run.py'
hook = SourceFileLoader('worktree_cleanup', str(HOOK)).load_module()
GIT_ENV = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
           'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}


def run(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True, env=GIT_ENV).stdout


def bash(command, tool_id='t1'):
    return {'type': 'assistant', 'message': {'content': [
        {'type': 'tool_use', 'id': tool_id, 'name': 'Bash', 'input': {'command': command}}]}}


def codex_exec(argv, workdir):
    return {'type': 'response_item', 'payload': {'type': 'function_call', 'name': 'exec_command', 'call_id': 'c1',
                                                 'arguments': json.dumps({'cmd': argv, 'workdir': workdir})}}


def codex_command_execution(command, cwd):
    """A real Codex `item_completed` record (rollout 2026-11-03, cohabit-web review), paths swapped for the test's."""
    return {'timestamp': '2026-11-03T09:41:05.064Z', 'ordinal': 31, 'type': 'event_msg', 'payload': {
        'type': 'item_completed', 'thread_id': '01a1a058-63cb-7fc0-8b76-53be224943c3',
        'turn_id': '01a1a0c8-2f04-7c60-a22b-a4319dd542bc', 'item': {
            'type': 'CommandExecution', 'id': 'exec-50b5cb09-a611-480e-b38b-8cb51a019c70', 'process_id': '4633',
            'command': ['/bin/zsh', '-lc', command], 'cwd': f'file://{cwd}'}}}


def launch_result(text, tool_id='t2'):
    return {'type': 'user', 'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S+00:00', time.gmtime()),
            'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tool_id, 'content': text}]}}


class WorktreeCleanupTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name).resolve()
        self.remote = self.dir / 'remote.git'
        run(self.dir, 'init', '-q', '--bare', str(self.remote))
        self.repo = self.dir / 'repo'
        run(self.dir, 'clone', '-q', str(self.remote), str(self.repo))
        (self.repo / '.gitignore').write_text('node_modules/\n.env\n')
        run(self.repo, 'add', '.gitignore')
        run(self.repo, 'commit', '-q', '-m', 'init')
        run(self.repo, 'push', '-q', 'origin', 'HEAD:main')
        patch = unittest.mock.patch.object(hook, 'STATE', self.dir / 'state')
        patch.start()
        self.addCleanup(patch.stop)
        self.records = []

    def add(self, name, *options, ref=None, record=True):
        path = self.dir / name
        start = [ref] if ref else []
        run(self.repo, 'worktree', 'add', '-q', *options, str(path), *start)
        if record:
            self.records.append(bash(f'cd {self.repo} && git worktree add {" ".join(options)} {path} {ref or ""}'))
        return path

    def commit(self, path, name='f.txt'):
        (path / name).write_text('x')
        run(path, 'add', name)
        run(path, 'commit', '-q', '-m', name)

    def stop(self, session='s1', active=False):
        transcript = self.dir / f'{session}.jsonl'
        transcript.write_text(''.join(json.dumps(r) + '\n' for r in self.records))
        return hook.verdict({'session_id': session, 'transcript_path': str(transcript), 'cwd': str(self.repo),
                             'stop_hook_active': active})

    def named(self, result):
        return result['reason'] if result else ''

    def test_a_pushed_clean_worktree_the_session_created_is_named_once(self):
        path = self.add('wt', '-b', 'feat')
        self.commit(path)
        run(path, 'push', '-q', 'origin', 'feat')

        first = self.stop()

        self.assertEqual(first['decision'], 'deny')
        self.assertIn(f'`cd {self.repo} && git worktree remove {path}`', first['reason'])
        self.assertIn('branch `feat`', first['reason'])
        self.assertIsNone(self.stop())  # reminded once per session

    def test_uncommitted_untracked_or_ignored_keepers_are_never_named(self):
        tracked = self.add('tracked', '--detach', ref='origin/main')
        (tracked / '.gitignore').write_text('changed\n')
        untracked = self.add('untracked', '--detach', ref='origin/main')
        (untracked / 'new.txt').write_text('x')
        secret = self.add('secret', '--detach', ref='origin/main')
        (secret / '.env').write_text('KEY=1')
        rebuilt = self.add('rebuilt', '--detach', ref='origin/main')
        (rebuilt / 'node_modules').mkdir()
        (rebuilt / 'node_modules' / 'x.js').write_text('x')

        reason = self.named(self.stop())

        for path in (tracked, untracked, secret):
            self.assertNotIn(f'`{path}`', reason)
        self.assertIn(f'`{rebuilt}`', reason)  # node_modules is rebuildable

    def test_a_commit_the_remote_does_not_have_is_never_named_also_on_a_detached_head(self):
        branch = self.add('local', '-b', 'local-only')
        self.commit(branch)
        detached = self.add('detached', '--detach', ref='origin/main')
        self.commit(detached)

        self.assertIsNone(self.stop())

    def test_a_commit_whose_remote_branch_was_deleted_is_not_named_after_the_prune(self):
        path = self.add('gone', '-b', 'gone')
        self.commit(path)
        run(path, 'push', '-q', 'origin', 'gone')
        run(self.remote, 'branch', '-D', 'gone')  # deleted on the remote; the local ref is now stale

        self.assertIsNone(self.stop())

    def test_a_detached_review_checkout_of_the_remote_base_is_named(self):
        path = self.add('review', '--detach', ref='origin/main')

        self.assertIn('branch `detached`', self.named(self.stop()))
        self.assertIn(f'`{path}`', self.named(self.stop('s2')))

    def test_visited_main_locked_and_workflow_worktrees_are_never_named(self):
        visited = self.add('visited', '--detach', ref='origin/main', record=False)
        self.records.append(bash(f'cd {visited} && git status'))
        locked = self.add('locked', '--detach', ref='origin/main')
        run(self.repo, 'worktree', 'lock', str(locked))
        workflow = self.add('.claude/worktrees/w1', '--detach', ref='origin/main')
        self.records.append(bash(f'git worktree add {self.repo}'))  # names the main checkout itself

        self.assertIsNone(self.stop())
        self.assertTrue(visited.is_dir() and workflow.is_dir())

    def test_codex_workdir_and_git_dash_c_resolve_relative_paths(self):
        codex_path = self.dir / 'codex-wt'
        run(self.repo, 'worktree', 'add', '-q', '--detach', str(codex_path), 'origin/main')
        self.records.append(codex_exec(['git', 'worktree', 'add', '--detach', '../codex-wt', 'origin/main'], str(self.repo)))
        dash_c = self.dir / 'dash-c'
        run(self.repo, 'worktree', 'add', '-q', '--detach', str(dash_c), 'origin/main')
        self.records.append(bash(f'git -C {self.repo} worktree add -b x ../dash-c origin/main'))

        reason = self.named(self.stop())

        self.assertIn(f'`{codex_path}`', reason)
        self.assertIn(f'`{dash_c}`', reason)

    def test_a_current_codex_command_execution_record_is_read_with_its_file_url_cwd_and_newlines(self):
        path = self.dir / 'codex review'
        run(self.repo, 'worktree', 'add', '-q', '--detach', str(path), 'origin/main')
        command = f'mkdir -p /tmp/x\ngit worktree add --detach "../codex review" origin/main'
        self.records.append(codex_command_execution(command, str(self.repo).replace(' ', '%20')))

        reason = self.named(self.stop())

        self.assertIn(f"git worktree remove '{path}'", reason)  # quoted: the path has a space

    def test_silent_while_a_background_task_runs_or_another_stop_hook_sent_it_back(self):
        self.add('busy', '--detach', ref='origin/main')
        self.assertIsNone(self.stop(active=True))
        self.records.append(launch_result('Async agent launched successfully.\nagentId: abc123'))

        self.assertIsNone(self.stop('s2'))

    def test_a_failed_fetch_names_nothing_and_a_hanging_fetch_is_cut_at_its_budget(self):
        self.add('offline', '--detach', ref='origin/main')
        run(self.repo, 'remote', 'set-url', 'origin', str(self.dir / 'missing.git'))
        self.assertIsNone(self.stop())

        slow = self.dir / 'slow-git'
        slow.write_text('#!/bin/sh\nsleep 30\n')
        slow.chmod(0o755)
        run(self.repo, 'remote', 'set-url', 'origin', f'ext::{slow}')
        run(self.repo, 'config', 'protocol.ext.allow', 'always')
        started = time.monotonic()
        with unittest.mock.patch.object(hook, 'FETCH_BUDGET', 1.5):
            self.assertIsNone(self.stop('s2'))
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 1.4)  # it really waited for the fetch
        self.assertLess(elapsed, 10)

    def test_claude_and_codex_get_the_reminder_through_the_adapter(self):
        path = self.add('adapter', '--detach', ref='origin/main')
        transcript = self.dir / 'a.jsonl'
        transcript.write_text(''.join(json.dumps(r) + '\n' for r in self.records))
        for agent in ('claude', 'codex'):
            session = f'test-{uuid.uuid4().hex}'
            real_state = SourceFileLoader('wc_real', str(HOOK)).load_module().state_file(session)
            self.addCleanup(lambda f=real_state: f.unlink(missing_ok=True))
            native = {'hook_event_name': 'Stop', 'session_id': session, 'transcript_path': str(transcript),
                      'cwd': str(self.repo), 'stop_hook_active': False}
            result = subprocess.run([sys.executable, str(ADAPTER), agent, 'worktree-cleanup'],
                                    input=json.dumps(native), capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 2, result.stderr)  # the adapter's Stop block
            out = json.loads(result.stdout)
            self.assertEqual(out.get('decision'), 'block')
            self.assertIn(f'git worktree remove {path}', out.get('reason', ''))


if __name__ == '__main__':
    unittest.main()
