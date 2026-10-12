"""Line-based edits of a TOML file (Codex config.toml) that keep every other line and comment.

A key path is a tuple of keys: ('model',), ('plugins', 'warp@codex-warp'). edit() changes only
the lines of the paths it is given and returns None when the result would not read back as
exactly the intended config (a key in an inline table or a multi-line value, say): such a file is
left for the user, never guessed at.
"""
import copy
import json
import re
import tomllib

KEY_PART = r'''(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)'''
KEY_LINE = re.compile(rf'\s*({KEY_PART}(?:\s*\.\s*{KEY_PART})*)\s*=')


def key(name):
    return name if re.fullmatch(r'[A-Za-z0-9_-]+', name) else json.dumps(name, ensure_ascii=False)


def value(data):
    if isinstance(data, bool):
        return 'true' if data else 'false'
    if isinstance(data, (int, float)):
        return str(data)
    if isinstance(data, str):
        return json.dumps(data, ensure_ascii=False)  # JSON string escapes are valid TOML ones
    if isinstance(data, list):
        return '[' + ', '.join(value(v) for v in data) + ']'
    if isinstance(data, dict):
        return '{ ' + ', '.join(f'{key(k)} = {value(v)}' for k, v in data.items()) + ' }' if data else '{}'
    raise ValueError(f'cannot write {data!r} as TOML')


def short(data):
    text = value(data)
    return text if len(text) <= 60 else text[:57] + '...'


def path_text(path):
    """A key path as TOML writes it: model, plugins."warp@codex-warp"."""
    return '.'.join(key(part) for part in path)


def get_path(data, path):
    """The value at a key path, or None when it is missing (TOML has no null)."""
    for part in path:
        if not isinstance(data, dict) or part not in data:
            return None
        data = data[part]
    return data


def set_path(data, path, new):
    for part in path[:-1]:
        data = data.setdefault(part, {})
    data[path[-1]] = copy.deepcopy(new)


def prune(data, path):
    """Drop the tables along path that became empty, innermost first."""
    for depth in range(len(path), 0, -1):
        parent = get_path(data, path[:depth - 1])
        if isinstance(parent, dict) and parent.get(path[depth - 1]) == {}:
            del parent[path[depth - 1]]


def _single_path(parsed):
    path = []
    while isinstance(parsed, dict) and len(parsed) == 1:
        name = next(iter(parsed))
        path.append(name)
        parsed = parsed[name]
    return tuple(path)


def header(line):
    """The key path of a `[table]` header line, or None for any other line."""
    stripped = line.strip()
    if not stripped.startswith('[') or stripped.startswith('[['):
        return None
    try:
        return _single_path(tomllib.loads(stripped + '\n'))
    except tomllib.TOMLDecodeError:
        return None


def line_key(line):
    """The key path of a `key = value` line, or None for any other line."""
    match = KEY_LINE.match(line)
    if not match:
        return None
    try:
        return _single_path(tomllib.loads(match.group(1) + ' = 0\n'))
    except tomllib.TOMLDecodeError:
        return None


def block_end(lines, start):
    """One past the last key line of the table whose header is lines[start] (-1: the top level)."""
    end = start + 1
    for index in range(start + 1, len(lines)):
        stripped = lines[index].strip()
        if stripped.startswith('['):
            break
        if stripped and not stripped.startswith('#'):
            end = index + 1
    return end


def region(lines, table):
    """(first, end) indexes of the key lines of `table` (() is the top level), or None when the file
    has no [table] header."""
    if not table:
        return 0, block_end(lines, -1)
    start = next((i for i, line in enumerate(lines) if header(line) == table), None)
    return None if start is None else (start + 1, block_end(lines, start))


def key_line(lines, path):
    found = region(lines, path[:-1])
    return next((i for i in range(*found) if line_key(lines[i]) == path[-1:]), None) if found else None


def tables_under(lines, path):
    """Indexes of the [header] lines of path and its subtables."""
    return [i for i, line in enumerate(lines) if (header(line) or ())[:len(path)] == path]


def remove_tables(lines, path):
    """Delete path's [table] blocks and its subtables', with the blank lines after each."""
    for start in reversed(tables_under(lines, path)):
        end = block_end(lines, start)
        while end < len(lines) and not lines[end].strip():
            end += 1
        del lines[start:end]


def insert_block(lines, table, block):
    """Add block after the last block under `table`, so a new [table.x] lands next to its siblings."""
    starts = tables_under(lines, table)
    at = block_end(lines, starts[-1]) if starts else len(lines)
    lines[at:at] = (['\n'] if at and lines[at - 1].strip() else []) + block


def edit(text, sets, removes):
    """text with the key paths in `sets` set and those in `removes` removed, every other line kept as
    it is; None when the edit would not read back as exactly the intended config.

    A table value is written as its own [path] block. Its existing subtables ([path.x] blocks) stay,
    unless the value has an `x` of its own (Codex keeps a server's tools approvals that way).
    """
    original = tomllib.loads(text)
    lines = text.splitlines(keepends=True)
    if lines and not lines[-1].endswith('\n'):
        lines[-1] += '\n'
    expected = copy.deepcopy(original)
    for path in removes:
        if isinstance(get_path(original, path), dict):
            remove_tables(lines, path)
        elif (index := key_line(lines, path)) is not None:
            del lines[index]
        parent = get_path(expected, path[:-1])
        if isinstance(parent, dict):
            parent.pop(path[-1], None)
    for path, new in sets.items():
        if isinstance(new, dict):
            for name in new:
                remove_tables(lines, path + (name,))
            block = [f'[{path_text(path)}]\n'] + [f'{key(k)} = {value(v)}\n' for k, v in new.items()]
            start = next((i for i, line in enumerate(lines) if header(line) == path), None)
            if start is None:
                insert_block(lines, path[:-1], block)
            else:
                lines[start:block_end(lines, start)] = block
            before = get_path(original, path)
            kept = {k: v for k, v in before.items() if k not in new and tables_under(lines, path + (k,))} \
                if isinstance(before, dict) else {}
            set_path(expected, path, {**new, **kept})
            continue
        line = f'{key(path[-1])} = {value(new)}\n'
        index, found = key_line(lines, path), region(lines, path[:-1])
        if index is not None:
            lines[index] = line
        elif found:
            lines.insert(found[1], line)
        else:
            insert_block(lines, path[:-2], [f'[{path_text(path[:-1])}]\n', line])
        set_path(expected, path, new)
    edited = ''.join(lines)
    try:
        result = tomllib.loads(edited)
    except tomllib.TOMLDecodeError:
        return None
    for path in removes:  # a table left empty may keep its header or lose it; both are fine
        for config in (expected, result):
            prune(config, path[:-1])
    return edited if result == expected else None


def dumps(data):
    """TOML text for plain data: top-level keys first, then one [table] block per table."""
    lines = [f'{key(k)} = {value(v)}\n' for k, v in data.items() if not isinstance(v, dict)]

    def tables(table, prefix):
        for name, entry in table.items():
            if not isinstance(entry, dict):
                continue
            path, scalars = prefix + (name,), {k: v for k, v in entry.items() if not isinstance(v, dict)}
            if scalars or not entry:
                lines.extend(['\n' if lines else '', f'[{path_text(path)}]\n'])
                lines.extend(f'{key(k)} = {value(v)}\n' for k, v in scalars.items())
            tables(entry, path)
    tables(data, ())
    return ''.join(lines)
