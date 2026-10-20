"""The done-check Stop hook: a finished task is checked once by a fresh checker."""
from importlib.machinery import SourceFileLoader
import json
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest
import unittest.mock

HOOK = Path(__file__).resolve().parents[2] / 'hooks' / 'bin' / 'done-check'
hook = SourceFileLoader('done_check', str(HOOK)).load_module()


def prompt(text='add the export button'):
    return {'type': 'user', 'message': {'role': 'user', 'content': text}}


def tool(name, **tool_input):
    return {'type': 'assistant', 'message': {'content': [
        {'type': 'tool_use', 'id': 't1', 'name': name, 'input': tool_input}]}}


def said(text):
    return {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': text}]}}


def codex_exec(argv, workdir=None):
    return {'type': 'response_item', 'payload': {'type': 'function_call', 'name': 'exec_command',
                                                 'arguments': json.dumps({'cmd': argv, 'workdir': workdir})}}


def codex_message(role, text):
    return {'type': 'response_item', 'payload': {'type': 'message', 'role': role, 'content': [
        {'type': 'input_text' if role == 'user' else 'output_text', 'text': text}]}}


class DoneCheckTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.repo = self.dir / 'repo'
        self.repo.mkdir()
        for args in (['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']):
            subprocess.run(['git', *args], cwd=self.repo, check=True)
        (self.repo / 'a.py').write_text('x = 1\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'start')
        self.transcript = self.dir / 'transcript.jsonl'
        patch = unittest.mock.patch.object(hook, 'STATE', self.dir / 'state')
        patch.start()
        self.addCleanup(patch.stop)

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.repo, check=True)

    def stop(self, *records):
        with self.transcript.open('a') as handle:
            handle.writelines(json.dumps(record) + '\n' for record in records)
        return hook.verdict({'cwd': str(self.repo), 'session_id': 's1', 'transcript_path': str(self.transcript)})

    def edit_and_claim(self, text='Done: the export button works and its spec passes.'):
        (self.repo / 'a.py').write_text('x = 2\n')
        return self.stop(prompt(), tool('Edit', file_path=str(self.repo / 'a.py')), said(text))

    def test_a_question_turn_ends_untouched(self):
        self.assertIsNone(self.stop(prompt('what does a.py do?'), said('It sets x. Done.')))

    def test_work_in_progress_ends_untouched_even_when_it_says_not_done(self):
        self.assertIsNone(self.edit_and_claim('I changed a.py; next I will add the spec.'))
        self.assertIsNone(self.edit_and_claim("Not done yet: the spec isn't finished."))
        self.assertIsNone(self.edit_and_claim('Is it done? Once the spec is done I will commit.'))

    def test_a_done_claim_asks_for_one_completion_and_correctness_check_with_the_request(self):
        result = self.edit_and_claim()
        self.assertEqual(result['decision'], 'deny')
        for words in ('COMPLETION', 'CORRECTNESS', 'add the export button', '`git diff HEAD`', 'DONE-CHECK: PASS'):
            self.assertIn(words, result['reason'])

    def test_a_commit_triggers_the_check_on_that_commit_even_without_a_claim(self):
        (self.repo / 'a.py').write_text('x = 3\n')
        self.git('commit', '-qam', 'Add export button')
        result = self.stop(prompt(), tool('Bash', command='git commit -m "Add export button"'), said('Committed.'))
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.repo, capture_output=True, text=True).stdout
        self.assertIn(f'`git show {head.strip()}`', result['reason'])

    def test_work_in_another_repo_is_checked_there_not_in_the_session_folder(self):
        session = self.dir / 'session'
        session.mkdir()
        subprocess.run(['git', 'init', '-q'], cwd=session, check=True)
        (self.repo / 'a.py').write_text('x = 3\n')
        self.git('commit', '-qam', 'Add export button')
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.repo, capture_output=True, text=True).stdout
        with self.transcript.open('a') as handle:
            handle.writelines(json.dumps(r) + '\n' for r in (
                prompt(), tool('Bash', command=f'cd {self.repo} && git commit -m "Add export button"'), said('ok')))
        result = hook.verdict({'cwd': str(session), 'session_id': 's1', 'transcript_path': str(self.transcript)})
        self.assertIn(f'`git show {head.strip()}` in {self.repo.resolve()}', result['reason'])

    def test_a_codex_commit_in_its_own_workdir_is_checked_in_that_repo(self):
        (self.repo / 'a.py').write_text('x = 3\n')
        self.git('commit', '-qam', 'Add export button')
        with self.transcript.open('a') as handle:
            handle.writelines(json.dumps(r) + '\n' for r in (
                prompt(), codex_exec(['git', 'commit', '-m', 'x'], workdir=str(self.repo)), said('ok')))
        result = hook.verdict({'cwd': str(self.dir), 'session_id': 's1', 'transcript_path': str(self.transcript)})
        self.assertIn(f'in {self.repo.resolve()}', result['reason'])

    def test_a_round_logged_as_a_new_prompt_still_ends_the_round(self):
        self.edit_and_claim()
        (self.repo / 'a.py').write_text('x = 5\n')
        self.assertIsNone(self.stop(prompt('<hook continuation>'), tool('Edit', file_path=str(self.repo / 'a.py')),
                                    said('Fixed the spec.\nDONE-CHECK: PASS')))
        self.assertIsNone(self.stop(said('Done.')))

    def test_codex_response_messages_trigger_and_finish_one_check(self):
        result = self.stop(codex_message('user', 'correct the timeout example'),
                           codex_exec('git commit --amend --no-edit'),
                           codex_message('assistant', 'Done.'))
        self.assertIsNotNone(result)
        self.assertEqual(result['decision'], 'deny')
        self.assertIn('correct the timeout example', result['reason'])
        self.assertIsNone(self.stop(codex_message('assistant', 'DONE-CHECK: PASS')))
        self.assertIsNone(self.stop())

    def test_codex_injected_context_mid_turn_does_not_start_a_new_turn(self):
        result = self.stop(codex_message('user', 'correct the timeout example'),
                           codex_exec('git commit --amend --no-edit'),
                           codex_message('user', '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>...'),
                           codex_message('assistant', 'Committed.'))
        self.assertIn('correct the timeout example', result['reason'])

    def test_codex_question_does_not_inherit_a_previous_turns_commit(self):
        self.assertIsNone(self.stop(
            codex_message('user', 'correct the timeout example'),
            codex_exec('git commit --amend --no-edit'),
            codex_message('assistant', 'Done.'),
            codex_message('user', 'what is the timeout?'),
            codex_message('assistant', '60 seconds.')))

    def test_a_round_ends_the_turn_whatever_its_result_and_the_same_change_is_never_rechecked(self):
        for ending in ('Checker found nothing.\nDONE-CHECK: PASS', 'DONE-CHECK: OPEN: the CSV header spec fails',
                       'Fixed it.'):
            with self.subTest(ending=ending):
                self.transcript.unlink(missing_ok=True)
                shutil.rmtree(self.dir / 'state', ignore_errors=True)
                self.assertEqual(self.edit_and_claim()['decision'], 'deny')
                self.assertIsNone(self.stop(said(ending)))
                self.assertIsNone(self.stop(said('Done.')))

    def test_a_check_abandoned_by_a_new_prompt_is_replaced(self):
        self.edit_and_claim()
        (self.repo / 'a.py').write_text('x = 4\n')
        result = self.stop(prompt('also rename x'), tool('Edit', file_path=str(self.repo / 'a.py')), said('Done.'))
        self.assertIn('also rename x', result['reason'])

    def test_a_turn_with_a_background_agent_still_running_is_not_finished(self):
        (self.repo / 'a.py').write_text('x = 2\n')
        launch = {'type': 'user', 'timestamp': '2999-01-01T00:00:00Z', 'message': {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': 't9', 'content': 'Async agent launched successfully.\nagentId: a1'}]}}
        with unittest.mock.patch.object(hook.turns, 'still_running', return_value={'t9'}):
            self.assertIsNone(self.stop(prompt(), tool('Edit', file_path=str(self.repo / 'a.py')), launch,
                                        said('Done, the reviewer is running.')))


if __name__ == '__main__':
    unittest.main()
