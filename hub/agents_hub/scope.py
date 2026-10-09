"""Map a working directory to a memory scope by exact match only.

A scope is one folder under memory/scopes/. Its name is the Claude project key
it came from, and its real path is recorded in a `.path` file. There is no
walk-up to parent folders: an unrelated project under home must never inherit
the home scope. Sharing a scope between paths needs an explicit alias in
registry.toml.
"""
import glob
import json
from pathlib import Path
import re
import subprocess
import tomllib

from .links import tilde

# Claude switches to a hashed folder name above this length; the hub refuses
# those paths until the user gives them an alias.
MAX_KEY_LENGTH = 200
PATH_FILE = '.path'


class ScopeError(Exception):
    pass


def claude_key(path):
    key = re.sub(r'[^A-Za-z0-9]', '-', str(path))
    if len(key) > MAX_KEY_LENGTH:
        raise ScopeError(f'Path too long for a scope key; add an alias in registry.toml: {path}')
    return key


def _git(cwd, *args):
    try:
        result = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def worktree_root(cwd):
    """The git top level of cwd (a linked worktree's own folder), else cwd."""
    return Path(_git(cwd, 'rev-parse', '--show-toplevel') or cwd)


def project_root(cwd):
    """The folder Claude keys memory by: the main repository for any worktree, else cwd.

    Claude uses the canonical working-copy root, so a linked worktree shares
    its main repository's memory.
    """
    common = _git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if common and Path(common).name == '.git':
        return Path(common).parent
    return worktree_root(cwd)


def aliases(paths):
    if not paths.registry.exists():
        return {}
    data = tomllib.loads(paths.registry.read_text())
    return {str(Path(a['path']).expanduser().resolve()): a['scope'] for a in data.get('aliases', [])}


def alias_for(paths, cwd, root, table=None):
    """An alias for the exact folder wins over one for its repository."""
    table = aliases(paths) if table is None else table
    return table.get(str(Path(cwd).resolve())) or table.get(str(root))


def recorded_path(paths, scope_dir):
    """The project folder that owns a scope, from its .path file (written with ~ for home)."""
    marker = scope_dir / PATH_FILE
    if not marker.exists():
        return None
    text, home = marker.read_text().strip(), paths.home.resolve()  # project roots are resolved paths
    return str(home / text[2:]) if text.startswith('~/') else str(home) if text == '~' else text


def record_path(paths, scope_dir, folder):
    """Write the owner of a scope, with ~ for the home folder (never the full home path)."""
    (scope_dir / PATH_FILE).write_text(f'{tilde(folder, paths.home)}\n')


def resolve(paths, cwd):
    """Return (key, root) for cwd. The scope folder may not exist yet."""
    root = project_root(cwd)
    alias = alias_for(paths, cwd, root)
    if alias:
        return alias, root
    key = claude_key(root)
    existing = recorded_path(paths, paths.scopes / key)
    if existing is not None and existing != str(root):
        raise ScopeError(f'Scope {key} belongs to {existing}, not {root}')
    return key, root


def ensure(paths, key, root):
    scope_dir = paths.scopes / key
    scope_dir.mkdir(parents=True, exist_ok=True)
    if recorded_path(paths, scope_dir) is None:
        record_path(paths, scope_dir, root)
    return scope_dir


def native_folder_key(paths, root):
    """The folder name Claude itself uses for root under projects/.

    Claude hashes names longer than MAX_KEY_LENGTH with an internal function, so
    for those paths the existing folder is found by the cwd its transcripts record.
    """
    key = re.sub(r'[^A-Za-z0-9]', '-', str(root))
    if len(key) <= MAX_KEY_LENGTH:
        return key
    prefix = key[:MAX_KEY_LENGTH]
    for folder in sorted(paths.claude_projects.glob(f'{glob.escape(prefix)}-*')):
        if transcript_cwd(folder) == str(root):
            return folder.name
    return None


def transcript_cwd(project_dir):
    """The cwd Claude recorded for a project folder, read from its transcripts."""
    for transcript in sorted(project_dir.glob('*.jsonl')):
        try:
            with open(transcript, errors='replace') as handle:
                for line in handle:
                    if '"cwd"' not in line:
                        continue
                    cwd = json.loads(line).get('cwd')
                    if cwd:
                        return cwd
        except (OSError, json.JSONDecodeError):
            continue
    return None


def chat_filter(paths, cwd):
    """(scope key, project paths that belong to it) for scoping chat reads.

    The paths matter because two different folders can sanitize to the same key
    (`a-b` and `a_b`); only this project and its explicit aliases share history.
    """
    key, root = resolve(paths, cwd)
    roots = {str(root)} | {path for path, alias in aliases(paths).items() if alias == key}
    owner = recorded_path(paths, paths.scopes / key)
    if owner:
        roots.add(owner)  # an alias shares history with the scope's own project too
    return key, tuple(sorted(roots))
