"""The related-tests hooks: snapshot the tree when a turn starts, test the turn's changed files at Stop."""
import contextlib
from datetime import datetime, timedelta, timezone
from importlib.machinery import SourceFileLoader
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

HOOKS = Path(__file__).resolve().parents[2] / 'hooks'
HOOK = HOOKS / 'bin' / 'related-tests'
SNAPSHOT = HOOKS / 'bin' / 'related-tests-snapshot'
ADAPTER = HOOKS / 'adapters' / 'run.py'
hook = SourceFileLoader('related_tests', str(HOOK)).load_module()

PASSING = 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n'
FAILING = PASSING.replace('assertTrue(True)', 'assertTrue(False, "boom")')
SESSION = 'session-1'


def prompt(text='a question'):
    return {'type': 'user', 'message': {'role': 'user', 'content': text}}


def tool(name, tool_id='t1', **tool_input):
    return {'type': 'assistant', 'message': {'content': [
        {'type': 'tool_use', 'id': tool_id, 'name': name, 'input': tool_input}]}}


def result(tool_id='t1', text='ok', minutes_ago=0):
    at = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return {'type': 'user', 'timestamp': at.isoformat().replace('+00:00', 'Z'), 'message': {
        'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tool_id, 'content': text}]}}


def agent_launch(agent_id):
    return f'Async agent launched successfully.\nagentId: {agent_id} (internal ID - do not mention to user.)'


def said(text='done'):
    return {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': text}]}}


def notification(task_id, status='completed', tag='task-id'):
    """A task notification in the real format: most carry only the task id."""
    return (f'<task-notification>\n<{tag}>{task_id}</{tag}>\n<output-file>/tmp/x.output</output-file>\n'
            f'<status>{status}</status>\n<summary>Agent "x" finished</summary>\n</task-notification>')


def codex_patch(patch):
    return {'type': 'response_item', 'payload': {'type': 'custom_tool_call', 'name': 'apply_patch',
                                                 'input': f'*** Begin Patch\n{patch}*** End Patch\n'}}


class HookCase(unittest.TestCase):
    """A repo with lib/{a,b,c,gone}.py and a failing tests/test_<name>.py for each, all committed."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / 'cache'
        self.make_repo()

    def tearDown(self):
        self.tmp.cleanup()

    def make_repo(self):
        self.repo = Path(tempfile.mkdtemp(dir=self.tmp.name)) / 'repo'
        self.repo.mkdir()
        for args in (['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']):
            self.git(*args)
        for name in ('a', 'b', 'c', 'gone'):
            self.write(f'lib/{name}.py', f'{name.upper()} = 1\n')
            self.write(f'tests/test_{name}.py', FAILING)
        self.git('add', '.')
        self.git('commit', '-qm', 'init')

    def write(self, path, text):
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, check=True, capture_output=True).stdout

    def transcript(self, *records, name='session.jsonl'):
        file = Path(self.tmp.name) / name
        file.write_text(''.join(json.dumps(record) + '\n' for record in records))
        return str(file)

    def append(self, transcript, *records):
        with open(transcript, 'a') as handle:
            handle.write(''.join(json.dumps(record) + '\n' for record in records))

    def env(self):
        return {**os.environ, 'RELATED_TESTS_CACHE': str(self.cache)}

    def snapshot(self, transcript_path=None, session_id=SESSION):
        event = {'event': 'prompt_submitted', 'cwd': str(self.repo), 'session_id': session_id,
                 'transcript_path': transcript_path}
        done = subprocess.run([str(SNAPSHOT)], input=json.dumps(event), capture_output=True, text=True,
                              env=self.env())
        self.assertEqual((done.returncode, done.stdout), (0, ''), done.stderr)

    def snapshot_files(self):
        return sorted((self.cache / 'snapshots').glob('*.json'))

    def run_hook(self, **event):
        event = {'event': 'turn_completed', 'cwd': str(self.repo), **event}
        done = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(event), capture_output=True,
                              text=True, env=self.env())
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout) if done.stdout.strip() else None

    def ran_tests(self, **event):
        """The tests a Stop ran (every test here fails, so the deny names them), or None."""
        verdict = self.run_hook(**event)
        if verdict is None:
            return None
        return set(re.match(r'Related tests fail \((.*?)\)\.', verdict['reason']).group(1).split(', '))


class SnapshotTests(HookCase):
    def test_the_turn_is_the_diff_from_its_start_snapshot(self):
        def shell_edit():
            subprocess.run(['sed', '-i', 's/1/2/', 'lib/a.py'], cwd=self.repo, check=True)

        def new_untracked_file():
            self.write('lib/fresh.py', 'F = 1\n')
            self.write('tests/test_fresh.py', FAILING)

        def renamed_file():  # both names count; only the old one has tests
            (self.repo / 'lib/gone.py').rename(self.repo / 'lib/moved.py')

        cases = [
            ('a file changed only by a shell command', shell_edit, {'tests/test_a.py'}),
            ('a new untracked file and its test', new_untracked_file, {'tests/test_fresh.py'}),
            ('a deleted file runs its related tests', lambda: (self.repo / 'lib/gone.py').unlink(),
             {'tests/test_gone.py'}),
            ('a deleted test file has nothing to run', lambda: (self.repo / 'tests/test_b.py').unlink(), None),
            ('a renamed file', renamed_file, {'tests/test_gone.py'}),
            ('nothing changed', lambda: None, None),
        ]
        for name, change, expected in cases:
            with self.subTest(name):
                self.make_repo()
                self.write('lib/c.py', 'C = 2\n')  # changed before the turn: not this turn's
                self.snapshot()
                change()
                self.assertEqual(self.ran_tests(session_id=SESSION), expected)

    def test_a_prompt_queued_mid_turn_keeps_the_turn_start(self):
        transcript = self.transcript()
        self.snapshot(transcript)
        self.write('lib/a.py', 'A = 2\n')
        self.snapshot(transcript)  # a prompt queued while the turn runs
        self.write('lib/b.py', 'B = 2\n')

        self.assertEqual(self.ran_tests(session_id=SESSION, transcript_path=transcript),
                         {'tests/test_a.py', 'tests/test_b.py'})

    def test_a_finished_turn_uses_the_snapshot_up_and_a_failure_keeps_it(self):
        self.write('tests/test_a.py', PASSING)
        self.git('commit', '-qam', 'passing a')
        self.snapshot()
        self.write('lib/b.py', 'B = 2\n')
        self.assertEqual(self.ran_tests(session_id=SESSION), {'tests/test_b.py'})
        self.assertEqual(len(self.snapshot_files()), 1)  # failing: the fix is tested at a later Stop

        self.write('tests/test_b.py', PASSING)
        self.assertIsNone(self.run_hook(session_id=SESSION))
        self.assertEqual(self.snapshot_files(), [])
        self.write('tests/test_a.py', FAILING)  # changed between turns, not in the next one
        self.snapshot()
        self.assertIsNone(self.run_hook(session_id=SESSION))

    def test_a_pending_background_agent_defers_the_stop_and_keeps_the_snapshot(self):
        stale = [tool('Agent', 'old', prompt='x'), result('old', agent_launch('old-agent'))]
        transcript = self.transcript(prompt(), *stale, said())
        self.snapshot(transcript)  # a launch before the turn never reported back; it does not hold this turn
        self.write('lib/a.py', 'A = 2\n')
        self.append(transcript, prompt(),
                    tool('Agent', 's1', prompt='z'), result('s1', agent_launch('silent'), minutes_ago=46),
                    tool('Workflow', 'w1', scriptPath='x.js'),
                    result('w1', [{'type': 'text', 'text': 'Workflow launched in background. Task ID: wf1'}]),
                    tool('Agent', 'r1', prompt='r'), result('r1', 'Remote agent launched.'),
                    tool('Agent', 'a1', prompt='y'), result('a1', agent_launch('ag1')), said())

        self.assertIsNone(self.run_hook(session_id=SESSION, transcript_path=transcript))
        self.assertEqual(len(self.snapshot_files()), 1)

        self.append(transcript, {'type': 'user', 'origin': {'kind': 'task-notification'},
                                 'message': {'role': 'user', 'content': notification('wf1', 'killed')}},
                    {'type': 'queue-operation', 'operation': 'enqueue',
                     'content': notification('r1', tag='tool-use-id')})
        self.assertIsNone(self.run_hook(session_id=SESSION, transcript_path=transcript))
        self.write('lib/b.py', 'B = 2\n')  # the agent's edit
        self.append(transcript, {'type': 'attachment', 'attachment': {
            'type': 'queued_command', 'commandMode': 'task-notification', 'prompt': notification('ag1')}})

        # 's1' never reported back, but it is over 45 minutes old, so it no longer holds the turn.
        self.assertEqual(self.ran_tests(session_id=SESSION, transcript_path=transcript),
                         {'tests/test_a.py', 'tests/test_b.py'})

    def test_a_failure_blocks_one_turn_and_the_next_prompt_starts_fresh(self):
        self.snapshot()
        self.write('lib/a.py', 'A = 2\n')
        self.assertEqual(self.ran_tests(session_id=SESSION), {'tests/test_a.py'})
        self.assertTrue(json.loads(self.snapshot_files()[0].read_text())['blocked'])
        self.assertIsNone(self.run_hook(session_id=SESSION, stop_hook_active=True))

        self.snapshot()  # the next prompt; the agent gave up on the failure and edits nothing more
        self.assertIsNone(self.run_hook(session_id=SESSION))

    def test_untracked_files_are_listed_not_hashed_and_still_tested(self):
        for i in range(2000):
            self.write(f'data/f{i}.txt', f'{i}\n')
        (self.repo / 'data' / 'big.bin').write_bytes(os.urandom(2_000_000))
        self.write('lib/fresh.py', 'F = 1\n')
        self.write('tests/test_fresh.py', FAILING)
        objects = self.repo / '.git' / 'objects'
        before = sorted(objects.rglob('*'))

        self.snapshot()
        self.write('lib/fresh.py', 'F = 22\n')  # an edited untracked file
        self.write('lib/newer.py', 'N = 1\n')  # a new untracked file
        self.write('tests/test_newer.py', FAILING)

        self.assertEqual(self.ran_tests(session_id=SESSION), {'tests/test_fresh.py', 'tests/test_newer.py'})
        self.assertEqual(sorted(objects.rglob('*')), before)

    def test_above_the_untracked_cap_untracked_files_come_from_the_transcript(self):
        self.write('lib/x.py', 'X = 1\n')
        self.write('tests/test_x.py', FAILING)
        self.write('lib/y.py', 'Y = 1\n')
        self.write('tests/test_y.py', FAILING)
        transcript = self.transcript(prompt())
        event = {'cwd': str(self.repo), 'session_id': SESSION, 'transcript_path': transcript}
        stderr = io.StringIO()
        with unittest.mock.patch.object(hook, 'UNTRACKED_CAP', 2), \
                unittest.mock.patch.object(hook, 'CACHE', self.cache), contextlib.redirect_stderr(stderr):
            hook.snapshot(event)
            self.assertEqual(json.loads(self.snapshot_files()[0].read_text())['untracked'], None)
            self.write('lib/x.py', 'X = 2\n')  # a shell edit the transcript does not show
            self.write('lib/y.py', 'Y = 2\n')
            self.append(transcript, tool('Write', file_path=str(self.repo / 'lib/y.py')), result(), said())
            verdict = hook.verdict(event)

        self.assertIn('Related tests fail (tests/test_y.py)', verdict['reason'])
        self.assertIn('exceeded the snapshot cap', stderr.getvalue())

    def test_snapshots_older_than_a_day_are_deleted(self):
        folder = self.cache / 'snapshots'
        folder.mkdir(parents=True)
        old, fresh = folder / 'old.json', folder / 'fresh.json'
        for file in (old, fresh):
            file.write_text('{"tree": "x", "offset": 0}')
        day_ago = datetime.now().timestamp() - 25 * 3600
        os.utime(old, (day_ago, day_ago))

        self.snapshot(session_id='another-session')

        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())

    def test_a_snapshot_past_the_transcripts_end_is_ignored(self):
        transcript = self.transcript(prompt(), said('a long earlier answer ' * 20))
        self.snapshot(transcript)
        self.write('lib/a.py', 'A = 2\n')  # a shell edit: only the snapshot could see it
        self.write('lib/b.py', 'B = 2\n')
        self.transcript(prompt(), tool('Write', file_path=str(self.repo / 'lib/b.py')), result())  # a new transcript

        self.assertEqual(self.ran_tests(session_id=SESSION, transcript_path=transcript), {'tests/test_b.py'})

    def test_snapshots_never_touch_the_real_index(self):
        self.write('lib/a.py', 'A = 2\n')
        self.git('add', 'lib/a.py')
        self.write('lib/a.py', 'A = 3\n')
        self.write('lib/new.py', 'N = 1\n')
        index = self.repo / '.git' / 'index'
        before = (self.git('diff', '--cached'), hashlib.sha256(index.read_bytes()).hexdigest())

        self.snapshot()
        self.write('lib/b.py', 'B = 2\n')
        self.ran_tests(session_id=SESSION)

        self.assertEqual((self.git('diff', '--cached'), hashlib.sha256(index.read_bytes()).hexdigest()), before)

    def test_the_adapter_runs_the_snapshot_on_user_prompt_submit(self):
        native = {'hook_event_name': 'UserPromptSubmit', 'cwd': str(self.repo), 'session_id': SESSION,
                  'prompt': 'hi'}
        done = subprocess.run([sys.executable, str(ADAPTER), 'claude', 'related-tests-snapshot'],
                              input=json.dumps(native), capture_output=True, text=True, env=self.env())

        self.assertEqual((done.returncode, done.stdout, done.stderr), (0, '', ''))
        self.assertEqual(len(self.snapshot_files()), 1)


class TranscriptFallbackTests(HookCase):
    """Without a snapshot the turn's files come from the transcript."""

    def setUp(self):
        super().setUp()
        self.write('lib/a.py', 'A = 2\n')
        self.write('lib/b.py', 'B = 2\n')

    def edit(self, path, tool_id='t1'):
        return tool('Write', tool_id, file_path=str(self.repo / path))

    def test_the_transcript_names_the_turns_edits(self):
        meta = {'type': 'user', 'isMeta': True, 'message': {'role': 'user', 'content': 'caveat'}}
        task_done = {'type': 'user', 'message': {'role': 'user', 'content': notification('x')}}
        cases = [
            ('an edit in this turn', [prompt(), self.edit('lib/a.py'), result(), said()], {'tests/test_a.py'}),
            ('an earlier turn\'s edit', [prompt(), self.edit('lib/a.py'), result(), said(), prompt()], None),
            ('a prompt queued between a tool call and its result',
             [prompt(), self.edit('lib/a.py'), prompt('queued'), result(), said()], {'tests/test_a.py'}),
            ('a prompt queued after a tool result',
             [prompt(), self.edit('lib/a.py'), result(), prompt('queued'), said()], {'tests/test_a.py'}),
            ('an isMeta user record', [prompt(), self.edit('lib/a.py'), result(), said(), meta], {'tests/test_a.py'}),
            ('a task notification', [prompt(), self.edit('lib/a.py'), result(), said(), task_done],
             {'tests/test_a.py'}),
            ('a Codex prompt', [self.edit('lib/a.py'), result(), said(),
                                {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'q'}}], None),
            ('MultiEdit', [prompt(), tool('MultiEdit', file_path=str(self.repo / 'lib/b.py'), edits=[])],
             {'tests/test_b.py'}),
            ('NotebookEdit', [prompt(), tool('NotebookEdit', notebook_path=str(self.repo / 'lib/b.py'))],
             {'tests/test_b.py'}),
            ('Codex apply_patch Update File', [codex_patch('*** Update File: lib/a.py\n@@\n-A = 1\n+A = 2\n')],
             {'tests/test_a.py'}),
        ]
        for name, records, expected in cases:
            with self.subTest(name):
                self.assertEqual(self.ran_tests(transcript_path=self.transcript(*records)), expected)

    def test_codex_apply_patch_move_to_names_the_new_path(self):
        (self.repo / 'lib/gone.py').rename(self.repo / 'lib/moved.py')
        self.write('tests/test_moved.py', FAILING)
        patch = codex_patch('*** Update File: lib/gone.py\n*** Move to: lib/moved.py\n')

        self.assertEqual(self.ran_tests(transcript_path=self.transcript(patch)),
                         {'tests/test_moved.py'})

    def test_a_missing_or_unreadable_transcript_counts_every_changed_file(self):
        for path in (str(Path(self.tmp.name) / 'missing.jsonl'), self.tmp.name):  # a directory cannot be read
            with self.subTest(path):
                self.assertEqual(self.ran_tests(transcript_path=path, session_id=SESSION),
                                 {'tests/test_a.py', 'tests/test_b.py'})

    def test_no_changes_or_an_already_blocked_stop_end_silently(self):
        self.assertIsNone(self.run_hook(stop_hook_active=True))
        self.git('stash', '-q')
        self.assertIsNone(self.run_hook())

    def test_a_failing_related_test_blocks_the_stop_until_it_passes(self):
        verdict = self.run_hook(transcript_path=self.transcript(prompt(), self.edit('lib/a.py')))

        self.assertEqual(verdict['decision'], 'deny')
        self.assertIn('boom', verdict['reason'])
        self.write('tests/test_a.py', PASSING)
        self.assertIsNone(self.run_hook(transcript_path=self.transcript(prompt(), self.edit('lib/a.py'))))

    def test_project_toml_command_and_map_win_and_only_an_unchanged_state_is_cached(self):
        log = Path(self.tmp.name) / 'runs.log'
        self.write('.agents/project.toml', '[tests]\ncommand = "sh {files}"\n'
                                           '[tests.map]\n"src/**/*.txt" = ["checks/{stem}.sh"]\n')
        self.write('src/deep/note.txt', 'changed\n')
        self.write('checks/note.sh', f'echo ran >> {log}\necho custom failure\nexit 1\n')

        session = self.transcript(self.edit('src/deep/note.txt'))

        first, second = self.run_hook(transcript_path=session), self.run_hook(transcript_path=session)

        self.assertIn('custom failure', first['reason'])
        self.assertEqual(first, second)
        self.assertEqual(log.read_text(), 'ran\n')  # the second stop read the cache
        self.git('commit', '-q', '--allow-empty', '-m', 'new HEAD')
        self.run_hook(transcript_path=session)
        self.write('Gemfile.lock', 'changed dependency\n')
        self.run_hook(transcript_path=session)
        self.assertEqual(log.read_text(), 'ran\nran\nran\n')  # a new HEAD and a lockfile change each reran


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
