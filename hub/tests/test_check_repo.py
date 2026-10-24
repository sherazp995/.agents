"""check.py check_repo: selected skills are all listed and skill references in the docs resolve."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

CHECKOUT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('check_for_repo_tests', CHECKOUT / 'check.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

STEPS = '# x\n\n' + ''.join(f'{n}. **Step {n}.** Do it.\n' for n in range(1, 9))


class CheckRepoTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.hub = Path(tmp.name)
        subprocess.run(['git', 'init', '-q'], cwd=self.hub, check=True)
        (self.hub / 'selected-skills.json').write_text(json.dumps({'skills': ['x'], 'roots': []}))
        self.write('skills/x/SKILL.md', STEPS)
        self.agents('See `x` step 8.')

    def write(self, path, text):
        (self.hub / path).parent.mkdir(parents=True, exist_ok=True)
        (self.hub / path).write_text(text)

    def agents(self, body):
        self.write('AGENTS.md', f'[config](~/.agents/AGENTS-CONFIG.md)\n\n{body}\n')

    def broken(self, body):
        self.agents(body)
        return check.check_references(self.hub)

    def test_a_valid_hub_passes(self):
        self.assertEqual(check.check_repo(self.hub)[1], {'x'})

    def test_a_skill_missing_from_selected_skills_fails(self):
        self.write('skills/y/SKILL.md', STEPS)
        with self.assertRaisesRegex(AssertionError, r"not listed in selected-skills.json: \['y'\]"):
            check.check_repo(self.hub)

    def test_a_step_reference_past_the_last_step_fails_at_either_end(self):
        self.assertEqual(self.broken('Go to `x` step 9.'), ['AGENTS.md:3: `x` has no step 9'])
        self.assertEqual(self.broken('Run `x` steps 5 to 99.'), ['AGENTS.md:3: `x` has no step 99'])
        self.assertEqual(self.broken('Run `x` steps 5 to 8.'), [])

    def test_a_missing_skill_fails_by_name_or_hub_path(self):
        for body in ('Use the `ghost` skill.', 'Read ~/.agents/skills/ghost/SKILL.md.', 'Read ~/.agents/skills/ghost.'):
            with self.subTest(body):
                self.assertEqual(self.broken(body), ['AGENTS.md:3: no skill `ghost`'])

    def test_a_project_skill_path_is_not_a_hub_path(self):
        self.assertEqual(self.broken('In that repo: .claude/skills/ghost/SKILL.md.'), [])

    def test_a_git_ignored_skill_folder_is_skipped_even_without_a_trailing_slash(self):
        self.assertEqual(self.broken('Download skills/ignored into place.'), ['AGENTS.md:3: no skill `ignored`'])
        self.write('.gitignore', 'skills/ignored/\n')
        self.assertEqual(self.broken('Download skills/ignored into place.'), [])

    def test_examples_inside_a_code_fence_are_skipped(self):
        self.assertEqual(self.broken('```\nUse the `ghost` skill, `x` step 99.\n```'), [])

    def test_the_real_checkout_passes(self):
        self.assertEqual(check.check_references(CHECKOUT), [])


if __name__ == '__main__':
    unittest.main()
