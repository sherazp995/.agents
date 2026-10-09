"""Check that this machine's agents use ~/.agents for rules, skills, agents, Ponytail, memory, chats and hooks.

Every section runs even when an earlier one fails, and all failures are listed.
Clients that are not installed (see registry.toml) are skipped. Run
`python3 ~/.agents/install.py` first on a new machine.
"""
import argparse
from datetime import datetime, timezone
import filecmp
import json
import os
from pathlib import Path
import platform
import re
import sqlite3
import subprocess
import sys
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent / 'hub'))

from agents_hub import interpreter  # noqa: E402

interpreter.ensure(str(Path(__file__).resolve()))

from agents_hub import accounts, memory, registry, relocate, wiring  # noqa: E402
from agents_hub.paths import Paths  # noqa: E402

IGNORED = ['.DS_Store', '.git']
HOOK_CONFIG = {'claude': 'settings.json', 'codex': 'hooks.json'}
SCHEDULE_LATE_HOURS = 2      # warn: the machine may just have been asleep
SCHEDULE_DEAD_HOURS = 24     # fail: the scheduled job is not running
WARNINGS = []


def same_tree(left, right):
    # Codex copies a local plugin into its cache instead of linking it.
    diff = filecmp.dircmp(left, right, ignore=IGNORED)
    if diff.left_only or diff.right_only or diff.funny_files:
        return False
    _, mismatch, errors = filecmp.cmpfiles(left, right, diff.common_files, shallow=False)
    if mismatch or errors:
        return False
    return all(same_tree(left / name, right / name) for name in diff.common_dirs)


def installed_clients(home, hub):
    return {c['name']: c for c in registry.load(hub)['clients'] if registry.installed(home, c)}


def check(home):
    home = home.resolve()
    hub = home / '.agents'
    sections = (('skills and rules', check_skills_and_rules), ('clients', check_clients),
                ('ponytail', check_ponytail), ('hub', check_hub))
    passed, failures = [], []
    for name, section in sections:
        try:
            passed.append(section(home, hub))
        except (AssertionError, OSError, KeyError, ValueError, sqlite3.Error, wiring.WiringError) as error:
            failures.append(f'{name}: {error or type(error).__name__}')
    for warning in WARNINGS:
        print(f'WARN: {warning}')
    if failures:
        print('FAIL:\n' + '\n'.join(f'  - {failure}' for failure in failures))
        sys.exit(1)
    print('PASS: ' + '; '.join(passed) + '.')


def check_skills_and_rules(home, hub):
    data = json.loads((hub / 'selected-skills.json').read_text())
    shared = hub / 'skills'
    # App-owned folders: Claude syncs organization skills, Codex rewrites its system skills,
    # and update-ponytail.sh owns the ponytail* links.
    authored = {p.name for p in shared.iterdir()
                if not p.name.startswith('.') and p.name != 'synced' and not p.name.startswith('ponytail')}
    assert set(data['skills']) <= authored, f'Selected skills missing: {sorted(set(data["skills"]) - authored)}'
    if authored - set(data['skills']):
        WARNINGS.append(f'skills not listed in selected-skills.json: {sorted(authored - set(data["skills"]))}')
    roots = [home / root for root in data['roots'] if (home / root).parent.is_dir()]
    for path in roots:
        assert path.is_symlink() and path.resolve(strict=True) == shared, f'Separate skill directory: {path}'
    agents_md = (hub / 'AGENTS.md').read_text()
    assert not re.search(r'\]\((?!~/|/|https?:)', agents_md), 'AGENTS.md has a relative link; it breaks through symlinks'
    assert re.search(r'\]\((/|~/)[^)]*AGENTS-CONFIG\.md\)', agents_md), 'AGENTS.md does not link AGENTS-CONFIG.md'
    return f'{len(authored)} shared personal skills in {len(roots)} skill folders'


def loads_rules(hub, client, rules):
    """True, False, or None when the config is YAML and PyYAML is missing."""
    agents_md = hub / 'AGENTS.md'
    mode = client['rules_mode']
    if mode == 'link':
        return rules.is_symlink() and rules.resolve(strict=True) == agents_md.resolve()
    if mode == 'render':
        return wiring.rendered_reference(rules, hub / 'integrations' / f"{client['name']}.mdc", agents_md)
    return wiring.merged_reference(client['name'], rules, agents_md)


def check_hooks(hub, name, client, config_file):
    """Each registry hook is in the config once, under its event and matcher, exactly as install.py writes it."""
    config = json.loads(config_file.read_text()) if config_file.exists() else {}
    entries = wiring.hook_entries(config)
    for entry in client.get('hooks', []):
        event, matcher, wanted = wiring.desired_hook(hub, name, entry)
        owned = [(e, m, h) for e, m, h in entries if wiring.hook_owner(h, hub, name) == entry['name']]
        assert owned == [(event, matcher, wanted)], \
            f"{name}: {config_file} does not run hook {entry['name']} on {event}/{matcher or '(any)'} " \
            f"as install.py writes it ({len(owned)} owned entries found); run install.py"
    return entries


def check_agents(hub, name, primary, extras):
    """Claude links the shared agents and commands; Codex has a generated .toml for every agent."""
    if name == 'claude':
        folder = primary / 'agents'
        assert folder.is_symlink() and folder.resolve(strict=True) == (hub / 'agents').resolve(), \
            f'{folder} is not a link to {hub / "agents"}; run install.py'
        for command in sorted((hub / 'commands').glob('*.md')):
            link = primary / 'commands' / command.name
            assert link.is_symlink() and link.resolve(strict=True) == command.resolve(), \
                f'{link} is not a link to {command}; run install.py'
    elif name == 'codex':
        for source in sorted((hub / 'agents').glob('*.md')):
            generated = primary / 'agents' / f'{source.stem}.toml'
            assert generated.is_file(), f'{generated} is missing; run install.py'
            text = generated.read_text()
            assert wiring.MARKER in text and wiring.same_toml(text, wiring.codex_agent(source)), \
                f'{generated} does not match {source}; run install.py'
    else:
        return
    for extra in extras:
        assert (extra / 'agents').resolve() == (primary / 'agents').resolve(), \
            f'{name}: {extra / "agents"} is not shared with {primary}'


def check_clients(home, hub):
    """Every installed client and profile is wired the way registry.toml says."""
    agents_md = hub / 'AGENTS.md'
    clients = installed_clients(home, hub)
    for name, client in clients.items():
        primary, extras = registry.profiles(home, client)
        for profile in [primary] + extras:
            rules = profile / client['rules']
            loaded = loads_rules(hub, client, rules)
            if loaded is None:
                WARNINGS.append(f'{name}: PyYAML is not installed, so {rules} was not checked')
            else:
                assert loaded, f'{name}: {rules} does not load {agents_md}'
            for private in client['separate']:
                path = registry.expand(home, private) if private.startswith('~') else profile / private
                assert not path.is_symlink(), f'{name}: {path} must stay separate per profile'
            if name in HOOK_CONFIG:
                check_hooks(hub, name, client, profile / HOOK_CONFIG[name])
        for extra in extras:
            for path, target, state in accounts.plan(primary, extra, client):
                assert state in ('ok', 'full'), f'{name}: {path} is not a link to {target}; run install.py'
                if state == 'full':
                    WARNINGS.append(f'{path} links to {target} with a full path; run install.py to make it relative')
        if client.get('memory_folder'):
            folder = primary / client['memory_folder']
            assert folder.resolve() == (hub / 'memory' / name).resolve(), \
                f'{name}: {folder} should link to {hub / "memory" / name}; run install.py'
        for folder_name in client.get('history', []):
            source, dest = primary / folder_name, hub / 'history' / name / folder_name
            status = relocate.state(source, dest)
            if status == 'pending':
                WARNINGS.append(f'{source} is not in {hub / "history"} yet; close Claude and Codex, then run install.py')
            elif status not in ('moved', 'absent'):
                raise AssertionError(f'{name}: {status}')
        check_agents(hub, name, primary, extras)
        if name == 'claude':
            wanted = wiring.provision_command(hub)
            commands = [h.get('command') for event, _m, h in check_hooks(hub, name, {}, primary / 'settings.json')
                        if event == 'SessionStart' and wiring.is_provision_hook(h)]
            assert commands == [wanted], \
                f'Claude SessionStart provisioning is {commands or "missing"}, expected [{wanted!r}]; run install.py'
        if name == 'codex':
            config_file = primary / 'config.toml'
            config = tomllib.loads(config_file.read_text()) if config_file.exists() else {}
            limit = config.get('project_doc_max_bytes')
            assert limit is None or int(limit) >= agents_md.stat().st_size, \
                f'Codex project_doc_max_bytes ({limit}) is smaller than AGENTS.md ({agents_md.stat().st_size} bytes)'
            system = primary / 'skills' / '.system'
            if system.exists():
                # Codex owns its bundled system skills and rewrites this folder on update.
                assert (system / '.codex-system-skills.marker').is_file(), 'skills/.system is not Codex-managed'
    return f'{len(clients)} installed clients ({", ".join(sorted(clients))})'


def check_ponytail(home, hub):
    plugin = hub / 'plugins/ponytail'
    assert plugin.is_dir(), 'Ponytail is not installed; run ./update-ponytail.sh'
    data = json.loads((hub / 'selected-skills.json').read_text())
    version = json.loads((plugin / '.claude-plugin/plugin.json').read_text())['version']
    codex_version = json.loads((plugin / '.codex-plugin/plugin.json').read_text())['version']
    assert codex_version == version, f'Ponytail Claude plugin is {version} but the Codex plugin is {codex_version}'
    for name in data['ponytail_plugin_paths']:
        path = home / name
        if not (home / Path(name).parts[0]).is_dir():
            continue  # that client is not installed here
        linked = path.is_symlink() and path.resolve(strict=True) == plugin
        assert linked or same_tree(path, plugin), f'Separate Ponytail installation: {path}'
    for skill in sorted((hub / 'skills').glob('ponytail*')):
        assert skill.resolve(strict=True) == plugin / 'skills' / skill.name, \
            f'{skill} does not point into {plugin / "skills"}; run ./update-ponytail.sh'
    clients = installed_clients(home, hub)
    if 'codex' in clients:
        primary, extras = registry.profiles(home, clients['codex'])
        for profile in [primary] + extras:
            source = tomllib.loads((profile / 'config.toml').read_text()).get('marketplaces', {}).get('ponytail', {})
            assert source.get('source_type') == 'local' and source.get('source') == str(hub / 'plugins'), \
                f'{profile} installs Ponytail from {source or "nowhere"}, not {hub / "plugins"}'
    claude_record = home / '.claude/plugins/installed_plugins.json'
    if 'claude' in clients and claude_record.exists():
        for record in json.loads(claude_record.read_text())['plugins'].get('ponytail@ponytail', []):
            assert Path(record['installPath']).resolve(strict=True) == plugin, \
                f"Claude loads Ponytail from {record['installPath']}, not {plugin}"
            assert record['version'] == version, f"Claude records Ponytail {record['version']}, installed is {version}"
    config = home / '.config/ponytail/config.json'
    assert config.resolve(strict=True) == hub / 'ponytail.json', f'{config} is not a link to {hub / "ponytail.json"}'
    return f'one Ponytail {version} installation'


def check_schedule(hub):
    record_path = hub / 'chats' / 'scheduled.json'
    assert record_path.exists(), 'The scheduled job has never run; run install.py'
    record = json.loads(record_path.read_text())
    assert not record.get('error'), f"Last scheduled run failed: {record['error']}"
    problems = record.get('doctor_problems') or []
    assert not problems, f'Memory doctor found {len(problems)} problem(s), first: {problems[0]}; ' \
                         f'run `agents-hub memory doctor`'
    if record.get('busy'):
        WARNINGS.append('the last scheduled run found the index busy (another index run held the lock)')
    # Only a complete run counts as fresh. Records from before succeeded_at existed carry only attempted_at.
    succeeded = record.get('succeeded_at') or (None if 'succeeded_at' in record else record['attempted_at'])
    if succeeded is None:
        assert record.get('busy'), 'The scheduled job has never completed a run'
        return
    age_hours = (datetime.now(timezone.utc) - datetime.fromisoformat(succeeded)).total_seconds() / 3600
    assert age_hours < SCHEDULE_DEAD_HOURS, f'No complete scheduled run for {age_hours:.0f} hours; the job is not running'
    if age_hours > SCHEDULE_LATE_HOURS:
        WARNINGS.append(f'last complete scheduled run was {age_hours:.1f} hours ago (asleep, or the job stopped)')


def check_memory_links(home, hub):
    """Every Claude memory folder links to the scope its project resolves to."""
    paths = Paths(home)
    scopes = (hub / 'memory/scopes').resolve()
    projects = home / '.claude/projects'
    links = [p / 'memory' for p in projects.iterdir()
             if (p / 'memory').exists() or (p / 'memory').is_symlink()] if projects.is_dir() else []
    for link in links:
        assert link.is_symlink() and link.resolve(strict=True).parent == scopes, f'Memory outside the hub: {link}'
        expected = memory.expected_scope(paths, link.parent)
        assert expected is None or link.resolve().name == expected, \
            f'{link} uses scope {link.resolve().name}, but its project resolves to {expected}'
        if os.path.isabs(os.readlink(link)):
            WARNINGS.append(f'{link} links with a full path; run install.py to make it relative')
    return links


def check_hub(home, hub):
    from agents_hub import index as hub_index, redact
    ignored = (hub / '.gitignore').read_text().split()
    for name in ('chats/', 'memory/', 'history/', 'handoffs/', 'backup/'):
        assert name in ignored, f'{name} must stay out of git'

    links = check_memory_links(home, hub)

    if platform.system() == 'Darwin':
        for folder in ('chats', 'handoffs'):
            result = subprocess.run(['tmutil', 'isexcluded', str(hub / folder)], capture_output=True, text=True)
            if '[Excluded]' not in result.stdout:
                WARNINGS.append(f'{folder}/ is in Time Machine backups; run install.py to exclude it')
    check_schedule(hub)

    db = sqlite3.connect(f'file:{hub / "chats/index.sqlite"}?mode=ro', uri=True)
    try:
        for importer in hub_index.IMPORTERS:
            stale = db.execute('SELECT count(*) FROM sessions WHERE agent = ? AND parser_version != ?',
                               (importer.AGENT, importer.VERSION)).fetchone()[0]
            assert stale == 0, f'{stale} {importer.AGENT} sessions indexed by an old parser; run agents-hub index'
        old_redaction = db.execute('SELECT count(*) FROM sessions WHERE redaction_version != ?',
                                   (redact.VERSION,)).fetchone()[0]
        assert old_redaction == 0, f'{old_redaction} sessions use an old redaction policy; run agents-hub index'
        sessions = db.execute('SELECT count(*) FROM sessions').fetchone()[0]
    finally:
        db.close()
    return f'{len(links)} memory links; {sessions} indexed sessions'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home())
    check(parser.parse_args().home)
