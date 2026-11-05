"""plan-guard: writing-plans sections and planning steps when a plan is written, skill delivery once per session."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HOOKS = Path(__file__).resolve().parents[2] / 'hooks'
GUARD = HOOKS / 'bin' / 'plan-guard'
SECTIONS = ['In short', 'Decisions for you', 'How it works today', 'How it will work', 'What changes',
            'Confirmed intent', 'Steps', 'Tests', 'Checks', 'Risks and not doing']


def plan(sections=SECTIONS, status='Approved 2026-11-04'):
    head = ['# CI-1: admins see the average', '', f'- Status: {status}' if status else '- Branch: main', '']
    return '\n'.join(head + [line for name in sections for line in (f'## {name}', '', 'text', '')])


class PlanGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / '.claude' / 'plans').mkdir(parents=True)
        self.plans = self.home / 'hub-plans'
        self.plans.mkdir()
        self.archify = self.home / 'archify'
        self.session = f'test-{id(self)}'

    def tearDown(self):
        self.tmp.cleanup()
        (HOOKS.parent / 'chats' / 'plan-guard-sessions' / self.session).unlink(missing_ok=True)

    def guard(self, tool, data):
        payload = {'event': 'after_tool', 'tool': tool, 'cwd': str(self.home), 'input': data, 'session_id': self.session}
        env = dict(os.environ, PLAN_GUARD_ARCHIFY=str(self.archify), PLAN_GUARD_PLANS=str(self.plans))
        result = subprocess.run([sys.executable, str(GUARD)], input=json.dumps(payload), capture_output=True,
                                text=True, env=env)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def write(self, text, name='fix.md', tool='Write'):
        path = self.home / '.claude' / 'plans' / name
        path.write_text(text)
        return self.guard(tool, {'file_path': str(path), 'content': text})

    def ready_plan(self, diagram=True, log='- 2026-11-04: context-free plan review; findings taken.', advisor=None):
        head = ['# CI-1: admins see the average', '', '- Status: Waiting for approval']
        if advisor:
            head.append(f'- Advisor status: {advisor}')
        body = [line for name in SECTIONS for line in (f'## {name}', '', 'text', '')]
        body += ['Follow-up ticket suggestions:', '- None', '', '## Appendix', '']
        if diagram:
            html = self.home / 'diagram.html'
            html.write_text('<html></html>')
            body += ['### Diagram', '', f'- Today and after: {html}', '']
        body += ['### Root cause', '', '- x', '', '## Log', '', log, '']
        return '\n'.join(head + [''] + body)

    def test_a_complete_plan_passes_and_gets_the_skill_once_and_the_checklist_per_plan(self):
        first = self.write(plan())
        again = self.write(plan())
        other = self.write(plan(), name='other.md')

        self.assertNotIn('decision', first)
        self.assertIn('writing-plans', first['context'])
        self.assertIn('Planning steps', first['context'])
        self.assertEqual(again, {})
        self.assertNotIn('writing-plans skill)', other['context'])
        self.assertIn('Planning steps', other['context'])

    def test_a_missing_section_and_status_line_are_reported(self):
        result = self.write(plan([name for name in SECTIONS if name != 'How it works today'], status=None))

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

    def test_a_plan_waiting_for_approval_with_every_step_passes(self):
        self.archify.mkdir()
        self.assertNotIn('decision', self.write(self.ready_plan()))

    def test_a_plan_waiting_for_approval_without_its_steps_is_refused(self):
        self.archify.mkdir()

        reason = self.write(plan(status='Waiting for approval'))['reason']

        self.assertIn('Follow-up ticket suggestions', reason)
        self.assertIn('no "## Log" section', reason)
        self.assertIn('archify diagram', reason)

    def test_a_log_without_the_context_free_review_is_refused(self):
        self.archify.mkdir()
        reason = self.write(self.ready_plan(log='- 2026-11-04: plan written.'))['reason']
        self.assertIn('context-free plan review', reason)

    def test_a_diagram_link_to_a_missing_file_is_refused(self):
        self.archify.mkdir()
        text = self.ready_plan().replace(str(self.home / 'diagram.html'), str(self.home / 'gone.html'))
        self.assertIn('points to no file', self.write(text)['reason'])

    def test_no_diagram_is_needed_when_archify_is_not_installed(self):
        self.assertNotIn('decision', self.write(self.ready_plan(diagram=False)))

    def test_a_rethink_plan_needs_its_sections(self):
        self.archify.mkdir()
        reason = self.write(self.ready_plan(advisor='agreed'))['reason']
        self.assertIn('## Review pre-check', reason)
        self.assertIn('## Advisor opinions', reason)

    def test_a_shell_edit_checks_recently_changed_plans_once_per_version(self):
        self.archify.mkdir()
        (self.plans / 'scripted.md').write_text(plan(status='Waiting for approval'))

        first = self.guard('Bash', {'command': 'python3 edit.py'})
        second = self.guard('Bash', {'command': 'ls'})

        self.assertIn('no "## Log" section', first['reason'])
        self.assertEqual(second, {})


if __name__ == '__main__':
    unittest.main()
