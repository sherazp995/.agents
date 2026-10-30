"""plan-guard: writing-plans sections when a plan file is written, and skill delivery once per session."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HOOKS = Path(__file__).resolve().parents[2] / 'hooks'
GUARD = HOOKS / 'bin' / 'plan-guard'
SECTIONS = ['In short', 'Decisions for you', 'How it works today', 'How it will work', 'What changes',
            'Confirmed intent', 'Steps', 'Tests', 'Checks', 'Risks and not doing']


def plan(sections=SECTIONS, status=True):
    head = ['# CI-1: admins see the average', '', '- Status: Waiting for approval' if status else '- Branch: main', '']
    return '\n'.join(head + [line for name in sections for line in (f'## {name}', '', 'text', '')])


class PlanGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / '.claude' / 'plans').mkdir(parents=True)
        self.session = f'test-{id(self)}'

    def tearDown(self):
        self.tmp.cleanup()
        (HOOKS.parent / 'chats' / 'plan-guard-sessions' / self.session).unlink(missing_ok=True)

    def guard(self, tool, data):
        payload = {'event': 'after_tool', 'tool': tool, 'cwd': str(self.home), 'input': data, 'session_id': self.session}
        result = subprocess.run([sys.executable, str(GUARD)], input=json.dumps(payload), capture_output=True, text=True)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def write(self, text, name='fix.md', tool='Write'):
        path = self.home / '.claude' / 'plans' / name
        path.write_text(text)
        return self.guard(tool, {'file_path': str(path), 'content': text})

    def test_a_complete_plan_passes_and_gets_the_skill_once(self):
        first = self.write(plan())
        second = self.write(plan(), name='other.md')

        self.assertNotIn('decision', first)
        self.assertIn('writing-plans', first['context'])
        self.assertEqual(second, {})

    def test_a_missing_section_and_status_line_are_reported(self):
        result = self.write(plan([name for name in SECTIONS if name != 'How it works today'], status=False))

        self.assertEqual(result['decision'], 'deny')
        self.assertIn('"## How it works today"', result['reason'])
        self.assertIn('no "Status:" line', result['reason'])

    def test_sections_out_of_order_are_reported(self):
        swapped = SECTIONS[:7] + ['Checks', 'Tests'] + SECTIONS[9:]
        self.assertIn('out of order', self.write(plan(swapped))['reason'])

    def test_an_edit_is_checked_against_the_whole_file(self):
        self.write(plan())  # use up the session's skill delivery
        path = self.home / '.claude' / 'plans' / 'fix.md'
        path.write_text(plan([name for name in SECTIONS if name != 'Tests']))

        result = self.guard('Edit', {'file_path': str(path), 'old_string': 'a', 'new_string': 'b'})

        self.assertIn('"## Tests"', result['reason'])

    def test_markdown_outside_the_plan_folders_is_ignored(self):
        (self.home / 'README.md').write_text('# Readme\n')
        self.assertEqual(self.guard('Write', {'file_path': str(self.home / 'README.md'), 'content': '# Readme\n'}), {})

    def test_codex_patches_are_checked(self):
        path = self.home / '.codex' / 'plans' / 'fix.md'
        path.parent.mkdir(parents=True)
        path.write_text(plan(SECTIONS[:-1]))

        result = self.guard('apply_patch', {'command': f'*** Begin Patch\n*** Add File: {path}\n+x\n*** End Patch'})

        self.assertIn('"## Risks and not doing"', result['reason'])


if __name__ == '__main__':
    unittest.main()
