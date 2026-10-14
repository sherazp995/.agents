"""Check that this machine's agents use ~/.agents for rules, skills, agents, memory, chats,
hooks, permissions, MCP servers and the shared config in local/.

Every section runs even when an earlier one fails, and all failures are listed.
Clients that are not installed (see registry.toml) are skipped. Run
`python3 ~/.agents/install.py` first on a new machine.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import re
import sqlite3
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / 'hub'))

from agents_hub import interpreter  # noqa: E402

interpreter.ensure(str(Path(__file__).resolve()))

import tomllib  # noqa: E402  (3.11+, so only after ensure() has found a new enough Python)

from agents_hub import accounts, memory, registry, relocate, shared_config, wiring  # noqa: E402
from agents_hub.paths import Paths  # noqa: E402

HOOK_CONFIG = {'claude': 'settings.json', 'codex': 'hooks.json'}
SCHEDULE_LATE_HOURS = 2      # warn: the machine may just have been asleep
SCHEDULE_DEAD_HOURS = 24     # fail: the scheduled job is not running
WARNINGS = []


def installed_clients(home, hub):
    return {c['name']: c for c in registry.load(hub)['clients'] if registry.installed(home, c)}


def check(home, repo_only=False):
    if repo_only:
        # CI: check the checkout this file lives in, not a provisioned ~/.agents.
        hub = Path(__file__).resolve().parent
        sections = (('repository', lambda home, hub: f'{len(check_repo(hub)[1])} shared personal skills'),)
    else:
        home = home.resolve()
        hub = home / '.agents'
        sections = (('skills and rules', check_skills_and_rules), ('clients', check_clients),
                    ('hub', check_hub))
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


def check_repo(hub):
    """The checks that read only the checkout: selected skills exist and AGENTS.md links survive symlinks."""
    data = json.loads((hub / 'selected-skills.json').read_text())
    shared = hub / 'skills'
    # App-owned folders: Claude syncs organization skills and Codex rewrites its system skills.
    # Git-ignored folders are downloaded third-party skills (AGENTS.md names their source), not authored.
    names = [p.name for p in shared.iterdir() if not p.name.startswith('.') and p.name != 'synced']
    ignored = subprocess.run(['git', 'check-ignore', '--stdin'], cwd=hub, capture_output=True, text=True,
                             input='\n'.join(f'skills/{n}' for n in names)).stdout.split()
    authored = set(names) - {Path(p).name for p in ignored}
    assert set(data['skills']) <= authored, f'Selected skills missing: {sorted(set(data["skills"]) - authored)}'
    if authored - set(data['skills']):
        WARNINGS.append(f'skills not listed in selected-skills.json: {sorted(authored - set(data["skills"]))}')
    agents_md = (hub / 'AGENTS.md').read_text()
    assert not re.search(r'\]\((?!~/|/|https?:)', agents_md), 'AGENTS.md has a relative link; it breaks through symlinks'
    assert re.search(r'\]\((/|~/)[^)]*AGENTS-CONFIG\.md\)', agents_md), 'AGENTS.md does not link AGENTS-CONFIG.md'
    return data, authored


def check_skills_and_rules(home, hub):
    data, authored = check_repo(hub)
    shared = hub / 'skills'
    roots = [home / root for root in data['roots'] if (home / root).parent.is_dir()]
    for path in roots:
        assert path.is_symlink() and path.resolve(strict=True) == shared, f'Separate skill directory: {path}'
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


def check_permissions(hub, name, config_file):
    """Every registry [permissions] rule for this client is in permissions.allow, as install.py writes it."""
    wanted = registry.load(hub).get('permissions', {}).get(name, [])
    config = json.loads(config_file.read_text()) if config_file.exists() else {}
    allow = (config.get('permissions') or {}).get('allow') or []
    missing = [rule for rule in wanted if rule not in allow]
    assert not missing, f"{name}: {config_file} permissions.allow lacks {', '.join(missing)}; run install.py"


def check_mcp(home, hub, name, primary, extras):
    """Every mcp/servers.json server meant for this client is in each login's config, as install.py writes it.

    Servers the user added are not checked. Codex is given only stdio servers.
    """
    path = hub / wiring.MCP_SERVERS
    if name not in wiring.MCP_KEY or not path.exists():
        return
    servers = wiring.mcp_wanted(json.loads(path.read_text()).get('mcpServers', {}), name)
    wanted = {n: wiring.mcp_server(name, s) for n, s in servers.items()
              if name == 'claude' or s.get('type', 'stdio') == 'stdio'}
    for login in [primary] + extras:
        config_path = wiring.mcp_config_path(home, name, login, primary)
        text = config_path.read_text() if config_path.exists() else ''
        config = json.loads(text or '{}') if name == 'claude' else tomllib.loads(text)
        present = config.get(wiring.MCP_KEY[name]) or {}
        for server_name, server in wanted.items():
            have = present.get(server_name)
            assert have is not None, f'{name}: {config_path} lacks MCP server {server_name}; run install.py'
            assert wiring.mcp_server(name, have) == server, \
                f'{name}: MCP server {server_name} in {config_path} differs from {path}; run install.py'


def check_local_ignored(hub):
    """local/ holds machine-specific config, so git must ignore it (skipped when the hub is not a checkout)."""
    if not (hub / 'local').exists() or not (hub / '.git').exists():
        return
    result = subprocess.run(['git', 'check-ignore', '-q', 'local/'], cwd=hub, capture_output=True, text=True)
    if result.returncode == 128:
        WARNINGS.append(f'could not ask git whether {hub / "local"} is ignored: {result.stderr.strip()}')
        return
    assert result.returncode == 0, f'{hub / "local"} is not git-ignored; add local/ to {hub / ".gitignore"}'


def check_local_shared(home, hub, name, client, primary, extras):
    """Each `local_shared` entry resolves to its hub copy in local/<client>/, in the first login and in
    every extra login that links it (account_links), and each Codex login's shared_config keys match
    local/codex/config.shared.toml (a warning: install.py reports why a login differs)."""
    linked = set(client.get('account_links', []))
    for entry in client.get('local_shared', []):
        source, dest = primary / entry, hub / 'local' / name / entry
        if dest.exists() or dest.is_symlink():
            logins = [primary] + [extra for extra in extras if entry in linked]
            for login in logins:
                path = login / entry
                assert path.resolve() == dest.resolve(), f'{name}: {path} should link to {dest}; run install.py'
        elif source.exists() and not source.is_symlink():
            WARNINGS.append(f'{source} is not in {hub / "local"} yet; close Claude and Codex, then run install.py')
    shared = hub / shared_config.PATH
    if not client.get('shared_config') or not shared.exists():
        return
    wanted = shared_config.units(tomllib.loads(shared.read_text()), shared_config.listed_paths(client))
    for login in [primary] + extras:
        config_path = login / 'config.toml'
        config = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
        differ = shared_config.drift(config, wanted)
        if differ:
            WARNINGS.append(f'{config_path} differs from {shared} in {", ".join(differ)}; run install.py')


def check_agents(hub, name, primary, extras):
    """Claude links the shared agents and commands; Codex has a generated .toml for every agent."""
    if name == 'claude':
        folder = primary / 'agents'
        assert folder.is_symlink() and folder.resolve(strict=True) == (hub / 'agents').resolve(), \
            f'{folder} is not a link to {hub / "agents"}; run install.py'
        for command in sorted((hub / 'commands').glob('*.md')):
            if not command.exists():
                continue  # install.py skips a command whose target is missing on this machine
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


def assert_no_ponytail(path, names):
    """Ponytail was removed from the hub; a login that still registers it loads a stale cached copy."""
    left = [n for n in names if 'ponytail' in n]
    assert not left, f'{path} still registers the removed Ponytail plugin ({", ".join(left)}); delete those entries'


def check_clients(home, hub):
    """Every installed client and profile is wired the way registry.toml says."""
    agents_md = hub / 'AGENTS.md'
    clients = installed_clients(home, hub)
    check_local_ignored(hub)
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
        check_mcp(home, hub, name, primary, extras)
        check_local_shared(home, hub, name, client, primary, extras)
        if name == 'claude':
            wanted = wiring.provision_command(hub)
            commands = [h.get('command') for event, _m, h in check_hooks(hub, name, {}, primary / 'settings.json')
                        if event == 'SessionStart' and wiring.is_provision_hook(h)]
            assert commands == [wanted], \
                f'Claude SessionStart provisioning is {commands or "missing"}, expected [{wanted!r}]; run install.py'
            check_permissions(hub, name, primary / 'settings.json')
            settings = json.loads((primary / 'settings.json').read_text()) if (primary / 'settings.json').exists() else {}
            assert_no_ponytail(primary / 'settings.json', [*settings.get('enabledPlugins', {}),
                                                           *settings.get('extraKnownMarketplaces', {})])
        if name == 'codex':
            configs = []
            for login in [primary, *extras]:  # config.toml is separate per login, so each one is read
                login_file = login / 'config.toml'
                configs.append((login_file, tomllib.loads(login_file.read_text()) if login_file.exists() else {}))
            limit = configs[0][1].get('project_doc_max_bytes')
            assert limit is None or int(limit) >= agents_md.stat().st_size, \
                f'Codex project_doc_max_bytes ({limit}) is smaller than AGENTS.md ({agents_md.stat().st_size} bytes)'
            for login_file, login_config in configs:
                assert_no_ponytail(login_file, [*login_config.get('plugins', {}),
                                                *login_config.get('marketplaces', {})])
            system = primary / 'skills' / '.system'
            if system.exists():
                # Codex owns its bundled system skills and rewrites this folder on update.
                assert (system / '.codex-system-skills.marker').is_file(), 'skills/.system is not Codex-managed'
    return f'{len(clients)} installed clients ({", ".join(sorted(clients))})'


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
    parser.add_argument('--repo-only', action='store_true',
                        help='check only the checkout (selected skills, AGENTS.md links); used by CI')
    args = parser.parse_args()
    check(args.home, args.repo_only)
