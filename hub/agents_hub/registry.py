"""registry.toml: which clients exist on this machine and where their profiles live."""
from pathlib import Path
import shutil
import tomllib


def expand(home, text):
    """A registry path relative to the given home directory, not the current user's."""
    if text == '~':
        return home
    return home / text[2:] if text.startswith('~/') else Path(text)


def load(hub):
    return tomllib.loads((hub / 'registry.toml').read_text())


def installed(home, client):
    """A client is installed when any `detect` path exists or command is on PATH."""
    return any(expand(home, item).exists() if item.startswith('~') else shutil.which(item)
               for item in client.get('detect', []))


def accounts_file(home):
    """Machine-local extra logins, written by `agents-hub account`; not in git."""
    return home / '.agents' / 'accounts.toml'


def accounts(home):
    """Every [[accounts]] entry: {client, alias, dir}, dir written with ~."""
    path = accounts_file(home)
    return tomllib.loads(path.read_text()).get('accounts', []) if path.exists() else []


def profiles(home, client):
    """(first login, extra accounts from accounts.toml whose folder exists) for an installed client."""
    primary = expand(home, client['profiles'][0])
    if not client.get('account_links'):
        return primary, []
    extras = [expand(home, a['dir']) for a in accounts(home) if a['client'] == client['name']]
    return primary, [p for p in extras if p.is_dir()]
