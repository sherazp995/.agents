"""`agents-hub account` and the install/check account sync, against a temporary home."""
import os
from pathlib import Path
import subprocess
import tempfile
import tomllib
import sys
import unittest

from test_install import install, load, make_hub

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agents_hub import registry  # noqa: E402

ALIAS = 'alias work=\'CLAUDE_CONFIG_DIR="$HOME/.work" claude\'  # agents-hub account\n'


class AccountCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        (self.home / '.claude/projects').mkdir(parents=True)
        (self.home / '.claude/settings.json').write_text('{}')
        self.hub = make_hub(self.home)
        self.links = tomllib.loads((self.hub / 'registry.toml').read_text())['clients'][0]['account_links']

    def tearDown(self):
        self.tmp.cleanup()

    def account(self, *args, shell='/bin/zsh'):
        env = {**os.environ, 'AGENTS_HUB_HOME': str(self.home), 'SHELL': shell}
        return subprocess.run([str(self.hub / 'hub/agents-hub'), 'account', *args],
                              capture_output=True, text=True, env=env)

    def recorded(self):
        path = self.hub / 'accounts.toml'
        return tomllib.loads(path.read_text()).get('accounts', []) if path.exists() else None

    def zshrc(self):
        return (self.home / '.zshrc').read_text()


class AddTests(AccountCase):
    def test_add_links_each_shared_entry_relative_and_adds_a_marked_alias(self):
        result = self.account('add', 'claude', 'work')

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({e: os.readlink(self.home / '.work' / e) for e in self.links},
                         {e: f'../.claude/{e}' for e in self.links})
        self.assertEqual(self.zshrc(), ALIAS)
        self.assertEqual(self.recorded(), [{'client': 'claude', 'alias': 'work', 'dir': '~/.work'}])
        self.assertIn('run `work` and sign in', result.stdout)

    def test_an_account_folder_reached_through_a_symlink_gets_working_links(self):
        (self.home / 'accounts/work').mkdir(parents=True)
        (self.home / '.work').symlink_to(self.home / 'accounts/work')

        result = self.account('add', 'claude', 'work')

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.home / '.work/settings.json').read_text(), '{}')

    def test_an_account_folder_that_is_the_first_login_by_another_name_is_refused(self):
        (self.home / '.work').symlink_to(self.home / '.claude')

        result = self.account('add', 'claude', 'work')

        self.assertEqual(result.returncode, 1)
        self.assertIn('is the first login', result.stderr)
        self.assertFalse((self.home / '.claude/settings.json').is_symlink())

    def test_add_again_changes_nothing(self):
        self.account('add', 'claude', 'work')
        before = (self.zshrc(), self.recorded(), [os.readlink(self.home / '.work' / e) for e in self.links])

        again = self.account('add', 'claude', 'work')

        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual((self.zshrc(), self.recorded(), [os.readlink(self.home / '.work' / e) for e in self.links]),
                         before)
        self.assertNotIn('linked', again.stdout)

    def test_a_foreign_file_is_a_conflict_and_nothing_is_changed(self):
        (self.home / '.work').mkdir()
        (self.home / '.work/settings.json').write_text('mine')

        result = self.account('add', 'claude', 'work')

        self.assertEqual(result.returncode, 1)
        self.assertIn('conflict: ~/.work/settings.json', result.stderr)
        self.assertEqual((self.home / '.work/settings.json').read_text(), 'mine')
        self.assertEqual(os.listdir(self.home / '.work'), ['settings.json'])
        self.assertIsNone(self.recorded())
        self.assertFalse((self.home / '.zshrc').exists())

    def test_a_name_already_used_by_a_command_alias_or_function_is_refused_and_nothing_changes(self):
        (self.home / '.bash_aliases').write_text("alias work='claude --verbose'\n")
        (self.home / '.zshrc').write_text('deploy() { echo; }\n')
        for alias, reason in (('codex', 'app command'), ('ls', 'already a command'),
                              ('work', 'alias or function in ~/.bash_aliases'),
                              ('deploy', 'alias or function in ~/.zshrc')):
            result = self.account('add', 'claude', alias)

            self.assertEqual(result.returncode, 1, alias)
            self.assertIn(reason, result.stderr)
            self.assertFalse((self.home / f'.{alias}').exists())
        self.assertIsNone(self.recorded())
        self.assertEqual(self.zshrc(), 'deploy() { echo; }\n')

    def test_an_unknown_shell_gets_the_alias_line_to_add_by_hand(self):
        result = self.account('add', 'claude', 'work', shell='/usr/local/bin/fish')

        self.assertIn(ALIAS.strip(), result.stdout)
        self.assertEqual(sorted(p.name for p in self.home.iterdir() if p.name.endswith('rc')), [])

    def test_an_alias_that_is_not_plain_or_is_the_first_login_is_refused(self):
        for alias, folder in (('claude', '.other'), ('my.work', '.my.work')):
            result = self.account('add', 'claude', alias, '--dir', str(self.home / folder))

            self.assertEqual(result.returncode, 1, alias)
            self.assertFalse((self.home / folder).exists(), alias)
        self.assertIsNone(self.recorded())


class RemoveAndListTests(AccountCase):
    def test_remove_unlinks_the_shared_entries_and_keeps_the_folder_and_login(self):
        (self.home / '.zshrc').write_text('export EDITOR=vim\n')
        self.account('add', 'claude', 'work')
        (self.home / '.work/.claude.json').write_text('{"login": true}')

        result = self.account('remove', 'claude', 'work')

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.listdir(self.home / '.work'), ['.claude.json'])
        self.assertEqual(self.zshrc(), 'export EDITOR=vim\n')
        self.assertEqual(self.recorded(), [])
        self.assertIn('kept ~/.work with: .claude.json', result.stdout)

    def test_list_reports_a_broken_link_and_a_missing_alias(self):
        self.account('add', 'claude', 'work')
        self.assertIn('  work  ~/.work  links ok', self.account('list').stdout)
        (self.home / '.work/projects').unlink()
        (self.home / '.zshrc').write_text('')

        self.assertIn('  work  ~/.work  broken: projects, missing alias', self.account('list').stdout)


class SyncTests(AccountCase):
    def test_install_rewrites_a_full_path_account_link_relative_and_check_accepts_it(self):
        self.account('add', 'claude', 'work')
        projects = self.home / '.work/projects'
        projects.unlink()
        projects.symlink_to(self.home / '.claude/projects')  # how older setups wrote it
        (self.home / '.work/skills').unlink()

        result = install(self.hub, self.home)

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(os.readlink(projects), '../.claude/projects')
        self.assertEqual(os.readlink(self.home / '.work/skills'), '../.claude/skills')
        load(self.hub / 'check.py', 'agents_check').check_clients(self.home, self.hub)

    def test_an_account_link_pointing_elsewhere_is_an_install_conflict_and_fails_check(self):
        self.account('add', 'claude', 'work')
        install(self.hub, self.home)
        (self.home / '.work/projects').unlink()
        (self.home / '.work/projects').symlink_to(self.home)

        result = install(self.hub, self.home)

        self.assertEqual(result.returncode, 1)
        self.assertIn('.work/projects exists and is not a link to', result.stdout)
        self.assertEqual(os.readlink(self.home / '.work/projects'), str(self.home))
        with self.assertRaisesRegex(AssertionError, r'\.work/projects is not a link to'):
            load(self.hub / 'check.py', 'agents_check').check_clients(self.home, self.hub)

    def test_profiles_lists_only_this_clients_accounts_whose_folder_exists(self):
        (self.home / '.work').mkdir()
        (self.home / '.cx').mkdir()
        (self.hub / 'accounts.toml').write_text(
            '[[accounts]]\nclient = "claude"\nalias = "work"\ndir = "~/.work"\n'
            '[[accounts]]\nclient = "claude"\nalias = "gone"\ndir = "~/.gone"\n'
            '[[accounts]]\nclient = "codex"\nalias = "cx"\ndir = "~/.cx"\n')
        claude = tomllib.loads((self.hub / 'registry.toml').read_text())['clients'][0]

        self.assertEqual(registry.profiles(self.home, claude), (self.home / '.claude', [self.home / '.work']))


if __name__ == '__main__':
    unittest.main()
