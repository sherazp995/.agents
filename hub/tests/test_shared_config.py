"""install.py's local/ area (registry `local_shared`) and Codex shared settings (`shared_config`),
against a temporary home and hub (see test_install.py)."""
import json
import os
import tomllib
import unittest
from unittest import mock

from test_install import HubCase, install


class LocalSharedTests(HubCase):
    """registry `local_shared`: first-login config moves to the git-ignored hub local/ area."""

    def local(self, client, name):
        return self.hub / 'local' / client / name

    def test_real_entries_move_with_a_backup_hooks_write_through_and_a_second_run_changes_nothing(self):
        (self.home / '.claude/settings.json').write_text('{"theme": "dark"}')
        prompts = self.home / '.codex/prompts'
        (prompts / 'sub').mkdir(parents=True)
        (prompts / 'p.md').write_text('prompt')
        (self.home / 'notes').mkdir()
        (self.home / 'notes/n.md').write_text('note')
        (prompts / 'out.md').symlink_to('../../notes/n.md')  # relative, out of the folder
        (prompts / 'sub/in.md').symlink_to('../p.md')  # relative, inside the folder
        (prompts / 'abs.md').symlink_to(self.home / 'notes/n.md')

        first = install(self.hub, self.home, '--running-ok')
        hub_settings = json.loads(self.local('claude', 'settings.json').read_text())
        del hub_settings['hooks']  # the hooks step must restore it through the link
        self.local('claude', 'settings.json').write_text(json.dumps(hub_settings))
        second = install(self.hub, self.home, '--running-ok')
        third = install(self.hub, self.home, '--running-ok')

        self.assertEqual((first.returncode, second.returncode, third.returncode), (0, 0, 0), first.stdout)
        self.assertEqual(os.readlink(self.home / '.claude/settings.json'), '../.agents/local/claude/settings.json')
        self.assertEqual(os.readlink(prompts), '../.agents/local/codex/prompts')
        self.assertEqual(self.settings()['theme'], 'dark')
        self.assertIn('SessionStart', self.settings()['hooks'])
        self.assertEqual([(prompts / n).read_text() for n in ('p.md', 'out.md', 'sub/in.md', 'abs.md')],
                         ['prompt', 'note', 'prompt', 'note'])
        [backup] = (self.hub / 'backup').glob('local-shared-*')
        self.assertEqual((backup / 'codex/prompts/p.md').read_text(), 'prompt')
        self.assertIn('"theme"', (backup / 'claude/settings.json').read_text())
        self.assertIn('Changed: 0', third.stdout)
        self.check.check_clients(self.home, self.hub)

        (self.home / '.claude/settings.json').unlink()
        (self.home / '.claude/settings.json').write_text('{}')
        with self.assertRaisesRegex(AssertionError, 'settings.json should link to'):
            self.check.check_clients(self.home, self.hub)

    def test_a_hub_copy_is_linked_when_the_login_has_none_or_the_same(self):
        self.local('claude', 'settings.json').parent.mkdir(parents=True)
        self.local('claude', 'settings.json').write_text('{"theme": "light"}')
        (self.home / 'notes').mkdir()
        for rules in (self.local('codex', 'rules'), self.home / '.codex/rules'):
            rules.mkdir(parents=True)
            (rules / 'default.rules').write_text('allow')
            (rules / 'n.rules').symlink_to(os.path.relpath(self.home / 'notes', rules))  # same place, other text

        result = install(self.hub, self.home, '--running-ok')

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue((self.home / '.claude/settings.json').is_symlink())
        self.assertEqual(self.settings()['theme'], 'light')  # hooks wrote into the hub copy, no conflict
        self.assertEqual((self.home / '.codex/rules').resolve(), self.local('codex', 'rules'))

    def test_a_login_copy_that_differs_from_the_hub_copy_is_a_conflict_and_both_stay(self):
        self.local('codex', 'hooks.json').parent.mkdir(parents=True)
        self.local('codex', 'hooks.json').write_text('{"hooks": {}}')
        (self.home / '.codex/hooks.json').write_text('{"hooks": {"Stop": []}}')

        result = install(self.hub, self.home, '--running-ok')

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.count('hooks.json both exist and differ'), 1, result.stdout)
        self.assertFalse((self.home / '.codex/hooks.json').is_symlink())
        self.assertEqual(self.local('codex', 'hooks.json').read_text(), '{"hooks": {}}')

    def test_while_claude_or_codex_is_open_no_file_or_folder_moves_or_is_replaced(self):
        (self.home / '.claude/settings.json').write_text('{"theme": "dark"}')
        (self.home / '.codex/prompts').mkdir()
        (self.home / '.codex/prompts/p.md').write_text('prompt')
        for rules in (self.local('codex', 'rules'), self.home / '.codex/rules'):
            rules.mkdir(parents=True)
            (rules / 'default.rules').write_text('allow')  # same as the hub copy: a replace, not a move

        with mock.patch.object(self.module.memory, 'other_agents_running', return_value=[123]):
            self.installer.run()

        for name in ('.claude/settings.json', '.codex/prompts', '.codex/rules'):
            self.assertFalse((self.home / name).is_symlink(), name)
            self.assertEqual(sum(f'{name} into ~/.agents/local waits' in n for n in self.installer.notes), 1,
                             self.installer.notes)
        self.assertFalse((self.hub / 'backup').exists())

    def test_dry_run_reports_the_move_once_and_writes_nothing(self):
        (self.home / '.claude/settings.local.json').write_text('{}')

        result = install(self.hub, self.home, '--dry-run', '--running-ok')

        self.assertEqual(result.stdout.count('settings.local.json with a link'), 1, result.stdout)
        self.assertFalse((self.home / '.claude/settings.local.json').is_symlink())
        self.assertFalse((self.hub / 'local').exists())
        self.assertFalse((self.hub / 'backup').exists())

    def test_an_extra_account_reads_the_shared_file_and_loses_only_dangling_unshared_links(self):
        (self.hub / 'accounts.toml').write_text('[[accounts]]\nclient = "claude"\nalias = "c1"\ndir = "~/.claude1"\n')
        (self.home / '.claude/settings.json').write_text('{"theme": "dark"}')
        (self.home / '.claude1/todos').symlink_to('../.claude/todos')  # dropped from account_links, dangling
        (self.home / '.claude/kept').mkdir()
        (self.home / '.claude1/kept').symlink_to('../.claude/kept')  # not shared, but not dangling

        result = install(self.hub, self.home, '--running-ok')

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(os.readlink(self.home / '.claude1/settings.json'), '../.claude/settings.json')
        self.assertEqual(self.settings('.claude1')['theme'], 'dark')
        self.assertFalse((self.home / '.claude1/todos').is_symlink())
        self.assertTrue((self.home / '.claude1/kept').is_symlink())


class SharedConfigTests(HubCase):
    """registry `shared_config`: Codex keys from local/codex/config.shared.toml in every login."""

    PRIMARY = ('model = "m1"\n\n[projects."/a"]\ntrust_level = "trusted"\n\n'
               '[tui]\nscreen = true\n\n[tui.nux]\nx = 4\n\n'
               '[plugins."a@m"]\nenabled = true\n\n[plugins."b@m"]\nenabled = true\n')
    EXTRA = ('# my notes\nmodel = "old"\n\n[projects."/b"]\ntrust_level = "trusted"\n\n'
             '[tui.nux]\nx = 2\n\n[plugins."a@m"]\nenabled = true\n\n[plugins."mine@m"]\nenabled = false\n')

    def setUp(self):
        super().setUp()
        (self.home / '.codex1').mkdir()
        (self.hub / 'accounts.toml').write_text('[[accounts]]\nclient = "codex"\nalias = "x1"\ndir = "~/.codex1"\n')
        self.config('.codex').write_text(self.PRIMARY)
        self.config('.codex1').write_text(self.EXTRA)
        self.shared = self.hub / 'local/codex/config.shared.toml'

    def config(self, login):
        return self.home / login / 'config.toml'

    def check_shared(self):
        client = self.check.installed_clients(self.home, self.hub)['codex']
        self.check.check_local_shared(self.home, self.hub, 'codex', client, self.home / '.codex', [self.home / '.codex1'])

    def run_install(self, *extra):
        result = install(self.hub, self.home, *extra)
        return result, tomllib.loads(self.config('.codex1').read_text())

    ALIGNED = EXTRA.replace('model = "old"', 'model = "m1"').replace('[tui.nux]\nx = 2\n\n', '')

    def test_the_first_run_seeds_adds_missing_keys_and_leaves_differing_ones_as_conflicts(self):
        dry, _ = self.run_install('--dry-run')
        self.assertFalse(self.shared.exists())
        self.assertEqual(self.config('.codex1').read_text(), self.EXTRA)

        first, extra = self.run_install()
        resolved = self.config('.codex1').read_text().replace('"old"', '"m1"').replace('x = 2', 'x = 4')
        self.config('.codex1').write_text(resolved)
        second, _ = self.run_install()
        third, _ = self.run_install()

        self.assertEqual((dry.returncode, first.returncode, second.returncode, third.returncode), (1, 1, 0, 0))
        self.assertIn('add plugins."b@m"', dry.stdout)
        for conflict in ('model is "old" here but "m1"', 'tui.nux.x is 2 here but 4'):
            self.assertEqual(first.stdout.count(conflict), 1, first.stdout)
        self.assertEqual(tomllib.loads(self.shared.read_text()), {
            'model': 'm1', 'tui': {'nux': {'x': 4}}, 'plugins': {'a@m': {'enabled': True}, 'b@m': {'enabled': True}}})
        self.assertEqual(extra, {
            'model': 'old', 'projects': {'/b': {'trust_level': 'trusted'}}, 'tui': {'nux': {'x': 2}},
            'plugins': {'a@m': {'enabled': True}, 'mine@m': {'enabled': False}, 'b@m': {'enabled': True}}})
        self.assertTrue(self.config('.codex1').read_text().startswith('# my notes\n'))
        [backup] = (self.hub / 'backup').glob('local-shared-*/codex/.codex1-config.toml')
        self.assertEqual(backup.read_text(), self.EXTRA)  # backed up even when only adding
        self.assertEqual(self.config('.codex').read_text(), self.PRIMARY)
        self.assertEqual(self.config('.codex1').read_text(), resolved)
        self.assertIn('Changed: 0', third.stdout)
        self.check_shared()
        self.assertEqual(self.check.WARNINGS, [])

    def test_a_key_dropped_from_the_shared_file_is_removed_only_where_install_wrote_it(self):
        self.config('.codex1').write_text(self.ALIGNED)
        self.run_install()
        self.shared.write_text('model = "m1"\n')

        result, extra = self.run_install()

        self.assertEqual(result.returncode, 0, result.stdout)
        # x and b@m were added by install.py; model, a@m and mine@m were the login's own.
        self.assertEqual((extra['model'], extra['tui'].get('nux', {}), sorted(extra['plugins'])),
                         ('m1', {}, ['a@m', 'mine@m']))
        primary = tomllib.loads(self.config('.codex').read_text())
        self.assertEqual((primary['tui']['nux'], sorted(primary['plugins'])), ({'x': 4}, ['a@m', 'b@m']))

    def test_a_shared_change_reaches_unchanged_logins_with_a_backup_but_a_value_changed_in_a_login_is_a_conflict(self):
        self.config('.codex1').write_text(self.ALIGNED)
        self.run_install()
        edited = self.config('.codex1').read_text().replace('model = "m1"', 'model = "mine"')
        self.config('.codex1').write_text(edited)
        self.shared.write_text(self.shared.read_text().replace('"m1"', '"m2"'))

        result, _ = self.run_install()

        self.assertEqual(result.returncode, 1)
        self.assertIn('.codex1/config.toml: model was changed in this login (to "mine")', result.stdout)
        self.assertEqual(self.config('.codex1').read_text(), edited)
        self.assertEqual(tomllib.loads(self.config('.codex').read_text())['model'], 'm2')
        [backup] = (self.hub / 'backup').glob('local-shared-*/codex/.codex-config.toml')
        self.assertEqual(backup.read_text(), self.PRIMARY)
        self.check_shared()
        self.assertTrue(any('.codex1/config.toml' in w and 'model' in w for w in self.check.WARNINGS))

    def test_keys_codex_rewrites_itself_are_never_shared_compared_or_written(self):
        registry = self.hub / 'registry.toml'
        registry.write_text(registry.read_text().replace('"tui.nux"]', '"tui.nux", "marketplaces"]'))
        self.config('.codex').write_text(
            self.PRIMARY + '\n[marketplaces.m]\nlast_updated = "t1"\nsource = "s"\n\n[notice]\nhide = true\n')
        self.config('.codex1').write_text(self.ALIGNED + '\n[marketplaces.m]\nlast_updated = "t2"\nsource = "s"\n')
        first, _ = self.run_install()
        self.assertNotIn('last_updated', self.shared.read_text())
        self.config('.codex1').write_text(self.config('.codex1').read_text().replace('"t2"', '"t3"'))  # Codex refresh
        self.shared.write_text(self.shared.read_text().replace('"s"', '"s2"') + '\n[notice]\nhide = true\n')  # older file

        second, extra = self.run_install()

        self.assertEqual((first.returncode, second.returncode), (0, 0), first.stdout + second.stdout)
        self.assertEqual(extra['marketplaces'], {'m': {'last_updated': 't3', 'source': 's2'}})
        self.assertNotIn('notice', extra)
        primary = tomllib.loads(self.config('.codex').read_text())
        self.assertEqual((primary['marketplaces'], primary['notice']),
                         ({'m': {'last_updated': 't1', 'source': 's2'}}, {'hide': True}))
        self.check_shared()
        self.assertEqual(self.check.WARNINGS, [])

    def test_an_app_change_in_the_first_login_after_seeding_is_a_conflict_not_undone(self):
        self.run_install()
        picked = self.PRIMARY.replace('model = "m1"', 'model = "picked-in-app"')
        self.config('.codex').write_text(picked)  # what Codex's /model writes

        result, _ = self.run_install()

        self.assertEqual(result.returncode, 1)
        self.assertIn('.codex/config.toml: model was changed in this login (to "picked-in-app")', result.stdout)
        self.assertEqual(self.config('.codex').read_text(), picked)

    def test_unlisted_shared_keys_and_logins_it_cannot_edit_line_by_line_are_conflicts(self):
        self.shared.parent.mkdir(parents=True)
        self.shared.write_text('model = "m1"\n[projects."/c"]\ntrust_level = "trusted"\n')
        unlisted, _ = self.run_install()
        self.shared.write_text('model = "m1"\n[plugins."c@m"]\nenabled = true\n')
        inline = 'model = "m1"\nplugins = { "a@m" = { enabled = true } }\n'
        self.config('.codex1').write_text(inline)

        uneditable, _ = self.run_install()

        self.assertEqual((unlisted.returncode, uneditable.returncode), (1, 1))
        self.assertIn('does not list: projects."/c".trust_level', unlisted.stdout)
        self.assertIn('cannot merge plugins."c@m" line by line', uneditable.stdout)
        self.assertEqual(self.config('.codex1').read_text(), inline)


if __name__ == '__main__':
    unittest.main()
