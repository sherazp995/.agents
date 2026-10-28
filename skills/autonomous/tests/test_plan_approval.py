"""plan-approval.py: the approval stamp survives ticked steps and breaks on any edit to what was approved."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from helpers import PLAN, SKILL, make_repo, write_plan

SCRIPT = SKILL / 'plan-approval.py'


def run(*args, cwd=None):
    return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd, capture_output=True, text=True)


class PlanApprovalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = make_repo(self.root / 'repo')
        self.plan = write_plan(self.root / 'plan.md', self.repo, words='yes,  ship it')

    def verify(self):
        return run('verify', str(self.plan))

    def edit(self, old, new):
        text = self.plan.read_text()
        self.assertIn(old, text)
        self.plan.write_text(text.replace(old, new))

    def test_sign_writes_the_stamp_above_the_first_section(self):
        header = self.plan.read_text().split('## Confirmed intent')[0]
        self.assertRegex(header, r'\nApproved: \d{4}-\d\d-\d\d yes, ship it\n')
        self.assertIn(f'\nRepo: {self.repo}\n', header)
        self.assertRegex(header, r'\nApproved-sha256: [0-9a-f]{64}\n')
        self.assertEqual(self.verify().returncode, 0)

    def test_ticking_steps_and_logging_keep_it_valid(self):
        self.edit('- [ ] 1. Rename', '- [x] 1. Rename')
        self.edit('- [ ] 2. Update', '- [X] 2. Update')
        self.edit('## Log\n', '## Log\n- step 1 passed\n')
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_an_edited_step_check_or_intent_fails(self):
        for old, new in [('Rename the class.', 'Rename the module.'), ('python3 -m unittest', 'true'),
                         ('called gadget', 'called gizmo'), ('- [ ] 2. Update the callers.\n', '')]:
            with self.subTest(old=old):
                original = self.plan.read_text()
                self.edit(old, new)
                result = self.verify()
                self.assertEqual(result.returncode, 1)
                self.assertIn('changed after the approval', result.stderr)
                self.assertEqual(len(result.stderr.strip().splitlines()), 1)
                self.plan.write_text(original)

    def test_missing_stamp_lines_fail(self):
        for line in ('Approved: ', 'Repo: ', 'Approved-sha256: '):
            with self.subTest(line=line):
                original = self.plan.read_text()
                self.plan.write_text(''.join(l for l in original.splitlines(True) if not l.startswith(line)))
                result = self.verify()
                self.assertEqual(result.returncode, 1)
                self.assertIn(f'no "{line.strip()}" line', result.stderr)
                self.plan.write_text(original)

    def test_sign_twice_replaces_the_stamp(self):
        self.edit('Rename the class.', 'Rename the module.')
        self.assertEqual(run('sign', str(self.plan), '--words', 'yes again', cwd=self.repo).returncode, 0)
        text = self.plan.read_text()
        for key in ('Approved: ', 'Repo: ', 'Approved-sha256: '):
            self.assertEqual(text.count('\n' + key), 1, key)
        self.assertIn('yes again', text)
        self.assertNotIn('ship it', text)
        self.assertEqual(self.verify().returncode, 0)

    def test_sign_refuses_outside_a_repo_or_without_a_section(self):
        outside = run('sign', str(self.plan), '--words', 'yes', cwd=self.root)
        self.assertEqual(outside.returncode, 1)
        self.assertIn('not inside a git repository', outside.stderr)
        self.plan.write_text(PLAN.replace('## Checks', '## Tests'))
        missing = run('sign', str(self.plan), '--words', 'yes', cwd=self.repo)
        self.assertEqual(missing.returncode, 1)
        self.assertIn('"## Checks"', missing.stderr)


if __name__ == '__main__':
    unittest.main()
