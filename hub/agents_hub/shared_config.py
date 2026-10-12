"""Codex settings every login shares: local/codex/config.shared.toml merged into each config.toml.

registry.toml `shared_config` lists the shared key paths. A listed table is merged one entry at a
time (each plugin, each marketplace), so a login's own extra entries stay its own.

Per login, CONFIG_STATE records each shared key as install.py last saw it matching the shared
file, and whether install.py wrote it there. That record decides every case:

- missing in the login: added (written).
- equal to the shared value: recorded, so a later change in the login is noticed.
- different and never recorded in this login: a conflict, never overwritten; make the login and
  the shared file match (either way) and the next run records it.
- different from the shared value but equal to the record: the shared file changed; updated.
- different from both: the login changed it (by hand, or the app itself, as Codex's /model
  does): a conflict, never overwritten.
- dropped from the shared file: removed only where install.py wrote it and it is unchanged.

install.py backs up config.toml before every write. CODEX_OWNED keys are ones Codex rewrites by
itself (timestamps, dismissed notices): never shared, compared, written or removed, even when
registry.toml lists them or an older shared file still has them.
"""
import copy
from dataclasses import dataclass, field

from . import tomledit

PATH = 'local/codex/config.shared.toml'
CODEX_OWNED = [('marketplaces', '*', 'last_updated'), ('tui', 'model_availability_nux'), ('notice',)]
CONFIG_STATE = 'agents-hub-config.json'
HEADER = (
    '# Codex settings shared by every Codex login on this machine. install.py merges them into each\n'
    "# login's config.toml; registry.toml `shared_config` lists which keys belong here. Edit them here,\n"
    '# not in a login. Not in git (machine-specific). MCP servers live in mcp/servers.json instead.\n\n')


def listed_paths(client):
    return [tuple(name.split('.')) for name in client.get('shared_config', [])]


def owned(path):
    """Whether Codex itself writes this key path (or a table above it), per CODEX_OWNED."""
    return any(len(path) >= len(pattern) and all(want in ('*', part) for want, part in zip(pattern, path))
               for pattern in CODEX_OWNED)


def strip(path, value):
    """value without its CODEX_OWNED keys."""
    if not isinstance(value, dict):
        return value
    return {name: strip(path + (name,), item) for name, item in value.items() if not owned(path + (name,))}


def restore(path, value, have):
    """value plus the CODEX_OWNED keys the login has under path, so writing it keeps them."""
    if not isinstance(value, dict) or not isinstance(have, dict):
        return value
    kept = {name: item for name, item in have.items() if name not in value and owned(path + (name,))}
    return {**{name: restore(path + (name,), item, have.get(name)) for name, item in value.items()}, **kept}


def units(shared, listed):
    """{key path: value} merged one by one: a listed scalar is one unit, a listed table one unit per
    entry. CODEX_OWNED keys are left out."""
    found = {}
    for path in listed:
        entry = tomledit.get_path(shared, path)
        if isinstance(entry, dict):
            found.update({path + (name,): item for name, item in entry.items()})
        elif entry is not None:
            found[path] = entry
    return {path: strip(path, value) for path, value in found.items() if not owned(path)}


def seed(source, listed):
    """The listed keys of a config, as the first shared file."""
    data = {}
    for path, value in units(source, listed).items():
        tomledit.set_path(data, path, value)
    return data


def unshared_keys(shared, listed):
    """Key paths in the shared file that registry.toml does not list as shared."""
    rest = copy.deepcopy(shared)
    for path in listed:
        parent = tomledit.get_path(rest, path[:-1])
        if isinstance(parent, dict):
            parent.pop(path[-1], None)
        tomledit.prune(rest, path[:-1])

    def leaves(table, prefix):
        for name, entry in table.items():
            yield from leaves(entry, prefix + (name,)) if isinstance(entry, dict) and entry else [prefix + (name,)]
    return [tomledit.path_text(path) for path in leaves(rest, ()) if not owned(path)]


@dataclass
class Record:
    value: object
    written: bool  # install.py put this value in the login (rather than finding it there)


def read_state(state):
    """{key path: Record} from CONFIG_STATE; entries from before `written` existed were all written.
    CODEX_OWNED keys recorded before they were dropped are forgotten, never removed."""
    records = {tuple(entry['key']): entry for entry in state.get('keys', [])}
    return {path: Record(strip(path, entry['value']), entry.get('written', True))
            for path, entry in records.items() if not owned(path)}


def state_entries(records):
    return [{'key': list(path), 'value': record.value, 'written': record.written} for path, record in records.items()]


@dataclass
class Merge:
    sets: dict = field(default_factory=dict)
    removes: list = field(default_factory=list)
    records: dict = field(default_factory=dict)
    changes: list = field(default_factory=list)
    conflicts: list = field(default_factory=list)
    notes: list = field(default_factory=list)


def merge(config, records, wanted):
    """What to change in one login's parsed config.toml (see the module docstring)."""
    result = Merge()
    for path, value in wanted.items():
        raw, record, name = tomledit.get_path(config, path), records.get(path), tomledit.path_text(path)
        have = strip(path, raw)
        if have == value:
            result.records[path] = Record(value, record.written if record else False)
        elif have is None:
            result.sets[path], result.records[path] = value, Record(value, True)
            result.changes.append(f'add {name}')
        elif record is None:
            result.conflicts.append(f'{name} is {tomledit.short(have)} here but {tomledit.short(value)} in {PATH}; '
                                    'make them match (keep either value), then rerun')
        elif record.value == have:
            result.sets[path], result.records[path] = restore(path, value, raw), Record(value, record.written)
            result.changes.append(f'set {name} = {tomledit.short(value)} (was {tomledit.short(have)})')
        else:
            result.records[path] = record
            result.conflicts.append(f'{name} was changed in this login (to {tomledit.short(have)}) since it matched '
                                    f'{PATH}; put the value you want there and make this login match, then rerun')
    for path, record in records.items():
        have = strip(path, tomledit.get_path(config, path))
        if path in wanted or have is None or not record.written:
            continue  # a key the login had itself is never removed
        if have == record.value:
            result.removes.append(path)
            result.changes.append(f'removed {tomledit.path_text(path)} (no longer in {PATH})')
        else:
            result.notes.append(f'left {tomledit.path_text(path)} alone: changed by hand since install.py wrote it')
    return result


def drift(config, wanted):
    """Shared key paths whose value in a parsed config.toml differs from the shared file."""
    return [tomledit.path_text(path) for path, value in wanted.items()
            if strip(path, tomledit.get_path(config, path)) != value]
