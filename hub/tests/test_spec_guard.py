"""spec-guard: writing-specs rules after a test file is edited, and skill delivery once per session."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOKS = Path(__file__).resolve().parents[2] / 'hooks'
GUARD = HOOKS / 'bin' / 'spec-guard'
ADAPTER = HOOKS / 'adapters' / 'run.py'


class SpecGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / 'spec').mkdir()
        self.session = f'test-{id(self)}'

    def tearDown(self):
        self.tmp.cleanup()
        marker = HOOKS.parent / 'chats' / 'spec-guard-sessions' / self.session
        marker.unlink(missing_ok=True)

    def guard(self, tool, data, session=None, response=None):
        event = {'event': 'after_tool', 'tool': tool, 'cwd': str(self.repo), 'input': data,
                 'session_id': session or self.session, 'response': response or {}}
        result = subprocess.run([sys.executable, str(GUARD)], input=json.dumps(event), capture_output=True, text=True)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def write(self, path, text):
        (self.repo / path).write_text(text)
        return self.guard('Write', {'file_path': path, 'content': text})

    def test_non_test_files_are_ignored(self):
        self.assertEqual(self.guard('Write', {'file_path': 'app/models/user.rb', 'content': 'let(:x) { 1 }'}), {})

    def test_the_skill_is_delivered_once_per_session(self):
        first = self.write('spec/a_spec.rb', "it 'works' do\nend\n")
        second = self.write('spec/b_spec.rb', "it 'works' do\nend\n")

        self.assertIn('writing-specs', first['context'])
        self.assertNotIn('context', second)

    def test_shoulda_one_liners_and_controller_internals_are_reported(self):
        self.write('spec/a_spec.rb', '')  # use up the session's skill delivery
        result = self.write('spec/user_spec.rb', "it { is_expected.to belong_to(:team) }\nexpect(assigns(:u))\n")

        self.assertEqual(result['decision'], 'deny')
        self.assertIn('rule 49', result['reason'])
        self.assertIn('rule 30', result['reason'])

    def test_let_is_reported_only_when_the_file_does_not_already_use_it(self):
        self.write('spec/a_spec.rb', '')
        new_style = self.write('spec/new_spec.rb', "let(:user) { create(:user) }\n")
        (self.repo / 'spec/old_spec.rb').write_text("let(:a) { 1 }\nlet(:b) { 2 }\n")
        edit = self.guard('Edit', {'file_path': 'spec/old_spec.rb', 'new_string': 'let(:b) { 2 }'})

        self.assertIn('rule 34', new_style['reason'])
        self.assertNotIn('decision', edit)

    def test_let_in_other_languages_is_not_rspec_let(self):
        self.write('spec/a_spec.rb', '')
        (self.repo / 'tests').mkdir()

        self.assertNotIn('decision', self.write('spec/helper.test.js', 'let { a } = require("x")\n'))
        self.assertNotIn('decision', self.write('tests/it.rs', 'let (a, b) = (1, 2);\n'))

    def test_replacing_the_only_let_preserves_style_but_introducing_it_is_reported(self):
        path = 'spec/user_spec.rb'
        new = 'let(:b) { 2 }\n'
        for old in ('let(:a) { 1 }\n', ''):
            edits = [{'old_string': old, 'new_string': new}]
            patch = ('*** Begin Patch\n*** Update File: ' + path + '\n@@\n'
                     + ''.join('-' + line + '\n' for line in old.splitlines())
                     + '+' + new + '*** End Patch\n')
            for tool, data, response in (
                ('Write', {'file_path': path, 'content': new}, {'originalFile': old}),
                ('Edit', {'file_path': path, **edits[0]}, {}),
                ('MultiEdit', {'file_path': path, 'edits': edits}, {}),
                ('apply_patch', {'command': patch}, {}),
            ):
                with self.subTest(tool=tool, existing_let=bool(old)):
                    (self.repo / path).write_text(old)
                    self.assertEqual((self.repo / path).read_text(), old)
                    (self.repo / path).write_text(new)

                    result = self.guard(tool, data, response=response)

                    if old:
                        self.assertNotIn('decision', result)
                    else:
                        self.assertEqual(result.get('decision'), 'deny')
                        self.assertIn('rule 34', result['reason'])

    def test_repeating_existing_lines_in_an_edit_is_not_adding_them(self):
        self.write('spec/a_spec.rb', '')
        (self.repo / 'spec/old_spec.rb').write_text("let(:a) { 1 }\nlet(:b) { 2 }\nit { x }\n")

        result = self.guard('Edit', {'file_path': 'spec/old_spec.rb', 'old_string': "let(:a) { 1 }\nlet(:b) { 2 }",
                                     'new_string': "let(:a) { 1 }\nlet(:b) { 2 }\nlet(:c) { 3 }"})

        self.assertNotIn('decision', result)

    def test_codex_apply_patch_added_lines_are_checked(self):
        self.write('spec/a_spec.rb', '')
        patch = ('*** Begin Patch\n*** Update File: spec/user_spec.rb\n@@\n-old\n'
                 '+it { should.to validate_presence_of(:name) }\n*** End Patch\n')

        result = self.guard('apply_patch', {'input': patch})

        self.assertIn('rule 49', result['reason'])


class AdapterContextTests(unittest.TestCase):
    def run_adapter(self, answer, event='PostToolUse'):
        with tempfile.TemporaryDirectory() as tmp:
            hooks = Path(tmp)
            (hooks / 'adapters').mkdir()
            (hooks / 'bin').mkdir()
            shutil.copy(ADAPTER, hooks / 'adapters' / 'run.py')
            script = hooks / 'bin' / 'probe'
            script.write_text(f"#!/bin/sh\necho '{json.dumps(answer)}'\n")
            script.chmod(0o755)
            native = {'hook_event_name': event, 'tool_name': 'Write', 'tool_input': {}}
            return subprocess.run([sys.executable, str(hooks / 'adapters' / 'run.py'), 'claude', 'probe'],
                                  input=json.dumps(native), capture_output=True, text=True)

    def test_context_alone_is_passed_to_the_agent_without_blocking(self):
        result = self.run_adapter({'context': 'follow the skill'})

        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['additionalContext'], 'follow the skill')

    def test_a_deny_after_an_edit_reports_back_with_any_context_appended(self):
        result = self.run_adapter({'decision': 'deny', 'reason': 'rule 34', 'context': 'the skill'})

        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout), {'decision': 'block', 'reason': 'rule 34\n\nthe skill'})


if __name__ == '__main__':
    unittest.main()
