"""The agents-sync start hook: fast forward ~/.agents to origin/main only when it is safe."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'hooks' / 'bin' / 'agents-sync'
IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']


def git(cwd, *args):
    return subprocess.run(['git', *IDENTITY, *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class AgentsSyncCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.origin = root / 'origin.git'
        git(root, 'init', '-q', '--bare', '-b', 'main', str(self.origin))
        self.other = root / 'other'
        git(root, 'clone', '-q', str(self.origin), str(self.other))
        git(self.other, 'checkout', '-q', '-b', 'main')
        self.commit(self.other, 'rules.md', 'one\n')
        git(self.other, 'push', '-q', 'origin', 'main')
        self.repo = root / 'agents'
        git(root, 'clone', '-q', str(self.origin), str(self.repo))

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, cwd, name, text):
        (cwd / name).write_text(text)
        git(cwd, 'add', name)
        git(cwd, 'commit', '-q', '-m', f'edit {name}')

    def push_upstream(self, name='rules.md', text='two\n'):
        self.commit(self.other, name, text)
        git(self.other, 'push', '-q', 'origin', 'main')

    def run_hook(self, fresh=True, env=None):
        if fresh:
            (self.repo / '.git' / 'agents-sync.stamp').unlink(missing_ok=True)
        result = subprocess.run([str(SCRIPT)], input='{}', capture_output=True, text=True, timeout=30,
                                env={**os.environ, 'AGENTS_SYNC_REPO': str(self.repo), **(env or {})})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)['context'] if result.stdout.strip() else None

    def test_a_clean_clone_behind_origin_is_fast_forwarded_and_the_agent_told(self):
        self.push_upstream()
        line = self.run_hook()
        self.assertIn('was updated from', line)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), git(self.other, 'rev-parse', 'HEAD'))
        self.assertIsNone(self.run_hook(), 'nothing to say once current')

    def test_a_setup_change_asks_for_install(self):
        self.push_upstream('registry.toml', 'x = 1\n')
        self.assertIn('install.py', self.run_hook())

    def test_unpushed_commits_are_left_alone_with_a_reason(self):
        self.push_upstream()
        self.commit(self.repo, 'mine.md', 'local\n')
        head = git(self.repo, 'rev-parse', 'HEAD')
        self.assertIn('1 unpushed commit', self.run_hook())
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)

    def test_another_branch_is_left_alone(self):
        self.push_upstream()
        git(self.repo, 'checkout', '-q', '-b', 'side')
        self.assertIn('is on side, not main', self.run_hook())
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), git(self.repo, 'rev-parse', 'main'))

    def test_a_local_edit_survives_and_a_clashing_one_blocks_the_update(self):
        (self.repo / 'notes.md').write_text('mine\n')
        self.push_upstream()
        self.assertIn('was updated', self.run_hook())
        self.assertEqual((self.repo / 'notes.md').read_text(), 'mine\n')

        (self.repo / 'rules.md').write_text('my edit\n')
        self.push_upstream(text='three\n')
        self.assertIn('was not updated', self.run_hook())
        self.assertEqual((self.repo / 'rules.md').read_text(), 'my edit\n')

    def test_an_ignored_local_file_is_never_overwritten(self):
        (self.repo / '.git' / 'info' / 'exclude').write_text('secret.md\n')
        (self.repo / 'secret.md').write_text('mine\n')
        self.push_upstream('secret.md', 'theirs\n')
        self.assertIn('was not updated', self.run_hook())
        self.assertEqual((self.repo / 'secret.md').read_text(), 'mine\n')

    def test_merge_autostash_config_does_not_stash_a_clashing_edit(self):
        git(self.repo, 'config', 'merge.autoStash', 'true')
        head = git(self.repo, 'rev-parse', 'HEAD')
        (self.repo / 'rules.md').write_text('my edit\n')
        self.push_upstream(text='theirs\n')
        self.assertIn('was not updated', self.run_hook())
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(git(self.repo, 'stash', 'list'), '')
        self.assertEqual((self.repo / 'rules.md').read_text(), 'my edit\n')

    def test_a_second_start_within_a_minute_does_not_fetch(self):
        self.assertIsNone(self.run_hook())
        self.push_upstream()
        self.assertIsNone(self.run_hook(fresh=False))
        self.assertIn('was updated', self.run_hook())

    def test_a_folder_that_is_not_a_repo_gets_no_lock_or_stamp(self):
        plain = self.repo.parent / 'plain'
        plain.mkdir()
        result = subprocess.run([str(SCRIPT)], input='{}', capture_output=True, text=True, timeout=30, cwd=plain,
                                env={**os.environ, 'AGENTS_SYNC_REPO': str(plain), 'GIT_CEILING_DIRECTORIES': str(plain.parent)})
        self.assertEqual((result.returncode, result.stdout), (0, ''))
        self.assertEqual(list(plain.iterdir()), [])

    def test_a_hanging_fetch_is_cut_off_and_the_start_goes_on(self):
        git(self.repo, 'remote', 'set-url', 'origin', 'ssh://example.invalid/agents.git')
        started = time.monotonic()
        self.assertIsNone(self.run_hook(env={'GIT_SSH_COMMAND': 'sleep 30; :'}))
        self.assertGreater(time.monotonic() - started, 7, 'the fetch really hung')
        self.assertLess(time.monotonic() - started, 12)
        self.assertFalse((self.repo / '.git' / 'agents-sync.lock').exists())

    def test_an_unreachable_remote_says_nothing_and_does_not_fail(self):
        git(self.repo, 'remote', 'set-url', 'origin', str(self.origin.parent / 'missing.git'))
        self.assertIsNone(self.run_hook())


if __name__ == '__main__':
    unittest.main()
