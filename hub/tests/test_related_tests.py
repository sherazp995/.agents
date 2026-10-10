"""The related-tests Stop hook: map changed files to tests, run them, block on failure."""
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HOOK = Path(__file__).resolve().parents[2] / 'hooks' / 'bin' / 'related-tests'
hook = SourceFileLoader('related_tests', str(HOOK)).load_module()

PASSING = 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n'
FAILING = PASSING.replace('assertTrue(True)', 'assertTrue(False, "boom")')


class RelatedTestsHookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / 'repo'
        self.repo.mkdir()
        self.cache = Path(self.tmp.name) / 'cache'
        for args in (['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']):
            subprocess.run(['git', '-C', str(self.repo), *args], check=True)
        self.write('README', 'x\n')
        subprocess.run(['git', '-C', str(self.repo), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.repo), 'commit', '-qm', 'init'], check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, text):
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def run_hook(self, **event):
        event = {'event': 'turn_completed', 'cwd': str(self.repo), **event}
        result = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(event), capture_output=True,
                                text=True, env={**os.environ, 'RELATED_TESTS_CACHE': str(self.cache)})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def test_a_failing_related_test_blocks_the_stop_until_it_passes(self):
        self.write('lib/widget.py', 'X = 1\n')
        self.write('tests/test_widget.py', FAILING)

        verdict = self.run_hook()

        self.assertEqual(verdict['decision'], 'deny')
        self.assertIn('tests/test_widget.py', verdict['reason'])
        self.assertIn('boom', verdict['reason'])
        self.write('tests/test_widget.py', PASSING)
        self.assertIsNone(self.run_hook())

    def test_no_changes_or_an_already_blocked_stop_end_silently(self):
        self.assertIsNone(self.run_hook())
        self.write('tests/test_widget.py', FAILING)
        self.assertIsNone(self.run_hook(stop_hook_active=True))

    def test_project_toml_command_and_map_win_and_an_unchanged_state_is_cached(self):
        log = Path(self.tmp.name) / 'runs.log'
        self.write('.agents/project.toml', '[tests]\ncommand = "sh {files}"\n'
                                           '[tests.map]\n"src/**/*.txt" = ["checks/{stem}.sh"]\n')
        self.write('src/deep/note.txt', 'changed\n')
        self.write('checks/note.sh', f'echo ran >> {log}\necho custom failure\nexit 1\n')

        first, second = self.run_hook(), self.run_hook()

        self.assertIn('custom failure', first['reason'])
        self.assertEqual(first, second)
        self.assertEqual(log.read_text(), 'ran\n')  # the second stop read the cache


class ConventionTests(unittest.TestCase):
    def test_ruby_and_js_sources_map_to_their_tests(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for path in ('spec/models/user_spec.rb', 'test/models/user_test.rb', 'web/cart.test.ts',
                         'web/__tests__/cart.tsx', 'web/other.test.ts'):
                (root / path).parent.mkdir(parents=True, exist_ok=True)
                (root / path).write_text('')

            self.assertEqual(hook.convention_tests(root, 'app/models/user.rb'),
                             ['spec/models/user_spec.rb', 'test/models/user_test.rb'])
            self.assertEqual(hook.convention_tests(root, 'web/cart.ts'),
                             ['web/cart.test.ts', 'web/__tests__/cart.tsx'])
            self.assertEqual(hook.convention_tests(root, 'web/other.test.ts'), ['web/other.test.ts'])


if __name__ == '__main__':
    unittest.main()
