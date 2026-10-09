"""install.py and check.py against a temporary home and a temporary copy of the hub.

Only tracked templates are read from the checkout; registry, prompts and machine
state (Ponytail, PATH, real home) never leak in.
"""
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest import mock

CHECKOUT = Path(__file__).resolve().parents[2]

REGISTRY = '''
[[clients]]
name = "claude"
detect = ["~/.claude"]
profiles = ["~/.claude"]
rules = "CLAUDE.md"
rules_mode = "link"
account_env = "CLAUDE_CONFIG_DIR"
account_command = "claude"
history = ["projects"]
account_links = ["agents", "CLAUDE.md", "projects", "settings.json", "skills"]
separate = []
{claude_hooks}

[[clients]]
name = "codex"
detect = ["~/.codex"]
profiles = ["~/.codex"]
rules = "AGENTS.md"
rules_mode = "link"
account_command = "codex"
separate = []
{codex_hooks}

[[clients]]
name = "cursor"
detect = ["~/.cursor"]
profiles = ["~/.cursor"]
rules = "rules/global.mdc"
rules_mode = "render"
separate = []

[[clients]]
name = "aider"
detect = ["~/.aider.conf.yml"]
profiles = ["~"]
rules = ".aider.conf.yml"
rules_mode = "merge"
separate = []
'''


def make_hub(home, claude_hooks='', codex_hooks=''):
    """A copy of the tracked hub files at home/.agents, with a test registry."""
    hub = home / '.agents'
    hub.mkdir()
    for name in ('install.py', 'check.py', 'AGENTS.md', 'selected-skills.json', 'ponytail.json'):
        shutil.copy(CHECKOUT / name, hub / name)
    for folder in ('integrations', 'agents', 'commands'):
        shutil.copytree(CHECKOUT / folder, hub / folder)
    (hub / 'hub').mkdir()
    shutil.copy(CHECKOUT / 'hub/agents-hub', hub / 'hub/agents-hub')
    shutil.copytree(CHECKOUT / 'hub/agents_hub', hub / 'hub/agents_hub',
                    ignore=shutil.ignore_patterns('__pycache__'))
    for skill in json.loads((hub / 'selected-skills.json').read_text())['skills']:
        (hub / 'skills' / skill).mkdir(parents=True)
    (hub / 'registry.toml').write_text(REGISTRY.format(claude_hooks=claude_hooks, codex_hooks=codex_hooks))
    return hub


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def install(hub, home, *extra):
    # A bare PATH: no client is detected through a command this machine happens to have.
    return subprocess.run([sys.executable, str(hub / 'install.py'), '--home', str(home), *extra],
                          capture_output=True, text=True, env={**os.environ, 'PATH': '/usr/bin:/bin'})


class HubCase(unittest.TestCase):
    hooks = {}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        for folder in ('.claude', '.claude1', '.codex', '.cursor/rules'):
            (self.home / folder).mkdir(parents=True)
        self.hub = make_hub(self.home, **self.hooks)
        self.module = load(self.hub / 'install.py', 'agents_install')
        self.check = load(self.hub / 'check.py', 'agents_check')
        self.installer = self.module.Installer(self.home, dry_run=False, host=False)
        self.check.WARNINGS.clear()

    def tearDown(self):
        self.tmp.cleanup()

    def settings(self, profile='.claude', name='settings.json'):
        return json.loads((self.home / profile / name).read_text())


class InstallTests(HubCase):
    def test_first_run_wires_everything_and_a_second_run_changes_nothing(self):
        first = install(self.hub, self.home)
        second = install(self.hub, self.home)

        self.assertEqual((first.returncode, second.returncode), (0, 0), first.stdout)
        self.assertIn('Ponytail is not installed yet', first.stdout)
        self.assertEqual((self.home / '.claude/CLAUDE.md').resolve(), self.hub / 'AGENTS.md')
        self.assertEqual((self.home / '.claude/agents').resolve(), self.hub / 'agents')
        self.assertEqual((self.home / '.claude/commands/general-review.md').resolve(),
                         self.hub / 'commands/general-review.md')
        codex_agent = tomllib.loads((self.home / '.codex/agents/principal-backend-engineer.toml').read_text())
        self.assertEqual(codex_agent['name'], 'principal-backend-engineer')
        hooks = self.settings()['hooks']['SessionStart']
        self.assertEqual([h['command'] for g in hooks for h in g['hooks']],
                         [f'{self.hub}/hub/agents-hub memory provision'])
        self.assertIn('Changed: 0', second.stdout)
        self.check.check_clients(self.home, self.hub)  # check.py accepts what install.py wrote

    def test_links_are_relative_and_old_full_path_links_are_rewritten_in_place(self):
        install(self.hub, self.home)
        rules = self.home / '.claude/CLAUDE.md'
        rules.unlink()
        rules.symlink_to(self.hub / 'AGENTS.md')  # an older install wrote full paths

        install(self.hub, self.home)

        for link, target in ((rules, 'AGENTS.md'), (self.home / '.codex/skills', 'skills')):
            self.assertFalse(os.path.isabs(os.readlink(link)), link)
            self.assertEqual(link.resolve(), (self.hub / target).resolve())

    def test_dry_run_changes_nothing(self):
        result = install(self.hub, self.home, '--dry-run')

        self.assertIn('Would change:', result.stdout)
        self.assertFalse((self.home / '.claude/CLAUDE.md').exists())

    def test_real_files_in_the_way_are_reported_and_kept(self):
        (self.home / '.claude/CLAUDE.md').write_text('my own rules')
        (self.home / '.claude/agents').mkdir()
        (self.home / '.claude/commands').mkdir()
        (self.home / '.claude/commands/general-review.md').write_text('mine')

        result = install(self.hub, self.home)

        self.assertEqual(result.returncode, 1)
        for path in ('.claude/CLAUDE.md exists and is not a link', '.claude/agents exists and is not a link',
                     'general-review.md exists and is not a link'):
            self.assertIn(path, result.stdout)
        self.assertEqual((self.home / '.claude/CLAUDE.md').read_text(), 'my own rules')
        self.assertFalse((self.home / '.claude/agents').is_symlink())

    def test_an_old_symlinked_cursor_rule_is_replaced_without_touching_the_template(self):
        template = self.hub / 'integrations/cursor.mdc'
        before = template.read_text()
        (self.home / '.cursor/rules/global.mdc').symlink_to(template)

        install(self.hub, self.home)

        rule = self.home / '.cursor/rules/global.mdc'
        self.assertFalse(rule.is_symlink())
        self.assertEqual(template.read_text(), before)


class OwnershipTests(HubCase):
    def test_a_file_without_the_marker_is_never_replaced(self):
        custom = self.home / 'unit.timer'
        custom.write_text('my own timer')

        written = self.installer.write_owned(custom, f'# {self.module.MARKER}\nnew')

        self.assertFalse(written)
        self.assertEqual(custom.read_text(), 'my own timer')
        self.assertTrue(self.installer.conflicts)

    def test_a_link_to_someone_elses_file_is_never_replaced(self):
        theirs = self.home / 'their-rule.mdc'
        theirs.write_text('theirs')
        rule = self.home / 'global.mdc'
        rule.symlink_to(theirs)

        self.assertFalse(self.installer.write_owned(rule, 'ours', replaceable_link=self.home / 'template.mdc'))
        self.assertTrue(rule.is_symlink())
        self.assertEqual(theirs.read_text(), 'theirs')

    def test_a_file_with_the_marker_is_updated(self):
        owned = self.home / 'unit.timer'
        owned.write_text(f'# {self.module.MARKER}\nold')

        self.assertTrue(self.installer.write_owned(owned, f'# {self.module.MARKER}\nnew'))
        self.assertIn('new', owned.read_text())

    def test_only_the_hubs_own_provision_hook_is_replaced_atomically_through_a_link(self):
        real = self.home / 'dotfiles/settings.json'
        real.parent.mkdir()
        foreign = {'type': 'command', 'command': '/usr/local/bin/custom-tool memory provision --audit'}
        wrapped = {'type': 'command', 'command': '/usr/local/bin/audit-wrapper /x/agents-hub memory provision'}
        lookalike = {'type': 'command', 'command': '/usr/local/bin/custom-agents-hub memory provision'}
        old = {'type': 'command', 'command': '/old/python3.12 /x/.agents/hub/agents-hub memory provision'}
        real.write_text(json.dumps({'hooks': {'SessionStart': [{'hooks': [foreign, wrapped, lookalike, old]}]}}))
        (self.home / '.claude/settings.json').symlink_to(real)
        inode = real.stat().st_ino

        self.installer.run()

        self.assertTrue((self.home / '.claude/settings.json').is_symlink())
        self.assertNotEqual(real.stat().st_ino, inode)  # a new file renamed into place, not rewritten
        commands = [h['command'] for g in self.settings()['hooks']['SessionStart'] for h in g['hooks']]
        self.assertEqual(commands, [foreign['command'], wrapped['command'], lookalike['command'],
                                    f'{self.hub}/hub/agents-hub memory provision'])

    def test_codex_agents_replace_only_marked_or_equivalent_files_and_drop_stale_ones(self):
        folder = self.home / '.codex/agents'
        folder.mkdir()
        source = self.hub / 'agents/principal-rust-engineer.md'
        equivalent = self.module.wiring.codex_agent(source).split('\n', 1)[1]  # same content, no marker
        (folder / 'principal-rust-engineer.toml').write_text(equivalent)
        (folder / 'principal-rails-engineer.toml').write_text('name = "hand edited"\n')
        (folder / 'retired.toml').write_text(f'# {self.module.MARKER}\nname = "retired"\n')
        (folder / 'personal.toml').write_text('name = "personal"\n')

        self.installer.codex_agents(folder)

        self.assertIn(self.module.MARKER, (folder / 'principal-rust-engineer.toml').read_text())
        self.assertEqual((folder / 'principal-rails-engineer.toml').read_text(), 'name = "hand edited"\n')
        self.assertEqual(len(self.installer.conflicts), 1, self.installer.conflicts)
        self.assertFalse((folder / 'retired.toml').exists())
        self.assertTrue((folder / 'personal.toml').exists())

    def test_agent_text_survives_toml_escaping(self):
        tricky = 'quote " backslash \\ triple """ tab\t del\x7f bell\x07 emoji 🤖 \'single\''
        agent = self.hub / 'agents/tricky.md'
        agent.write_text(f'---\nname: tricky\ndescription: "says \\"hi\\": now"\n---\n\n{tricky}\n')

        parsed = tomllib.loads(self.module.wiring.codex_agent(agent))

        self.assertEqual((parsed['description'], parsed['developer_instructions']), ('says "hi": now', tricky))


class MergeCheckTests(HubCase):
    def test_the_rules_path_counts_only_inside_the_parsed_list(self):
        wiring = self.module.wiring
        agents_md = self.hub / 'AGENTS.md'
        aider, cont = self.home / '.aider.conf.yml', self.home / 'config.yaml'
        aider.write_text(f'# read: [{agents_md}]\nread: [other.md]\n')
        cont.write_text(f'name: x\n# {agents_md}\nrules:\n  - name: Shared agent rules\n    rule: Read {agents_md}.\n')

        self.assertFalse(wiring.merged_reference('aider', aider, agents_md))
        self.assertTrue(wiring.merged_reference('continue', cont, agents_md))
        with mock.patch.dict(sys.modules, {'yaml': None}):
            self.assertIsNone(wiring.merged_reference('aider', aider, agents_md))

    def test_a_cursor_rule_needs_the_marker_and_the_reference_line(self):
        template = self.hub / 'integrations/cursor.mdc'
        rule = self.home / 'global.mdc'
        rendered = self.module.wiring.render(template, self.hub / 'AGENTS.md')
        rule.write_text(rendered.replace(self.module.MARKER, 'hand written'))

        self.assertFalse(self.module.wiring.rendered_reference(rule, template, self.hub / 'AGENTS.md'))
        rule.write_text(rendered)
        self.assertTrue(self.module.wiring.rendered_reference(rule, template, self.hub / 'AGENTS.md'))


class HookTests(HubCase):
    hooks = {'claude_hooks': 'hooks = [{ name = "completion-check", event = "Stop", kind = "prompt", matcher = "" },'
                             ' { name = "guard", event = "PreToolUse", kind = "command", matcher = "Bash",'
                             ' fail_closed = true }]',
             'codex_hooks': 'hooks = [{ name = "completion-check", event = "Stop", kind = "command", matcher = "" }]'}

    def setUp(self):
        super().setUp()
        prompts = self.hub / 'hooks/prompts'
        prompts.mkdir(parents=True)
        (prompts / 'completion-check.md').write_text('status: Checking...\nmodel: claude-sonnet-5\n\nCheck the turn.\n')
        legacy = {'type': 'agent', 'prompt': 'Intro.\n\nYou are a READ-ONLY completion checker for the turn.'}
        self.foreign = {'type': 'command', 'command': 'say done'}
        stale = {'type': 'command', 'command': f'{self.hub}/hooks/adapters/run.py claude retired'}
        (self.home / '.claude/settings.json').write_text(json.dumps(
            {'model': 'x', 'hooks': {'Stop': [{'hooks': [legacy, self.foreign, stale]}]}}))

    def test_owned_hooks_are_written_legacy_and_stale_ones_replaced_and_others_kept(self):
        self.installer.run()

        stop = [h for g in self.settings()['hooks']['Stop'] for h in g['hooks']]
        self.assertEqual(stop, [self.foreign, {
            'type': 'agent', 'prompt': '<!-- agents-hub hook: completion-check -->\nCheck the turn.\n',
            'timeout': 240, 'model': 'claude-sonnet-5', 'statusMessage': 'Checking...'}])
        self.assertEqual(self.settings()['hooks']['PreToolUse'], [{'matcher': 'Bash', 'hooks': [
            {'type': 'command', 'command': f'{self.hub}/hooks/adapters/run.py claude guard --fail-closed'}]}])
        self.assertEqual(self.settings('.codex', 'hooks.json')['hooks']['Stop'][0]['hooks'][0]['command'],
                         f'{self.hub}/hooks/adapters/run.py codex completion-check')
        self.assertTrue(any('replaced the previous unmarked completion-check' in c for c in self.installer.changes))
        self.assertTrue(any('removed hook retired' in c for c in self.installer.changes))
        self.assertTrue(any('left alone Stop command hook' in n and 'say done' in n for n in self.installer.notes))
        rerun = self.module.Installer(self.home, dry_run=False, host=False)
        rerun.run()
        self.assertEqual(rerun.changes, [])
        self.check.check_clients(self.home, self.hub)

    def test_check_rejects_a_hook_under_the_wrong_matcher(self):
        self.installer.run()
        settings = self.settings()
        settings['hooks']['PreToolUse'][0]['matcher'] = 'Edit'
        (self.home / '.claude/settings.json').write_text(json.dumps(settings))

        with self.assertRaisesRegex(AssertionError, 'does not run hook guard on PreToolUse/Bash'):
            self.check.check_clients(self.home, self.hub)


class SchedulerTests(HubCase):
    def setUp(self):
        super().setUp()
        self.installer = self.module.Installer(self.home, dry_run=False, host=True)

    def test_launchd_runs_the_launcher_with_a_path_and_creates_its_log_folder(self):
        with mock.patch.object(self.module.platform, 'system', return_value='Darwin'), \
                mock.patch.object(self.module.subprocess, 'run', return_value=mock.Mock(returncode=0)):
            self.installer.scheduler()

        plist = (self.home / 'Library/LaunchAgents/agents-hub.index.plist').read_text()
        self.assertIn(f'<array>\n    <string>{self.hub}/hub/agents-hub</string>\n    <string>scheduled</string>\n',
                      plist)
        self.assertIn(f'<key>PATH</key>\n    <string>{self.home}/.local/bin:/opt/homebrew/bin:', plist)
        self.assertTrue((self.hub / 'chats').is_dir())

    def test_linux_without_systemctl_falls_back_to_cron_with_a_path(self):
        which = lambda name: None if name == 'systemctl' else f'/usr/bin/{name}'
        run = mock.Mock(return_value=mock.Mock(returncode=1, stdout=''))
        with mock.patch.object(self.module.platform, 'system', return_value='Linux'), \
                mock.patch.object(self.module.shutil, 'which', side_effect=which), \
                mock.patch.object(self.module.subprocess, 'run', run):
            self.installer.scheduler()

        line = run.call_args.kwargs['input']
        self.assertIn(f'PATH={self.home}/.local/bin:', line)
        self.assertIn(f'{self.hub}/hub/agents-hub scheduled # agents-hub scheduled job', line)

    def test_a_stopped_timer_with_unchanged_files_is_started_again(self):
        units = self.home / '.config/systemd/user'
        argv = ['agents-hub', 'scheduled']
        with mock.patch.object(self.module.subprocess, 'run', return_value=mock.Mock(returncode=0)):
            self.installer.systemd(argv)  # writes the unit files
        self.installer.changes.clear()
        with mock.patch.object(self.module.subprocess, 'run', return_value=mock.Mock(returncode=3)):
            self.installer.systemd(argv)

        self.assertIn('Environment="PATH=', (units / 'agents-hub.index.service').read_text())
        self.assertEqual(len(self.installer.changes), 1, self.installer.changes)

    def test_dry_run_creates_no_folders(self):
        dry = self.module.Installer(self.home, dry_run=True, host=True)
        with mock.patch.object(self.module.platform, 'system', return_value='Darwin'), \
                mock.patch.object(self.module.shutil, 'which', return_value='/usr/bin/tmutil'), \
                mock.patch.object(self.module.subprocess, 'run', return_value=mock.Mock(stdout='', returncode=1)):
            dry.scheduler()
            dry.backup_exclusions()

        self.assertFalse((self.hub / 'chats').exists())
        self.assertFalse((self.home / 'Library').exists())


class CheckTests(HubCase):
    def record(self, **fields):
        (self.hub / 'chats').mkdir(exist_ok=True)
        now = datetime.now(timezone.utc).isoformat()
        (self.hub / 'chats/scheduled.json').write_text(json.dumps({'attempted_at': now, 'error': None, **fields}))

    def test_one_busy_run_warns_but_stale_success_or_doctor_problems_fail(self):
        old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        self.record(busy=True, succeeded_at=None)
        self.check.check_schedule(self.hub)
        self.assertTrue(any('busy' in w for w in self.check.WARNINGS))

        self.record(busy=True, succeeded_at=old)
        with self.assertRaisesRegex(AssertionError, 'No complete scheduled run'):
            self.check.check_schedule(self.hub)
        self.record(succeeded_at=datetime.now(timezone.utc).isoformat(), doctor_problems=['dangling link: x'])
        with self.assertRaisesRegex(AssertionError, 'dangling link: x'):
            self.check.check_schedule(self.hub)

    def test_a_memory_link_to_another_projects_scope_fails(self):
        repo = self.home / 'repo'
        repo.mkdir()
        folder = self.home / '.claude/projects' / re.sub(r'[^A-Za-z0-9]', '-', str(repo))
        folder.mkdir(parents=True)
        (folder / 's.jsonl').write_text(json.dumps({'cwd': str(repo)}) + '\n')
        (self.hub / 'memory/scopes/-elsewhere').mkdir(parents=True)
        (folder / 'memory').symlink_to(self.hub / 'memory/scopes/-elsewhere')

        with self.assertRaisesRegex(AssertionError, 'but its project resolves to'):
            self.check.check_memory_links(self.home, self.hub)

    def test_a_memory_link_of_a_deleted_project_is_not_a_mismatch(self):
        repo = self.home / 'gone-repo'
        folder = self.home / '.claude/projects' / re.sub(r'[^A-Za-z0-9]', '-', str(repo))
        folder.mkdir(parents=True)
        (folder / 's.jsonl').write_text(json.dumps({'cwd': str(repo)}) + '\n')
        (self.hub / 'memory/scopes/-elsewhere').mkdir(parents=True)
        (folder / 'memory').symlink_to(self.hub / 'memory/scopes/-elsewhere')

        self.check.check_memory_links(self.home, self.hub)

    def test_install_rewrites_old_full_path_scope_owners_with_a_tilde(self):
        for name, owner in (('-repo', f'{self.home}/repo'), ('-tmp', '/tmp')):
            (self.hub / 'memory/scopes' / name).mkdir(parents=True)
            (self.hub / 'memory/scopes' / name / '.path').write_text(owner + '\n')

        first = install(self.hub, self.home)
        second = install(self.hub, self.home)

        self.assertEqual((self.hub / 'memory/scopes/-repo/.path').read_text(), '~/repo\n')
        self.assertEqual((self.hub / 'memory/scopes/-tmp/.path').read_text(), '/tmp\n')
        self.assertEqual((first.returncode, second.returncode), (0, 0), first.stdout)
        self.assertIn('Changed: 0', second.stdout)

    def test_a_codex_doc_limit_below_agents_md_fails(self):
        install(self.hub, self.home)
        (self.home / '.codex/config.toml').write_text('project_doc_max_bytes = 10\n[x]\nproject_doc_max_bytes = 1_000_000\n')

        with self.assertRaisesRegex(AssertionError, r'project_doc_max_bytes \(10\)'):
            self.check.check_clients(self.home, self.hub)


class HistoryTests(HubCase):
    def claude_project(self, memory_target=None):
        """~/.claude/projects/-p with a transcript and a memory link (relative unless memory_target)."""
        folder = self.home / '.claude/projects/-p'
        folder.mkdir(parents=True)
        (folder / 's.jsonl').write_text('{"cwd": "/p"}\n')
        scope = self.hub / 'memory/scopes/-p'
        scope.mkdir(parents=True)
        (folder / 'memory').symlink_to(memory_target or os.path.relpath(scope, folder))
        return folder

    def test_chat_history_moves_into_the_hub_and_the_app_keeps_a_relative_link(self):
        self.claude_project()

        first = install(self.hub, self.home, '--running-ok')
        second = install(self.hub, self.home, '--running-ok')

        projects = self.home / '.claude/projects'
        self.assertEqual((first.returncode, second.returncode), (0, 0), first.stdout + first.stderr)
        self.assertEqual(os.readlink(projects), '../.agents/history/claude/projects')
        self.assertEqual((projects / '-p/s.jsonl').read_text(), '{"cwd": "/p"}\n')
        self.assertEqual((projects / '-p/memory').resolve(), self.hub / 'memory/scopes/-p')
        self.assertIn('Changed: 0', second.stdout)
        self.check.check_clients(self.home, self.hub)

    def test_nothing_moves_while_claude_or_codex_is_open(self):
        folder = self.home / '.claude/projects/-p/memory'
        folder.mkdir(parents=True)
        installer = self.module.Installer(self.home, dry_run=False, host=False)

        with mock.patch.object(self.module.memory, 'other_agents_running', return_value=[123]):
            installer.run()

        self.assertFalse((self.home / '.claude/projects').is_symlink())
        self.assertFalse(folder.is_symlink())
        self.assertEqual(sum('close Claude and Codex' in n for n in installer.notes), 2, installer.notes)

    def test_history_already_in_the_hub_is_a_conflict_and_nothing_moves(self):
        self.claude_project()
        (self.hub / 'history/claude/projects').mkdir(parents=True)
        (self.hub / 'history/claude/projects/other.jsonl').write_text('x')

        result = install(self.hub, self.home, '--running-ok')

        self.assertEqual(result.returncode, 1)
        self.assertIn('already has files', result.stdout)
        self.assertFalse((self.home / '.claude/projects').is_symlink())

    def test_a_history_link_to_the_wrong_place_fails_the_check(self):
        install(self.hub, self.home)
        (self.home / 'elsewhere').mkdir()
        (self.home / '.claude/projects').symlink_to(self.home / 'elsewhere')

        with self.assertRaisesRegex(AssertionError, 'links somewhere else'):
            self.check.check_clients(self.home, self.hub)

    def test_a_failed_move_is_a_conflict_and_the_rest_of_the_install_still_runs(self):
        self.claude_project()
        installer = self.module.Installer(self.home, dry_run=False, host=False, running_ok=True)

        with mock.patch.object(self.module.relocate.os, 'rename', side_effect=OSError(18, 'Cross-device link')):
            installer.run()

        self.assertTrue(any('same disk' in c for c in installer.conflicts), installer.conflicts)
        self.assertFalse((self.home / '.claude/projects').is_symlink())
        self.assertEqual((self.home / '.claude/CLAUDE.md').resolve(), self.hub / 'AGENTS.md')

    def test_history_on_another_disk_is_a_conflict_before_anything_moves(self):
        self.claude_project()
        installer = self.module.Installer(self.home, dry_run=True, host=False, running_ok=True)

        with mock.patch.object(self.module.relocate, 'same_disk', return_value=False):
            installer.run()

        self.assertTrue(any('another disk' in c for c in installer.conflicts), installer.conflicts)
        self.assertFalse(any('move ' in c for c in installer.changes))

    def test_a_full_path_memory_link_spelled_through_a_symlink_becomes_relative(self):
        (self.home / 'hub-link').symlink_to(self.hub)
        folder = self.claude_project(memory_target=self.home / 'hub-link/memory/scopes/-p')

        install(self.hub, self.home, '--running-ok')

        self.assertFalse(os.path.isabs(os.readlink(folder / 'memory')))
        self.assertEqual((folder / 'memory').resolve(), self.hub / 'memory/scopes/-p')

    def test_a_move_stopped_halfway_fails_the_check(self):
        install(self.hub, self.home)
        self.claude_project()
        (self.hub / 'history/claude').mkdir(parents=True)
        os.rename(self.home / '.claude/projects', self.hub / 'history/claude/projects')

        with self.assertRaisesRegex(AssertionError, 'stopped halfway'):
            self.check.check_clients(self.home, self.hub)

    def test_an_account_added_after_the_history_move_links_through_the_first_login(self):
        self.claude_project()
        install(self.hub, self.home, '--running-ok')
        env = {**os.environ, 'AGENTS_HUB_HOME': str(self.home), 'SHELL': '/bin/zsh'}
        added = subprocess.run([str(self.hub / 'hub/agents-hub'), 'account', 'add', 'claude', 'work'],
                               capture_output=True, text=True, env=env)
        again = install(self.hub, self.home, '--running-ok')

        self.assertEqual(added.returncode, 0, added.stderr)
        self.assertEqual(os.readlink(self.home / '.work/projects'), '../.claude/projects')
        self.assertEqual(os.readlink(self.home / '.work/CLAUDE.md'), '../.claude/CLAUDE.md')
        self.assertEqual((self.home / '.work/projects/-p/s.jsonl').read_text(), '{"cwd": "/p"}\n')
        self.assertIn('Changed: 0', again.stdout)

    def test_a_looping_history_link_is_a_conflict_not_a_crash(self):
        projects = self.home / '.claude/projects'
        projects.symlink_to('projects')

        result = install(self.hub, self.home, '--dry-run')

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('links somewhere else', result.stdout)

    def test_a_failed_memory_move_is_a_conflict_and_the_rest_of_the_install_still_runs(self):
        (self.home / '.claude/projects/-q/memory').mkdir(parents=True)
        installer = self.module.Installer(self.home, dry_run=False, host=False, running_ok=True)

        with mock.patch.object(self.module.memory.os, 'rename', side_effect=OSError(18, 'Cross-device link')):
            installer.run()

        self.assertTrue(any('moving Claude memory failed' in c for c in installer.conflicts), installer.conflicts)
        self.assertEqual((self.home / '.claude/CLAUDE.md').resolve(), self.hub / 'AGENTS.md')

    def test_memory_on_another_disk_is_a_conflict_before_anything_moves(self):
        (self.home / '.claude/projects/-q/memory').mkdir(parents=True)
        installer = self.module.Installer(self.home, dry_run=True, host=False, running_ok=True)

        with mock.patch.object(self.module.relocate, 'same_disk', return_value=False):
            installer.run()

        self.assertTrue(any('Claude memory folders are on another disk' in c for c in installer.conflicts))

    def test_real_memory_folders_are_adopted_and_full_path_links_become_relative(self):
        old = self.claude_project(memory_target=self.hub / 'memory/scopes/-p')
        fresh = self.home / '.claude/projects/-q/memory'
        fresh.mkdir(parents=True)
        (fresh / 'a.md').write_text('fact')

        result = install(self.hub, self.home, '--running-ok')

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(os.path.isabs(os.readlink(old / 'memory')))
        self.assertEqual((old / 'memory').resolve(), self.hub / 'memory/scopes/-p')
        self.assertFalse(os.path.isabs(os.readlink(fresh)))
        self.assertEqual((self.hub / 'memory/scopes/-q/a.md').read_text(), 'fact')


if __name__ == '__main__':
    unittest.main()
