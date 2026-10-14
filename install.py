#!/usr/bin/env python3
"""Wire this machine's coding agents to ~/.agents. Safe to run again at any time.

    python3 ~/.agents/install.py            # apply
    python3 ~/.agents/install.py --dry-run  # show what would change

It never overwrites: anything in the way (a real file where a link belongs, a
link pointing elsewhere, a config it cannot merge) is reported as a conflict for
you to resolve, and the run exits 1. Clients that are not installed are skipped.
What it sets up is listed in README.md; which clients exist is in registry.toml.

Shared config that is machine-specific (Claude settings.json, Codex hooks.json, ...) lives in
the git-ignored ~/.agents/local/<client>/: each client's `local_shared` entries in registry.toml
are moved there from the first login (backup first, in ~/.agents/backup) and linked back, and
extra accounts reach them through their account_links to the first login. Codex's config.toml
stays a real file per login; the keys registry.toml lists as `shared_config` come from
local/codex/config.shared.toml (seeded from the first login) and are merged into every Codex
login's config.toml, keeping its other lines; a key a login changed after it matched is a conflict
(rules in hub/agents_hub/shared_config.py). Moves into local/ wait until Claude and Codex are closed
(or --running-ok). Login state (.claude.json, auth.json, trusted
projects) and download caches (plugins/) stay in each login.
"""
import argparse
import copy
import filecmp
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import sys
import time
from xml.sax.saxutils import escape

HUB = Path(__file__).resolve().parent
sys.path.insert(0, str(HUB / 'hub'))

from agents_hub import interpreter  # noqa: E402

interpreter.ensure(str(Path(__file__).resolve()))

import tomllib  # noqa: E402  (3.11+, so only after ensure() has switched to such an interpreter)

from agents_hub import accounts, memory, registry, relocate, scope, shared_config, tomledit, wiring  # noqa: E402
from agents_hub.paths import Paths  # noqa: E402
from agents_hub.wiring import MARKER, MCP_KEY, MCP_SERVERS, is_provision_hook, mcp_server  # noqa: E402,F401

JOB = 'agents-hub.index'
CRON_MARK = '# agents-hub scheduled job'
INTERVAL_SECONDS = 900
PROVISION_TIMEOUT = 20
HOOK_CONFIG = {'claude': 'settings.json', 'codex': 'hooks.json'}
PERMISSIONS_STATE = 'agents-hub-permissions.json'  # the allow rules install.py added
MCP_STATE = 'agents-hub-mcp.json'  # per login: the MCP servers install.py added, as it wrote them
# Hand-added servers the hub now ships under another name: old name -> (hub name, the whole old
# server). Only a server that is exactly this (in the client's shape) is replaced.
LEGACY_MCP = {'playwright-ext': ('playwright-extension', {
    'type': 'stdio', 'command': 'npx', 'args': ['@playwright/mcp@latest', '--extension'], 'env': {}})}
# Hand-added servers already under the hub's name in an older form: name -> the whole old servers
# it may be. Codex logins had the extension switched on by env; Codex `tools` approvals are kept.
LEGACY_SAME_NAME_MCP = {'playwright-extension': [
    {'command': 'npx', 'args': ['@playwright/mcp@latest'], 'env': {'PLAYWRIGHT_MCP_EXTENSION': 'true'},
     'env_vars': env_vars} for env_vars in ([], ['PLAYWRIGHT_MCP_EXTENSION_TOKEN'])]}


def write_text(path, text):
    """Replace a file in one rename, through a symlink to its real location, keeping its mode."""
    real = path.resolve()
    real.parent.mkdir(parents=True, exist_ok=True)
    temporary = real.with_name(real.name + '.agents-hub-tmp')
    temporary.write_text(text)
    if real.exists():
        shutil.copymode(real, temporary)
    os.replace(temporary, real)


def write_json(path, data):
    write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def merge_permissions(config, owned, wanted):
    """(new config, rules the hub now owns, change messages) for permissions.allow.

    Rules in `owned` that are no longer `wanted` are removed; `wanted` rules that are missing are
    appended and become owned; a wanted rule already present and not owned stays the user's.
    """
    allow = (config.get('permissions') or {}).get('allow') or []
    dropped = [rule for rule in owned if rule not in wanted]
    kept = [rule for rule in allow if rule not in dropped]
    added = [rule for rule in dict.fromkeys(wanted) if rule not in kept]
    now_owned = [rule for rule in dict.fromkeys(wanted) if rule in owned or rule in added]
    messages = [f'allow {rule}' for rule in added]
    messages += [f'removed allow {rule} (no longer in registry.toml)' for rule in dropped if rule in allow]
    if not messages:
        return config, now_owned, []
    updated = copy.deepcopy(config)
    updated.setdefault('permissions', {})['allow'] = kept + added
    return updated, now_owned, messages


def same_content(a, b, roots=None):
    """Whether two paths hold the same thing: equal file bytes, links that lead to the same place,
    or folders with the same names whose entries are all the same.

    A link is compared by where it leads, not by its text, since the same target is spelled
    differently from another folder. A link into its own top folder (`roots`) is compared by its
    place inside that folder.
    """
    roots = roots or (a, b)
    if a.is_symlink() or b.is_symlink():
        return a.is_symlink() and b.is_symlink() and link_destination(a, roots[0]) == link_destination(b, roots[1])
    if a.is_dir() and b.is_dir():
        names = sorted(p.name for p in a.iterdir())
        return names == sorted(p.name for p in b.iterdir()) and all(
            same_content(a / n, b / n, roots) for n in names)
    return a.is_file() and b.is_file() and filecmp.cmp(a, b, shallow=False)


def link_destination(link, root):
    """('inside', path relative to root) for a link into root, else ('outside', the resolved path)."""
    target, top = Path(os.path.realpath(link)), Path(os.path.realpath(root))
    return ('inside', target.relative_to(top)) if target.is_relative_to(top) else ('outside', target)


def adopt_legacy_mcp(client, current, owned, wanted):
    """(owned plus the hand-added legacy servers taken over, change messages).

    A legacy server counts as one install.py wrote only when it is exactly a known old form (Codex
    `tools` aside), so the usual rules then update or remove it; anything else under a legacy name
    is left to them as a conflict or note.
    """
    owned, messages = dict(owned), []
    for name, forms in LEGACY_SAME_NAME_MCP.items():
        if name in wanted and name not in owned and current.get(name) in [mcp_server(client, f) for f in forms]:
            owned[name] = current[name]
            messages.append(f"replaced hand-added MCP server {name} (older form) with mcp/servers.json's")
    for old, (replacement, form) in LEGACY_MCP.items():
        if old in owned or old in wanted or replacement not in wanted or current.get(old) != mcp_server(client, form):
            continue
        if current.get(replacement) in (None, wanted[replacement], owned.get(replacement)):
            owned[old] = current[old]
            messages.append(f'replaced hand-added MCP server {old} with {replacement}')
    return owned, messages


def merge_mcp(client, current, owned, wanted):
    """(servers to set, names to remove, servers the hub now owns, changes, conflicts, notes).

    All servers are in the client's shape. A wanted server is added when missing and updated only
    when the one there is exactly what install.py wrote (`owned`); a different server under that
    name is a conflict, and stays owned so it is updated again once it matches. An owned server
    dropped from mcp/servers.json is removed unless edited since.
    """
    owned, changes = adopt_legacy_mcp(client, current, owned, wanted)
    sets, removes, now_owned, conflicts, notes = {}, [], {}, [], []
    for name, server in wanted.items():
        have = current.get(name)
        if have is None or (have != server and owned.get(name) == have):
            sets[name] = now_owned[name] = server
            changes.append(f"{'add' if have is None else 'update'} MCP server {name}")
        elif have == server:
            if name in owned:
                now_owned[name] = server
        elif name in owned:
            now_owned[name] = owned[name]
            conflicts.append(f'MCP server {name} was changed by hand since install.py added it; '
                             'remove it or make it match mcp/servers.json, then rerun')
        else:
            conflicts.append(f'MCP server {name} differs from mcp/servers.json and was not added by '
                             'install.py; remove it or make it match, then rerun')
    for name, server in owned.items():
        if name in wanted or name not in current:
            continue
        if current[name] == server:
            removes.append(name)
            if name not in LEGACY_MCP:
                changes.append(f'removed MCP server {name} (no longer in mcp/servers.json)')
        else:
            notes.append(f'left MCP server {name} alone: changed by hand since install.py added it')
    for old, (replacement, _form) in LEGACY_MCP.items():
        if old in current and old not in owned and old not in wanted:
            notes.append(f'left hand-added MCP server {old} alone (not the plain {replacement} server)')
    return sets, removes, now_owned, changes, conflicts, notes


def codex_keys(server):
    """The keys written to config.toml: empty defaults are left out."""
    return {k: v for k, v in server.items() if v or k not in ('args', 'env', 'env_vars')}


class Installer:
    def __init__(self, home, dry_run, host, running_ok=False):
        self.home, self.dry_run, self.host, self.running_ok = home, dry_run, host, running_ok
        self.changes, self.conflicts, self.notes = [], [], []
        self._running = None
        self._mcp_servers = None
        self._backup = None  # this run's backup folder for local_shared moves
        self._shared_seen = set()  # (client, entry) local_shared already handled this run

    # helpers

    def change(self, message, action):
        self.changes.append(message)
        if not self.dry_run:
            action()

    def link(self, path, target):
        """path -> target, unless something else is already there.

        Links into ~/.agents are written relative, so they keep working if the home folder is
        copied or renamed; such a link written with a full path by an older install is rewritten
        relative (same target). Links elsewhere are created as full paths and otherwise left
        exactly as they are; extra accounts' links are handled by sync_accounts.
        """
        entry = target.parent.resolve() / target.name  # the hub entry itself, even when it is a link out
        into_hub = entry.is_relative_to(HUB.resolve())
        written = os.path.relpath(entry, path.parent.resolve()) if into_hub and path.parent.exists() else str(target)
        if path.is_symlink() and path.resolve() == target.resolve():
            current = os.readlink(path)
            pointed = Path(os.path.join(path.parent, current))
            bypasses_hub = into_hub and pointed.parent.resolve() / pointed.name != entry
            if not bypasses_hub and not (os.path.isabs(current) and Path(current).is_relative_to(HUB)):
                return  # already relative, or literally points somewhere outside the hub: leave it

            def relink():
                temporary = path.with_name(path.name + '.agents-hub-tmp')
                temporary.symlink_to(written)
                os.replace(temporary, path)  # swaps the link in one step; the target is untouched
            self.change(f'relink {path} -> {written} (relative)', relink)
            return
        if path.is_symlink() or path.exists():
            self.conflicts.append(f'{path} exists and is not a link to {target}; move it aside, then rerun')
            return

        def make():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(os.path.relpath(entry, path.parent.resolve()) if into_hub else target)
        self.change(f'link {path} -> {target}', make)

    def write_owned(self, path, text, replaceable_link=None, equivalent=None):
        """Write a generated file. An existing file is replaced only if it carries MARKER, is a
        symlink to replaceable_link, or `equivalent(current, text)` says it holds the same content;
        anything else is a conflict."""
        if path.is_symlink():
            if replaceable_link is None or path.resolve() != replaceable_link.resolve():
                self.conflicts.append(f'{path} is a link to {path.resolve()}; move it aside, then rerun')
                return False
        elif path.exists():
            current = path.read_text(errors='replace')
            if current == text:
                return False
            if MARKER not in current and not (equivalent and equivalent(current, text)):
                self.conflicts.append(f'{path} exists and was not written by install.py; move it aside, then rerun')
                return False

        def write():
            # Rename over the path: replaces an old symlink to the template, never writes through it.
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + '.agents-hub-tmp')
            temporary.write_text(text)
            os.replace(temporary, path)
        self.change(f'write {path}', write)
        return True

    def agents_running(self):
        """True when Claude or Codex is open; moving their data then waits for a rerun."""
        if self.running_ok:
            return False
        if self._running is None:
            self._running = bool(memory.other_agents_running())
        return self._running

    def wait_for_agents(self, what):
        self.notes.append(f'{what} waits: close Claude and Codex, then rerun install.py '
                          '(or pass --running-ok)')

    # chat history and memory

    def history(self, client):
        """The app's chat history folders live in ~/.agents/history/<client>; the app keeps a link."""
        primary, _extras = registry.profiles(self.home, client)  # extras reach it through account_links
        for name in client.get('history', []):
            source, dest = primary / name, HUB / 'history' / client['name'] / name
            status = relocate.state(source, dest)
            if status in ('moved', 'absent'):
                continue
            if status != 'pending':
                self.conflicts.append(status)
            elif not relocate.same_disk(source, dest):
                self.conflicts.append(f'{relocate.tilde(source)} is on another disk than ~/.agents; '
                                      'its history stays where it is')
            elif self.agents_running():
                self.wait_for_agents(f'moving {relocate.tilde(source)} into ~/.agents/history')
            else:
                self.change(f'move {relocate.tilde(source)} to {relocate.tilde(dest)} and link it back',
                            lambda s=source, d=dest: self.move(s, d))

    def move(self, source, dest):
        """A failed move is a conflict to report, not a crash that stops the rest of the install."""
        try:
            relocate.relocate(source, dest)
        except relocate.RelocateError as error:
            self.conflicts.append(str(error))

    def adopt(self, paths):
        try:
            memory.adopt(paths, running_ok=True, label='install')
        except (OSError, memory.MemoryError) as error:
            self.conflicts.append(f'moving Claude memory failed ({error}); the backup is in ~/.agents/backup')

    def claude_memory(self):
        """Real Claude memory folders move into ~/.agents/memory; full-path links become relative."""
        paths = Paths(self.home)
        pending = memory.unadopted(paths)
        if pending and self.agents_running():
            self.wait_for_agents(f'moving {len(pending)} Claude memory folder(s) into ~/.agents/memory')
        elif pending and not all(relocate.same_disk(folder, paths.scopes) for folder in pending):
            self.conflicts.append('Claude memory folders are on another disk than ~/.agents; they stay where they are')
        elif pending:
            self.change(f'move {len(pending)} Claude memory folder(s) into ~/.agents/memory (backup in ~/.agents/backup)',
                        lambda: self.adopt(paths))
        for marker in sorted(paths.scopes.glob(f'*/{scope.PATH_FILE}')):
            written = marker.read_text().strip()
            if os.path.isabs(written) and relocate.tilde(written, self.home) != written:
                self.change(f'write {relocate.tilde(marker, self.home)} with ~ for the home folder',
                            lambda m=marker, w=written: scope.record_path(paths, m.parent, w))
        for link in memory.claude_memory_dirs(paths):
            current = os.readlink(link) if link.is_symlink() else ''
            if os.path.isabs(current) and link.exists() and link.resolve().is_relative_to(HUB.resolve()):
                self.change(f'relink {relocate.tilde(link)} (relative)',
                            lambda l=link: relocate.normalize_links([l], HUB))

    # rules

    def rules(self, client):
        primary, extras = registry.profiles(self.home, client)
        agents_md = HUB / 'AGENTS.md'
        mode = client['rules_mode']
        if mode == 'link':
            self.link(primary / client['rules'], agents_md)  # extra accounts reach it through the first login
        elif mode == 'render':
            template = HUB / 'integrations' / f"{client['name']}.mdc"
            self.write_owned(primary / client['rules'], wiring.render(template, agents_md), replaceable_link=template)
        elif mode == 'merge':
            self.merge(client['name'], primary / client['rules'], agents_md)
        self.sync_accounts(client, primary, extras)
        if client.get('memory_folder'):
            self.memory_folder(primary / client['memory_folder'], HUB / 'memory' / client['name'])

    def sync_accounts(self, client, primary, extras):
        """Each extra account's shared entries are relative links to the first login's entries."""
        for folder in extras:
            for path, target, state in accounts.plan(primary, folder, client):
                if state == 'missing':
                    self.change(f'link {path} -> {target}', lambda p=path, t=target: accounts.write_link(p, t))
                elif state == 'full':
                    self.change(f'relink {path} -> {os.path.relpath(target, path.parent.resolve())} (relative)',
                                lambda p=path, t=target: accounts.write_link(p, t))
                elif state == 'conflict':
                    self.conflicts.append(f'{path} exists and is not a link to {target}; move it aside, then rerun')
            for path in accounts.stale_links(primary, folder, client):
                self.change(f'remove {relocate.tilde(path)} (a dangling link to an entry no longer shared)', path.unlink)

    def memory_folder(self, path, target):
        """The app's own memory folder lives in the hub; an empty real folder is replaced by the link."""
        if path.is_dir() and not path.is_symlink() and not any(path.iterdir()):
            self.change(f'remove empty {path} (its memory moves to {target})', path.rmdir)
        if not self.dry_run:
            target.mkdir(parents=True, exist_ok=True)
        self.link(path, target)

    def merge(self, name, path, agents_md):
        loaded = wiring.merged_reference(name, path, agents_md)
        if loaded:
            return
        snippet = wiring.rules_snippet(name, agents_md)
        if name == 'aider' and not path.exists():
            self.change(f'write {path}', lambda: path.write_text(snippet + '\n'))
        elif loaded is None:
            self.notes.append(f'PyYAML is not installed, so {path} could not be checked; make sure it has:\n{snippet}')
        else:
            self.conflicts.append(f'{path}: add this by hand (YAML is not merged automatically):\n{snippet}')

    def skill_dirs(self):
        selected = json.loads((HUB / 'selected-skills.json').read_text())
        for root in selected['roots']:
            path = self.home / root
            if path.parent.is_dir():
                self.link(path, HUB / 'skills')

    # agents and commands

    def agents(self, client):
        primary, _extras = registry.profiles(self.home, client)  # extras share agents/ through account_links
        if client['name'] == 'claude':
            self.link(primary / 'agents', HUB / 'agents')
            for md in sorted((HUB / 'commands').glob('*.md')):
                if not md.exists():  # a link to another checkout this machine does not have
                    self.notes.append(f'{md} points to {os.readlink(md)}, which is missing here; skipped')
                    continue
                self.link(primary / 'commands' / md.name, md)
        elif client['name'] == 'codex':
            self.codex_agents(primary / 'agents')

    def codex_agents(self, folder):
        sources = sorted((HUB / 'agents').glob('*.md'))
        for md in sources:
            try:
                text = wiring.codex_agent(md)
            except (wiring.WiringError, ValueError) as error:
                self.conflicts.append(str(error))
                continue
            self.write_owned(folder / f'{md.stem}.toml', text, equivalent=wiring.same_toml)
        wanted = {md.stem for md in sources}
        for generated in sorted(folder.glob('*.toml')) if folder.is_dir() else []:
            if generated.stem not in wanted and MARKER in generated.read_text(errors='replace').split('\n', 1)[0]:
                self.change(f'remove {generated} (its agents/{generated.stem}.md is gone)', generated.unlink)

    # hooks

    def desired_hooks(self, client):
        """(label, event, matcher, hook, owns) for every hook this hub keeps in the client's config."""
        items = []
        if client['name'] == 'claude':
            command = {'type': 'command', 'command': wiring.provision_command(HUB), 'timeout': PROVISION_TIMEOUT}
            items.append(('memory provision', 'SessionStart', '', command, is_provision_hook))
        for entry in client.get('hooks', []):
            try:
                event, matcher, hook = wiring.desired_hook(HUB, client['name'], entry)
            except (wiring.WiringError, KeyError) as error:
                self.conflicts.append(f"{client['name']}: hook {entry.get('name')}: {error}")
                continue
            name = entry['name']
            owns = (lambda h, n=name: wiring.hook_owner(h, HUB, client['name']) == n or wiring.legacy_owner(h) == n)
            items.append((name, event, matcher, hook, owns))
        return items

    def hooks(self, client):
        primary, _extras = registry.profiles(self.home, client)
        if client['name'] not in HOOK_CONFIG:
            if client.get('hooks'):
                self.conflicts.append(f"{client['name']}: hooks are supported only for claude and codex")
            return
        if not primary.is_dir():
            return
        config_path = primary / HOOK_CONFIG[client['name']]
        items = self.desired_hooks(client)
        if not items and not config_path.exists():
            return
        config = json.loads(config_path.read_text()) if config_path.exists() else {}
        updated, messages = self.reconcile(config, client['name'], items)
        if messages:
            self.change(f'{config_path}: ' + '; '.join(messages), lambda: write_json(config_path, updated))

    def reconcile(self, config, client, items):
        """(new config, change messages). Only hooks this hub owns are replaced or removed."""
        found = {label: [] for label, *_ in items}
        legacy, stale = set(), []
        for event, matcher, hook in wiring.hook_entries(config):
            item = next((i for i in items if i[4](hook)), None)
            if item:
                found[item[0]].append((event, matcher, hook))
                if hook.get('type') == 'agent' and wiring.hook_owner(hook, HUB, client) is None:
                    legacy.add(item[0])
            elif wiring.hook_owner(hook, HUB, client):
                stale.append(wiring.hook_owner(hook, HUB, client))
            elif event in {i[1] for i in items}:
                summary = hook.get('command') or hook.get('prompt', '')[:60].replace('\n', ' ')
                self.notes.append(f'{client}: left alone {event} {hook.get("type")} hook not written by install.py: '
                                  f'{summary}')
        messages = [f'set {event} hook {label}' for label, event, matcher, hook, _o in items
                    if found[label] != [(event, matcher, hook)]]
        messages += [f'replaced the previous unmarked {label} hook' for label in sorted(legacy)]
        messages += [f'removed hook {name} (no longer in registry.toml)' for name in sorted(set(stale))]
        if not messages:
            return config, []
        updated = copy.deepcopy(config)
        events = updated.setdefault('hooks', {})

        def ours(hook):
            return any(i[4](hook) for i in items) or wiring.hook_owner(hook, HUB, client) is not None
        for event in list(events):
            groups = [{**g, 'hooks': [h for h in g.get('hooks', []) if not ours(h)]} for g in events[event]]
            events[event] = [g for g in groups if g['hooks']]
            if not events[event]:
                del events[event]
        for _label, event, matcher, hook, _owns in items:
            events.setdefault(event, []).append({**({'matcher': matcher} if matcher else {}), 'hooks': [hook]})
        return updated, messages

    # permissions

    def permissions(self, client):
        """Merge the registry's [permissions] list for this client into settings.json permissions.allow.

        A permission rule cannot carry a marker, so the rules install.py added are recorded in
        PERMISSIONS_STATE next to settings.json. Only those are ever removed; a rule that was
        already there (the user's own) is never recorded, so it stays when the hub drops it.
        """
        wanted = registry.load(HUB).get('permissions', {}).get(client['name'], [])
        primary, _extras = registry.profiles(self.home, client)  # extras share settings.json
        if client['name'] != 'claude':
            if wanted:
                self.conflicts.append(f"{client['name']}: permissions are supported only for claude")
            return
        state_path = primary / PERMISSIONS_STATE
        if not primary.is_dir() or (not wanted and not state_path.exists()):
            return
        config_path = primary / 'settings.json'
        config = json.loads(config_path.read_text()) if config_path.exists() else {}
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        updated, owned, messages = merge_permissions(config, state.get('allow', []), wanted)
        if messages:
            self.change(f'{config_path}: ' + '; '.join(messages), lambda: write_json(config_path, updated))
        if owned != state.get('allow'):
            self.change(f'write {state_path}',
                        lambda: write_json(state_path, {'_comment': MARKER, 'allow': owned}))

    # shared config in the git-ignored local/ area

    def local_shared(self, client):
        """Each `local_shared` entry of the first login lives in ~/.agents/local/<client>/; the first
        login keeps a relative link to it, and extra accounts reach it through their account_links.

        A real entry with no hub copy yet is backed up to ~/.agents/backup and moved there; one
        identical to the hub copy is backed up and replaced by the link; one that differs is a
        conflict. Like chat history, moving or replacing waits until Claude and Codex are closed
        (or --running-ok), on both calls; linking to a hub copy needs no wait. Folders move through
        relocate.relocate() so relative links inside keep their targets. run() calls it before hooks
        and permissions (so they write through a hub copy a new machine already has) and after them
        (so a file they just created moves in the same run).
        """
        primary, _extras = registry.profiles(self.home, client)
        if not client.get('local_shared') or not primary.is_dir():
            return
        for name in client['local_shared']:
            source, dest = primary / name, HUB / 'local' / client['name'] / name
            if (client['name'], name) in self._shared_seen:
                continue  # handled by the first pass; the second only takes newly created files
            if source.exists() or source.is_symlink() or dest.exists():
                self._shared_seen.add((client['name'], name))
            if source.is_symlink() or not source.exists():
                if source.is_symlink() or dest.exists():
                    self.link(source, dest)  # a link elsewhere is a conflict
                continue
            if dest.exists() or dest.is_symlink():
                if not same_content(source, dest):
                    self.conflicts.append(f'{relocate.tilde(source)} and {relocate.tilde(dest)} both exist and '
                                          'differ; keep one (merge by hand), remove the other, then rerun')
                    continue
                verb = 'replace'
            elif not relocate.same_disk(source, dest):
                self.conflicts.append(f'{relocate.tilde(source)} is on another disk than ~/.agents; it stays where it is')
                continue
            else:
                verb = 'move'
            if self.agents_running():  # an app writing it mid-move would split or lose the change
                self.wait_for_agents(f'moving {relocate.tilde(source)} into ~/.agents/local')
                continue
            self.change(f'{verb} {relocate.tilde(source)} with a link to {relocate.tilde(dest)} '
                        '(backup in ~/.agents/backup)', lambda s=source, d=dest: self.share(s, d, client['name']))

    def backup_dir(self):
        """This run's backup folder for local/ moves and config.toml values replaced (not created yet)."""
        if self._backup is None:
            self._backup = HUB / 'backup' / f"local-shared-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
        return self._backup

    def share(self, source, dest, client):
        """A failed move is a conflict to report, not a crash that stops the rest of the install."""
        try:
            self.share_now(source, dest, client)
        except (OSError, relocate.RelocateError) as error:
            self.conflicts.append(f'moving {relocate.tilde(source)} to {relocate.tilde(dest)} failed ({error}); '
                                  'the backup is in ~/.agents/backup')

    def share_now(self, source, dest, client):
        """Back up source, put it at dest (or drop it when dest still holds the same) and link it."""
        backup = self.backup_dir() / client / source.name
        backup.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, backup, symlinks=True)
        else:
            shutil.copy2(source, backup)
        if dest.exists() or dest.is_symlink():
            if not same_content(source, dest):  # changed since local_shared compared them
                self.conflicts.append(f'{relocate.tilde(source)} changed while install.py ran and now differs from '
                                      f'{relocate.tilde(dest)}; keep one (merge by hand), remove the other, then rerun')
                return
            if source.is_dir():
                shutil.rmtree(source)
            else:
                source.unlink()
        elif source.is_dir():
            dest.parent.mkdir(parents=True, exist_ok=True)
            relocate.relocate(source, dest)  # re-aims relative links inside, then links source back
            return
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.rename(source, dest)
        try:
            os.symlink(os.path.relpath(dest, source.parent.resolve()), source)
        except FileExistsError:
            self.conflicts.append(f'{relocate.tilde(source)} was recreated while it moved (an app is open); the '
                                  f'moved copy is {relocate.tilde(dest)}. Merge by hand, remove '
                                  f'{relocate.tilde(source)}, then rerun')

    # MCP servers

    def mcp_servers(self):
        """mcp/servers.json's servers, read once; {} when the file is missing, None when unreadable."""
        if self._mcp_servers is None:
            path = HUB / MCP_SERVERS
            try:
                self._mcp_servers = json.loads(path.read_text()).get('mcpServers', {}) if path.exists() else {}
            except (ValueError, AttributeError) as error:
                self.conflicts.append(f'{path} is not valid JSON with an mcpServers object ({error})')
                self._mcp_servers = False
        return self._mcp_servers if self._mcp_servers is not False else None

    def mcp(self, client):
        """Set mcp/servers.json's servers in every login of Claude (~/.claude.json, each extra
        account's own .claude.json) and Codex (each login's config.toml, once per real file).

        Like permissions, ownership is recorded per login in MCP_STATE: only servers install.py
        added are updated or removed, a server the user added is never touched, and project-level
        servers (projects.*.mcpServers in .claude.json) are never read or written.
        """
        name = client['name']
        servers = self.mcp_servers() if name in MCP_KEY else None
        if servers is None:
            return
        wanted = {}
        for server_name, server in wiring.mcp_wanted(servers, name).items():
            if name == 'codex' and server.get('type', 'stdio') != 'stdio':
                self.conflicts.append(f'codex: MCP server {server_name} is not a stdio server; install.py '
                                      'writes only stdio servers to config.toml')
                continue
            wanted[server_name] = mcp_server(name, server)
        primary, extras = registry.profiles(self.home, client)
        seen = set()
        for login in [primary, *extras]:
            config_path = wiring.mcp_config_path(self.home, name, login, primary)
            if not login.is_dir() or config_path.resolve() in seen:
                continue  # a config.toml linked to the first login's is written once
            seen.add(config_path.resolve())
            self.mcp_login(name, config_path, login / MCP_STATE, wanted)

    def mcp_login(self, client, config_path, state_path, wanted):
        if not wanted and not state_path.exists():
            return
        try:
            text = config_path.read_text() if config_path.exists() else ''
            config = json.loads(text or '{}') if client == 'claude' else tomllib.loads(text)
            state = json.loads(state_path.read_text()) if state_path.exists() else {}
        except ValueError as error:  # TOMLDecodeError and JSONDecodeError are ValueErrors
            self.conflicts.append(f'{config_path}: MCP servers not set, a file could not be read ({error})')
            return
        present = config.get(MCP_KEY[client]) or {}
        current = {n: mcp_server(client, s) for n, s in present.items() if isinstance(s, dict)}
        owned = state.get('servers', {})
        sets, removes, now_owned, changes, conflicts, notes = merge_mcp(client, current, owned, wanted)
        self.conflicts += [f'{config_path}: {c}' for c in conflicts]
        self.notes += [f'{config_path}: {n}' for n in notes]
        if changes:
            if client == 'claude':
                updated = copy.deepcopy(config)
                servers = updated.setdefault('mcpServers', {})
                for server_name in removes:
                    servers.pop(server_name, None)
                servers.update(sets)
                action = lambda: write_json(config_path, updated)  # noqa: E731
            else:
                # tomledit keeps every other line (a server's tools approvals too) and returns None
                # for a server it cannot edit line by line (an inline table, say): never guessed at
                edited = tomledit.edit(text, {('mcp_servers', n): codex_keys(s) for n, s in sets.items()},
                                       [('mcp_servers', n) for n in removes])
                if edited is None:
                    self.conflicts.append(f'{config_path}: cannot set MCP servers without changing other '
                                          'settings; make its [mcp_servers] tables match mcp/servers.json by hand')
                    return
                action = lambda: write_text(config_path, edited)  # noqa: E731
            self.change(f'{config_path}: ' + '; '.join(changes), action)
        if now_owned != owned:
            self.change(f'write {state_path}',
                        lambda: write_json(state_path, {'_comment': MARKER, 'servers': now_owned}))

    # Codex shared settings

    def shared_config(self, client):
        """Merge ~/.agents/local/codex/config.shared.toml into every Codex login's config.toml.

        registry.toml `shared_config` lists the shared keys (a table means each of its entries);
        everything else in config.toml (projects trust, hooks.state, the rest of tui, ...) is the
        login's own and is never read or written here, and mcp_servers stays with the MCP step.
        The first run seeds the shared file from the first login. The rules for each key are in
        agents_hub/shared_config.py; a value changed in a login after it matched is a conflict.
        """
        if not client.get('shared_config'):
            return
        if client['name'] != 'codex':
            self.conflicts.append(f"{client['name']}: shared_config is supported only for codex")
            return
        listed = shared_config.listed_paths(client)
        if any(path[0] == 'mcp_servers' for path in listed):
            self.conflicts.append('codex: shared_config must not list mcp_servers (mcp/servers.json owns them)')
            return
        primary, extras = registry.profiles(self.home, client)
        if not primary.is_dir():
            return
        shared = self.shared_config_file(primary / 'config.toml', listed)
        if shared is None:
            return
        wanted, seen = shared_config.units(shared, listed), set()
        for login in [primary, *extras]:
            config_path = login / 'config.toml'
            if not login.is_dir() or config_path.resolve() in seen:
                continue
            seen.add(config_path.resolve())
            self.shared_config_login(config_path, login / shared_config.CONFIG_STATE, wanted)

    def shared_config_file(self, primary_config, listed):
        """The shared file's settings; on the first run, seeded from the first login. None after a
        conflict."""
        path = HUB / shared_config.PATH
        try:
            if path.exists():
                shared = tomllib.loads(path.read_text())
                unlisted = shared_config.unshared_keys(shared, listed)
                if unlisted:
                    self.conflicts.append(f"{relocate.tilde(path, self.home)} has keys registry.toml's shared_config "
                                          f"does not list: {', '.join(unlisted)}; move them to a login or list them")
                    return None
                return shared
            source = tomllib.loads(primary_config.read_text()) if primary_config.exists() else {}
        except ValueError as error:
            self.conflicts.append(f'codex: shared settings not merged, a config could not be read ({error})')
            return None
        seed = shared_config.seed(source, listed)
        if seed:
            text = shared_config.HEADER + tomledit.dumps(seed)
            if tomllib.loads(text) != seed:
                self.conflicts.append(f'codex: could not write the shared keys of {primary_config} as TOML')
                return None
            self.change(f'write {relocate.tilde(path, self.home)} from the shared keys of '
                        f'{relocate.tilde(primary_config, self.home)}', lambda: write_text(path, text))
        return seed

    def shared_config_login(self, config_path, state_path, wanted):
        if not wanted and not state_path.exists():
            return
        shown = relocate.tilde(config_path, self.home)
        try:
            text = config_path.read_text() if config_path.exists() else ''
            config = tomllib.loads(text)
            state = json.loads(state_path.read_text()) if state_path.exists() else {}
        except ValueError as error:
            self.conflicts.append(f'{shown}: shared settings not merged, a file could not be read ({error})')
            return
        records = shared_config.read_state(state)
        merged = shared_config.merge(config, records, wanted)
        self.conflicts += [f'{shown}: {c}' for c in merged.conflicts]
        self.notes += [f'{shown}: {n}' for n in merged.notes]
        if merged.sets or merged.removes:
            edited = tomledit.edit(text, merged.sets, merged.removes)
            if edited is None:
                paths = ', '.join(map(tomledit.path_text, [*merged.sets, *merged.removes]))
                self.conflicts.append(f'{shown}: cannot merge {paths} line by line without changing other '
                                      f'settings; make them match {shared_config.PATH} by hand')
                return
            backup = self.backup_dir() / 'codex' / f'{config_path.parent.name}-config.toml'
            note = f' (backup in {relocate.tilde(backup, self.home)})' if config_path.exists() else ''

            def write():  # always back up first: the change may undo something only this login had
                if config_path.exists():
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(config_path, backup)
                write_text(config_path, edited)
            self.change(f'{shown}: ' + '; '.join(merged.changes) + note, write)
        if merged.records != records:
            entries = shared_config.state_entries(merged.records)
            self.change(f'write {relocate.tilde(state_path, self.home)}',
                        lambda: write_json(state_path, {'_comment': MARKER, 'keys': entries}))

    # command line and scheduler

    def cli(self):
        self.link(self.home / '.local' / 'bin' / 'agents-hub', HUB / 'hub' / 'agents-hub')

    def scheduler_path(self):
        """PATH for the scheduled job: launchd, systemd and cron start with almost none, and the
        launcher needs `python3` to start before it finds a 3.11+ (interpreter.find also globs
        version-manager folders)."""
        return ':'.join([str(self.home / '.local' / 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
                         '/usr/bin', '/bin', '/usr/sbin', '/sbin'])

    def scheduler(self):
        if not self.host:
            return
        # The launcher, not a pinned interpreter: it re-runs itself under any Python 3.11+.
        argv = [str(HUB / 'hub' / 'agents-hub'), 'scheduled']
        system = platform.system()
        if system == 'Darwin':
            self.launchd(argv)
        elif system == 'Linux' and shutil.which('systemctl') and subprocess.run(
                ['systemctl', '--user', 'show-environment'], capture_output=True).returncode == 0:
            self.systemd(argv)
        elif shutil.which('crontab'):
            self.cron(argv)
        else:
            self.conflicts.append('No scheduler found (launchd, systemd --user or cron); run `agents-hub scheduled` yourself')

    def launchd(self, argv):
        agents_dir = self.home / 'Library' / 'LaunchAgents'
        plist = agents_dir / f'{JOB}.plist'
        log = HUB / 'chats' / 'scheduled.log'
        args = ''.join(f'    <string>{escape(a)}</string>\n' for a in argv)
        text = (f'<?xml version="1.0" encoding="UTF-8"?>\n<!-- {MARKER} -->\n'
                f'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
                f'<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>{JOB}</string>\n'
                f'  <key>ProgramArguments</key>\n  <array>\n{args}  </array>\n'
                f'  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n'
                f'    <string>{escape(self.scheduler_path())}</string>\n  </dict>\n'
                f'  <key>StartInterval</key>\n  <integer>{INTERVAL_SECONDS}</integer>\n'
                f'  <key>RunAtLoad</key>\n  <true/>\n  <key>Nice</key>\n  <integer>10</integer>\n'
                f'  <key>StandardOutPath</key>\n  <string>{escape(str(log))}</string>\n'
                f'  <key>StandardErrorPath</key>\n  <string>{escape(str(log))}</string>\n</dict>\n</plist>\n')
        domain = f'gui/{os.getuid()}'
        loaded = subprocess.run(['launchctl', 'print', f'{domain}/{JOB}'], capture_output=True).returncode == 0
        written = self.write_owned(plist, text)
        if any(c.startswith(str(plist)) for c in self.conflicts):
            return
        if not log.parent.is_dir():
            # launchd cannot open the log in a missing folder, and the job would not start.
            self.change(f'create {log.parent} for the scheduled job log',
                        lambda: log.parent.mkdir(mode=0o700, parents=True, exist_ok=True))
        if written or not loaded:
            # bootout first so a rewritten job is reloaded; it fails harmlessly when not loaded.
            self.change(f'start launchd job {JOB} every {INTERVAL_SECONDS // 60} minutes', lambda: (
                subprocess.run(['launchctl', 'bootout', f'{domain}/{JOB}'], capture_output=True),
                subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)))

    def systemd(self, argv):
        units = self.home / '.config' / 'systemd' / 'user'
        service = f'# {MARKER}\n[Unit]\nDescription=agents-hub chat index and memory doctor\n\n' \
                  f'[Service]\nType=oneshot\nEnvironment="PATH={self.scheduler_path()}"\n' \
                  f'ExecStart={shlex.join(argv)}\n'
        timer = f'# {MARKER}\n[Unit]\nDescription=Run agents-hub every {INTERVAL_SECONDS // 60} minutes\n\n' \
                f'[Timer]\nOnBootSec=2min\nOnUnitActiveSec={INTERVAL_SECONDS}s\n\n[Install]\nWantedBy=timers.target\n'
        written = [self.write_owned(path, text) for path, text in
                   ((units / f'{JOB}.service', service), (units / f'{JOB}.timer', timer))]
        if any(c.startswith(str(units)) for c in self.conflicts):
            return
        active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', f'{JOB}.timer']).returncode == 0
        if any(written) or not active:
            self.change(f'start systemd user timer {JOB}.timer every {INTERVAL_SECONDS // 60} minutes', lambda: (
                subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True),
                subprocess.run(['systemctl', '--user', 'enable', '--now', f'{JOB}.timer'], check=True)))

    def cron(self, argv):
        line = (f'*/{INTERVAL_SECONDS // 60} * * * * PATH={shlex.quote(self.scheduler_path())} '
                f'{shlex.join(argv)} {CRON_MARK}')
        current = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
        lines = current.stdout.splitlines() if current.returncode == 0 else []
        if line in lines:
            return
        kept = [entry for entry in lines if CRON_MARK not in entry]  # other jobs stay untouched
        self.change('crontab entry every 15 minutes', lambda: subprocess.run(
            ['crontab', '-'], input='\n'.join(kept + [line]) + '\n', text=True, check=True))

    def backup_exclusions(self):
        if not self.host or platform.system() != 'Darwin' or not shutil.which('tmutil'):
            return
        for folder in ('chats', 'handoffs'):
            path = HUB / folder
            result = subprocess.run(['tmutil', 'isexcluded', str(path)], capture_output=True, text=True)
            if not path.is_dir() or '[Excluded]' not in result.stdout:
                self.change(f'exclude {path} from Time Machine (rebuildable)', lambda p=path: (
                    p.mkdir(exist_ok=True), subprocess.run(['tmutil', 'addexclusion', str(p)], check=True)))

    def run(self):
        for client in registry.load(HUB)['clients']:
            if registry.installed(self.home, client):
                self.history(client)
                self.rules(client)
                self.agents(client)
                self.local_shared(client)  # first, so hooks and permissions write through a hub copy
                self.hooks(client)
                self.permissions(client)
                self.local_shared(client)  # again, for a settings.json or hooks.json they just created
                self.shared_config(client)
                self.mcp(client)
        self.claude_memory()
        self.skill_dirs()
        self.cli()
        self.scheduler()
        self.backup_exclusions()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dry-run', action='store_true', help='Report changes without making them')
    parser.add_argument('--running-ok', action='store_true',
                        help='Move chat history and memory even while Claude or Codex is open')
    parser.add_argument('--home', type=Path, default=Path.home(),
                        help='Install into another home (testing); skips scheduler and backup settings')
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    installer = Installer(home, args.dry_run, host=home == Path.home().resolve(), running_ok=args.running_ok)
    installer.run()
    verb = 'Would change' if args.dry_run else 'Changed'
    print(f'{verb}: {len(installer.changes)}' + ''.join(f'\n  - {c}' for c in installer.changes))
    if installer.notes:
        print(f'Notes: {len(installer.notes)}' + ''.join(f'\n  - {n}' for n in installer.notes))
    if installer.conflicts:
        print(f'Conflicts: {len(installer.conflicts)}' + ''.join(f'\n  - {c}' for c in installer.conflicts))
        sys.exit(1)


if __name__ == '__main__':
    main()
