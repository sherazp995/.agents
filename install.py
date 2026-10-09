#!/usr/bin/env python3
"""Wire this machine's coding agents to ~/.agents. Safe to run again at any time.

    python3 ~/.agents/install.py            # apply
    python3 ~/.agents/install.py --dry-run  # show what would change

It never overwrites: anything in the way (a real file where a link belongs, a
link pointing elsewhere, a config it cannot merge) is reported as a conflict for
you to resolve, and the run exits 1. Clients that are not installed are skipped.
What it sets up is listed in README.md; which clients exist is in registry.toml.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import sys
from xml.sax.saxutils import escape

HUB = Path(__file__).resolve().parent
sys.path.insert(0, str(HUB / 'hub'))

from agents_hub import interpreter  # noqa: E402

interpreter.ensure(str(Path(__file__).resolve()))

from agents_hub import accounts, memory, registry, relocate, scope, wiring  # noqa: E402
from agents_hub.paths import Paths  # noqa: E402
from agents_hub.wiring import MARKER, is_provision_hook  # noqa: E402,F401

JOB = 'agents-hub.index'
CRON_MARK = '# agents-hub scheduled job'
INTERVAL_SECONDS = 900
PROVISION_TIMEOUT = 20
HOOK_CONFIG = {'claude': 'settings.json', 'codex': 'hooks.json'}


def write_json(path, data):
    """Replace a JSON file in one rename, through a symlink to its real location, keeping its mode."""
    real = path.resolve()
    real.parent.mkdir(parents=True, exist_ok=True)
    temporary = real.with_name(real.name + '.agents-hub-tmp')
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    if real.exists():
        shutil.copymode(real, temporary)
    os.replace(temporary, real)


class Installer:
    def __init__(self, home, dry_run, host, running_ok=False):
        self.home, self.dry_run, self.host, self.running_ok = home, dry_run, host, running_ok
        self.changes, self.conflicts, self.notes = [], [], []
        self._running = None

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
        into_hub = target.resolve().is_relative_to(HUB.resolve())
        written = os.path.relpath(target, path.parent.resolve()) if into_hub and path.parent.exists() else str(target)
        if path.is_symlink() and path.resolve() == target.resolve():
            current = os.readlink(path)
            if not (os.path.isabs(current) and Path(current).is_relative_to(HUB)):
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
            path.symlink_to(os.path.relpath(target, path.parent.resolve()) if into_hub else target)
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
                self.hooks(client)
        self.claude_memory()
        self.skill_dirs()
        self.cli()
        self.scheduler()
        self.backup_exclusions()
        if (HUB / 'plugins' / 'ponytail').is_dir():
            self.link(self.home / '.config' / 'ponytail' / 'config.json', HUB / 'ponytail.json')
        else:
            # Normal on a new machine: README has the install run first, then update-ponytail.sh.
            self.notes.append('Ponytail is not installed yet; run ./update-ponytail.sh (needs network and git)')


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
