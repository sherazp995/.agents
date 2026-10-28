"""run-state.py: stages per task, each tied to the tree it ran on, through the CLI the run prompt calls."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from helpers import SKILL, git, make_repo, write_plan

SCRIPT = SKILL / 'run-state.py'


class RunStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = make_repo(self.root / 'repo')
        self.run_dir = self.root / 'runs' / 'r1'

    def rs(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(SCRIPT), args[0], str(self.run_dir), *args[1:]],
                                capture_output=True, text=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def init(self, *plans):
        return json.loads(self.rs('init', *map(str, plans)).stdout)

    def state(self):
        return json.loads((self.run_dir / 'state.json').read_text())

    def worktree(self, task):
        path = self.root / f'repo-{task}'
        git(self.repo, 'worktree', 'add', '-q', '-b', f'autonomous/{task}', str(path), 'HEAD')
        return path

    def advance(self, task, *stages, **finish_args):
        for stage in stages:
            self.assertEqual(self.rs('next', task).stdout.strip(), stage)
            self.rs('start', task, stage)
            extra = ['--worktree', str(finish_args['worktree'])] if stage == 'worktree' else []
            self.rs('finish', task, stage, *extra)

    def test_init_groups_by_repo_and_stops_an_unverified_plan(self):
        other = make_repo(self.root / 'other')
        first = write_plan(self.root / 'first.md', self.repo)
        second = write_plan(self.root / 'second.md', other)
        third = write_plan(self.root / 'third.md', self.repo)
        bad = write_plan(self.root / 'bad.md', self.repo)
        bad.write_text(bad.read_text().replace('Rename the class.', 'Rename everything.'))
        summary = self.init(first, second, bad, third)
        self.assertEqual([(g['repo'], g['tasks']) for g in summary['groups']],
                         [(str(self.repo), ['first', 'third']), (str(other), ['second'])])
        self.assertEqual([s['task'] for s in summary['stopped']], ['bad'])
        self.assertIn('changed after the approval', summary['stopped'][0]['reason'])
        self.assertEqual(self.rs('next', 'bad').stdout.strip(), 'stopped: ' + summary['stopped'][0]['reason'])
        self.assertTrue((self.run_dir / 'plans' / 'first.md').is_file())

    def test_resume_skips_finished_stages_and_reruns_one_left_running(self):
        self.init(write_plan(self.root / 'plan.md', self.repo))
        tree = self.worktree('plan')
        self.advance('plan', 'worktree', 'build', worktree=tree)
        self.rs('start', 'plan', 'review')  # the session dies here
        self.assertEqual(self.rs('next', 'plan').stdout.strip(), 'review')
        refused = self.rs('start', 'plan', 'build', ok=False)
        self.assertEqual(refused.returncode, 1)
        self.assertIn('is at review, not build', refused.stderr)

    def test_a_changed_tree_reopens_the_stages_that_ran_on_the_old_one(self):
        self.init(write_plan(self.root / 'plan.md', self.repo))
        tree = self.worktree('plan')
        (tree / 'app.txt').write_text('gadget\n')
        self.advance('plan', 'worktree', 'build', 'review', worktree=tree)
        # QA output is evidence, not a change.
        (tree / 'tmp' / 'visual-qa').mkdir(parents=True)
        (tree / 'tmp' / 'visual-qa' / 'index.html').write_text('report')
        self.assertEqual(self.rs('next', 'plan').stdout.strip(), 'qa-visual')
        # A repair during QA: QA finishes on the new tree, so the checks and the review recheck rerun.
        self.rs('start', 'plan', 'qa-visual')
        (tree / 'new.txt').write_text('untracked fix\n')
        self.rs('finish', 'plan', 'qa-visual')
        self.advance('plan', 'build', 'review')
        self.assertEqual(self.rs('next', 'plan').stdout.strip(), 'qa-video')
        self.rs('start', 'plan', 'qa-video')
        self.rs('finish', 'plan', 'qa-video', '--skipped', 'nothing a user sees')
        self.advance('plan', 'done-check')
        git(tree, 'add', '--', 'app.txt', 'new.txt')
        git(tree, 'commit', '-q', '-m', 'Rename widget')
        self.advance('plan', 'commit')
        self.assertEqual(self.rs('next', 'plan').stdout.strip(), 'done')
        entry = self.state()['tasks']['plan']
        self.assertEqual((entry['status'], entry['commit']), ('done', git(tree, 'rev-parse', 'HEAD')))
        self.assertEqual(entry['stages']['qa-video']['skip_reason'], 'nothing a user sees')

    def test_a_plan_edited_mid_run_stops_its_task(self):
        plan = write_plan(self.root / 'plan.md', self.repo)
        self.init(plan)
        plan.write_text(plan.read_text().replace('python3 -m unittest', 'true'))
        self.assertTrue(self.rs('next', 'plan').stdout.startswith('stopped: approval: the Confirmed intent'))
        self.assertEqual(self.state()['tasks']['plan']['status'], 'stopped')

    def test_a_stopped_first_task_leaves_the_second_pending(self):
        self.init(write_plan(self.root / 'one.md', self.repo), write_plan(self.root / 'two.md', self.repo))
        self.assertEqual(self.rs('queue', '0').stdout.split(), ['one', 'two'])
        self.rs('stop', 'one', 'two failed tries on the migration')
        self.assertEqual(self.rs('queue', '0').stdout.split(), ['two'])
        self.assertEqual(self.rs('next', 'one').stdout.strip(), 'stopped: two failed tries on the migration')
        self.assertEqual(self.rs('next', 'two').stdout.strip(), 'worktree')
        entry = self.state()['tasks']['one']
        self.assertEqual((entry['status'], entry['stopped_stage']), ('stopped', 'worktree'))
        self.assertEqual(self.state()['tasks']['two']['status'], 'pending')

    def test_the_last_group_to_end_sends_the_report_once(self):
        other = make_repo(self.root / 'other')
        self.init(write_plan(self.root / 'one.md', self.repo), write_plan(self.root / 'two.md', other))
        self.rs('stop', 'one', 'QA unavailable: no browser')
        self.assertEqual(self.rs('group-done', '0').stdout.strip(), 'wait')
        self.assertEqual(self.rs('group-exit', '0', '0').stdout.strip(), 'ok')
        self.assertEqual(self.rs('group-exit', '1', '1').stdout.strip(), 'crashed last')
        self.assertEqual(self.rs('group-done', '1').stdout.strip(), 'wait')  # already claimed
        self.assertEqual(self.rs('resume').stdout.split(), ['1'])
        (self.run_dir / 'tasks' / 'one.md').write_text('- **Status:** stopped at qa-visual')
        report = Path(self.rs('report').stdout.strip()).read_text()
        self.assertIn('| one | ', report)
        self.assertIn('stopped at worktree: QA unavailable: no browser', report)
        self.assertIn('unfinished, at worktree', report)
        self.assertIn('--resume r1', report)
        self.assertIn('- **Status:** stopped at qa-visual', report)


if __name__ == '__main__':
    unittest.main()
