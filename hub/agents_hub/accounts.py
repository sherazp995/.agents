"""Extra logins (accounts) for the clients whose registry entry has `account_links`.

The first login (~/.claude, ~/.codex) is the client's only registry profile and links its
rules into ~/.agents. An extra account is a folder of its own login files (.claude.json,
auth.json, ...) whose shared entries are relative links to the first login's entries, so
they reach ~/.agents in two hops. Extra accounts are machine-local, listed in
~/.agents/accounts.toml.
"""
import json
import os
from pathlib import Path
import re
import shutil

from . import links, registry

ALIAS = re.compile(r'[A-Za-z0-9_-]+')
MARK = '# agents-hub account'
STARTUP = {'zsh': '.zshrc', 'bash': '.bashrc'}
# Every startup file an alias or function could already be defined in.
SHELL_FILES = ('.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.bash_aliases', '.profile')
UNSAFE_IN_ALIAS = set('\'"$`\\')


class AccountError(Exception):
    pass


def tilde(home, path):
    return links.tilde(path, home)


def link_state(path, target):
    """'ok', 'missing', 'full' (a full-path link to target, to rewrite relative) or 'conflict'."""
    if path.is_symlink():
        current = Path(os.readlink(path))
        if current.is_absolute() and current.parent.resolve() / current.name == target.parent.resolve() / target.name:
            return 'full'
        try:
            return 'ok' if path.resolve() == target.resolve() else 'conflict'
        except (OSError, RuntimeError):  # a link loop
            return 'conflict'
    return 'conflict' if path.exists() else 'missing'


def write_link(path, target):
    """Create path, or replace it in one rename, as a relative link to target."""
    links.write_relative_link(path, target)


def plan(primary, folder, client):
    """[(path, target, state)] for each shared entry of one account."""
    return [(folder / entry, primary / entry, link_state(folder / entry, primary / entry))
            for entry in client['account_links']]


def account_clients(home):
    return {c['name']: c for c in registry.load(home / '.agents')['clients'] if c.get('account_links')}


def client_for(home, name):
    clients = account_clients(home)
    if name not in clients:
        raise AccountError(f'{name} has no accounts; choose one of: {", ".join(sorted(clients))}')
    client = clients[name]
    return client, registry.expand(home, client['profiles'][0])


def save(home, entries):
    """Rewrite accounts.toml in one rename."""
    text = '# Extra logins on this machine, managed by `agents-hub account`. Not in git.\n'
    for entry in entries:
        # A JSON string is a valid TOML basic string.
        text += (f'\n[[accounts]]\nclient = {json.dumps(entry["client"])}\n'
                 f'alias = {json.dumps(entry["alias"])}\ndir = {json.dumps(entry["dir"])}\n')
    path = registry.accounts_file(home)
    temporary = path.with_name(path.name + '.agents-hub-tmp')
    temporary.write_text(text)
    os.replace(temporary, path)


# shell aliases

def startup_file(home):
    name = STARTUP.get(Path(os.environ.get('SHELL', '')).name)
    return home / name if name else None


def alias_line(home, client, alias, folder):
    where = f'$HOME/{folder.relative_to(home)}' if folder.is_relative_to(home) else str(folder)
    return f"alias {alias}='{client['account_env']}=\"{where}\" {client['account_command']}'  {MARK}"


def has_alias(text, alias):
    return re.search(rf'^\s*alias\s+{re.escape(alias)}=', text, re.MULTILINE) is not None


def defines(text, name):
    """Whether shell text defines name as an alias or a function."""
    function = rf'^\s*(function\s+{re.escape(name)}\b|{re.escape(name)}\s*\(\s*\))'
    return has_alias(text, name) or re.search(function, text, re.MULTILINE) is not None


def name_in_use(home, alias):
    """Why alias cannot be used: an app's command, a command on PATH, or a shell alias or function."""
    commands = {c['account_command'] for c in registry.load(home / '.agents')['clients'] if c.get('account_command')}
    if alias in commands:
        return f'{alias} is an app command'
    found = shutil.which(alias)
    if found:
        return f'{alias} is already a command ({tilde(home, Path(found))})'
    for name in SHELL_FILES:
        path = home / name
        if path.is_file() and defines(path.read_text(errors='replace'), alias):
            return f'{alias} is already an alias or function in {tilde(home, path)}'
    return None


def is_marked(line, alias):
    return re.match(rf'\s*alias\s+{re.escape(alias)}=', line) is not None and line.rstrip().endswith(MARK)


def add_alias(home, client, alias, folder):
    line = alias_line(home, client, alias, folder)
    startup = startup_file(home)
    if startup is None:
        return [f'Add this line to your shell startup file:\n  {line}']
    text = startup.read_text() if startup.exists() else ''
    if has_alias(text, alias):
        return [f'kept the existing alias {alias} in {tilde(home, startup)}']
    with startup.open('a') as handle:
        handle.write(('' if not text or text.endswith('\n') else '\n') + line + '\n')
    return [f'added alias {alias} to {tilde(home, startup)}']


def remove_alias(home, alias):
    startup = startup_file(home)
    if startup is None:
        return [f'remove the alias {alias} from your shell startup file yourself']
    if not startup.exists():
        return []
    lines = startup.read_text().splitlines(keepends=True)
    kept = [line for line in lines if not is_marked(line, alias)]
    out = []
    if len(kept) != len(lines):
        real = startup.resolve()  # a dotfiles symlink keeps pointing at its file
        temporary = real.with_name(real.name + '.agents-hub-tmp')
        temporary.write_text(''.join(kept))
        shutil.copymode(real, temporary)
        os.replace(temporary, real)
        out.append(f'removed alias {alias} from {tilde(home, startup)}')
    if has_alias(''.join(kept), alias):
        out.append(f'left alias {alias} in {tilde(home, startup)} (not written by agents-hub); remove it yourself')
    return out


# commands

def add(home, client_name, alias, folder=None):
    client, primary = client_for(home, client_name)
    if not ALIAS.fullmatch(alias):
        raise AccountError(f'alias {alias!r} may use only letters, digits, _ and -')
    folder = Path(os.path.normpath(Path(folder).expanduser().absolute())) if folder else home / f'.{alias}'
    if folder == primary or folder.resolve() == primary.resolve():
        raise AccountError(f'{tilde(home, folder)} is the first login; pick another folder')
    if UNSAFE_IN_ALIAS & set(str(folder)):
        raise AccountError(f'{folder} has a quote, $, ` or \\; pick a plainer folder name')
    if folder.exists() and not folder.is_dir():
        raise AccountError(f'{tilde(home, folder)} exists and is not a folder')
    wanted = {'client': client_name, 'alias': alias, 'dir': tilde(home, folder)}
    entries = registry.accounts(home)
    for entry in entries:
        clash = entry['alias'] == alias or registry.expand(home, entry['dir']).resolve() == folder.resolve()
        if clash and entry != wanted:
            raise AccountError(f"alias {alias} or folder {wanted['dir']} is already account "
                               f"{entry['client']} {entry['alias']} ({entry['dir']})")
    if wanted not in entries:  # adding the same account again stays a no-op
        in_use = name_in_use(home, alias)
        if in_use:
            raise AccountError(f'{in_use}; pick another alias')
    links = plan(primary, folder, client)
    conflicts = [f'conflict: {tilde(home, path)} exists and is not a link to {tilde(home, target)}; '
                 f'move it aside, then rerun' for path, target, state in links if state == 'conflict']
    if conflicts:
        raise AccountError('\n'.join(conflicts))
    out = []
    if not folder.is_dir():
        folder.mkdir(parents=True)
        out.append(f'created {wanted["dir"]}')
    for path, target, state in links:
        if state != 'ok':
            write_link(path, target)
            out.append(f'linked {tilde(home, path)} -> {os.readlink(path)}')
    if wanted not in entries:
        save(home, entries + [wanted])
        out.append(f'recorded {client_name} account {alias} in ~/.agents/accounts.toml')
    out += add_alias(home, client, alias, folder)
    out.append(f'Next: open a new shell, run `{alias}` and sign in.')
    return out


def remove(home, client_name, alias):
    client, primary = client_for(home, client_name)
    entries = registry.accounts(home)
    match = [e for e in entries if e['client'] == client_name and e['alias'] == alias]
    if not match:
        raise AccountError(f'no {client_name} account named {alias}; see `agents-hub account list`')
    folder = registry.expand(home, match[0]['dir'])
    shared = [path for path, _target, state in plan(primary, folder, client) if state in ('ok', 'full')]
    for path in shared:
        path.unlink()
    out = [f'removed {len(shared)} shared links from {match[0]["dir"]}']
    out += remove_alias(home, alias)
    save(home, [e for e in entries if e not in match])
    out.append(f'removed {client_name} account {alias} from ~/.agents/accounts.toml')
    left = sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []
    out.append(f'kept {match[0]["dir"]}' + (f' with: {", ".join(left)}' if left else ' (empty)')
               + '; delete it yourself when the login is no longer needed')
    return out


def listing(home):
    startup = startup_file(home)
    aliases = startup.read_text() if startup and startup.exists() else ''
    entries = registry.accounts(home)
    out = []
    for name, client in sorted(account_clients(home).items()):
        primary = registry.expand(home, client['profiles'][0])
        out.append(f'{name}: {tilde(home, primary)} (first login)')
        mine = [e for e in entries if e['client'] == name]
        for entry in mine:
            folder = registry.expand(home, entry['dir'])
            broken = [p.name for p, _t, state in plan(primary, folder, client) if state in ('missing', 'conflict')]
            status = ('folder missing' if not folder.is_dir()
                      else f'broken: {", ".join(broken)}' if broken else 'links ok')
            if startup and not has_alias(aliases, entry['alias']):
                status += ', missing alias'
            out.append(f'  {entry["alias"]}  {entry["dir"]}  {status}')
        if not mine:
            out.append('  no extra accounts')
    return out
