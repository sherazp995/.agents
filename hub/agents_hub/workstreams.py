"""Workstreams: one shared status record per piece of multi-session work, linked to many repos.

A record is one JSON file, replaced in a single rename under a per-workstream lock, so a crash
leaves either the old record or the new one. Every writer that changes the record passes the
revision it read; a stale revision changes nothing. The repos, revision and dates belong to
these functions: a caller supplies only the state text and its log notes.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from . import scope
from .links import tilde
from .locking import exclusive

STATE_LIMIT = 12_000  # bytes of state text; keeps what a session loads small
LOG_KEPT = 50         # log entries kept in the record; older ones move to the archive
SHOW_LOG = 10
STALE_DAYS = 7
ID_PATTERN = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
RECORD = 'record.json'
ARCHIVE = 'log-archive.jsonl'


class WorkstreamError(Exception):
    pass


class StaleRevision(WorkstreamError):
    def __init__(self, workstream_id, current):
        super().__init__(f'{workstream_id} is at revision {current}; run `agents-hub workstream show '
                         f'{workstream_id}`, merge your change into it, and retry with --revision {current}')
        self.current = current


def now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def folder(paths, workstream_id):
    if not ID_PATTERN.match(workstream_id or ''):
        raise WorkstreamError(f'Workstream id must be lowercase letters, digits and dashes: {workstream_id!r}')
    return paths.workstreams / workstream_id


def repo_key(paths, path):
    """The repo a path belongs to, written with ~: a linked worktree counts as its main repository."""
    return tilde(scope.project_root(Path(path).expanduser().resolve()), paths.home)


def _read(record_file):
    try:
        return json.loads(record_file.read_text())
    except ValueError as error:
        raise WorkstreamError(f'{tilde(record_file)} is unreadable ({error}); restore it from a backup') from error


def load(paths, workstream_id):
    record_file = folder(paths, workstream_id) / RECORD
    if not record_file.is_file():
        raise WorkstreamError(f'No workstream {workstream_id!r}; `agents-hub workstream list --all` shows them')
    return _read(record_file)


def records(paths):
    """Every readable record; an unreadable one is reported on stderr, not allowed to hide the rest."""
    if not paths.workstreams.is_dir():
        return []
    found = []
    for record_file in sorted(paths.workstreams.glob(f'*/{RECORD}')):
        try:
            found.append(_read(record_file))
        except WorkstreamError as error:
            print(f'agents-hub: {error}', file=sys.stderr)
    return found


def matching(paths, cwd):
    """Records linked to the repo cwd belongs to."""
    key = repo_key(paths, cwd)
    return [r for r in records(paths) if key in r['repos']]


def _save(directory, record):
    temporary = directory / f'{RECORD}.tmp'
    with open(temporary, 'w') as handle:
        json.dump(record, handle, indent=2, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, directory / RECORD)


def _archive(directory, entries):
    """Append entries before the record that drops them is saved: a crash may repeat one, never lose it."""
    with open(directory / ARCHIVE, 'a') as handle:
        handle.writelines(json.dumps(entry, ensure_ascii=False) + '\n' for entry in entries)
        handle.flush()
        os.fsync(handle.fileno())


def _entry(kind, author, session, note, source=None, verified=False, revision=None):
    return {'at': now(), 'kind': kind, 'author': author, 'session': session, 'source': source,
            'verified': verified, 'note': note, 'revision': revision}


def _commit(paths, workstream_id, expected, change):
    """Lock, check the revision (when expected is given), apply change(record), and save in one rename."""
    directory = folder(paths, workstream_id)
    with exclusive(directory / '.lock'):
        record = load(paths, workstream_id)
        if expected is not None and record['revision'] != expected:
            raise StaleRevision(workstream_id, record['revision'])
        change(record)
        overflow = record['log'][:-LOG_KEPT]
        if overflow:
            _archive(directory, overflow)
            record['log'] = record['log'][-LOG_KEPT:]
        _save(directory, record)
        return record


def create(paths, workstream_id, title, repos, keywords, author, session):
    directory = folder(paths, workstream_id)
    directory.mkdir(parents=True, exist_ok=True)
    with exclusive(directory / '.lock'):
        if (directory / RECORD).exists():
            raise WorkstreamError(f'Workstream {workstream_id!r} already exists')
        stamp = now()
        record = {'id': workstream_id, 'title': title, 'repos': sorted({repo_key(paths, r) for r in repos}),
                  'keywords': sorted(set(keywords)), 'revision': 1, 'created_at': stamp, 'updated_at': stamp,
                  'state_changed_at': stamp, 'state': '',
                  'log': [_entry('create', author, session, f'Created: {title}', revision=1)]}
        _save(directory, record)
        return record


def check_state(state):
    if not state.strip():
        raise WorkstreamError('State is empty; pass the whole current state, not nothing')
    size = len(state.encode())
    if size > STATE_LIMIT:
        raise WorkstreamError(f'State is {size} bytes, over the {STATE_LIMIT} byte limit; replace stale lines '
                              'instead of adding to them (the log keeps the history)')


def update(paths, workstream_id, revision, note, source, verified, author, session, state=None):
    """Add a log entry and, when state is given, replace the state. Every update bumps the revision.

    `state_changed_at` (what the staleness warning reads) moves when the state text changes, or when
    the same state is passed again as verified: a session that re-checked it can say it is current.
    """
    if state is not None:
        check_state(state)

    def change(record):
        record['revision'] += 1
        record['updated_at'] = now()
        if state is not None and (state != record['state'] or verified):
            record['state'] = state
            record['state_changed_at'] = record['updated_at']
        record['log'].append(_entry('update', author, session, note, source, verified, record['revision']))
    return _commit(paths, workstream_id, revision, change)


def link(paths, workstream_id, revision, repo, author, session):
    key = repo_key(paths, repo)

    def change(record):
        record['repos'] = sorted(set(record['repos']) | {key})
        record['revision'] += 1
        record['updated_at'] = now()
        record['log'].append(_entry('link', author, session, f'Linked {key}', revision=record['revision']))
    return _commit(paths, workstream_id, revision, change)


def skip(paths, workstream_id, reason, author, session):
    """Record that a session learned nothing new. State and revision stay as they are."""
    def change(record):
        record['log'].append(_entry('skip', author, session, reason, revision=record['revision']))
    return _commit(paths, workstream_id, None, change)


def age_days(stamp, at=None):
    at = at or datetime.now(timezone.utc)
    return (at - datetime.fromisoformat(stamp)).days


def summary_line(record):
    return (f"- {record['id']}: {record['title']} (revision {record['revision']}, "
            f"updated {record['updated_at'][:10]})")


def render(record, log_count=SHOW_LOG, at=None):
    lines = [f"# {record['title']} ({record['id']})",
             f"Revision: {record['revision']} · updated {record['updated_at']} · "
             f"state last changed {record['state_changed_at']}",
             'Repos: ' + ', '.join(record['repos'])]
    if record['keywords']:
        lines.append('Keywords: ' + ', '.join(record['keywords']))
    stale = age_days(record['state_changed_at'], at)
    if stale > STALE_DAYS:
        lines.append(f'WARNING: state not changed for {stale} days; check it before relying on it.')
    lines += ['', '## State', '', record['state'].strip() or '(empty)', '', f'## Recent log (last {log_count})', '']
    for entry in record['log'][-log_count:]:
        trust = 'verified' if entry['verified'] else 'reported'
        source = f" [{trust}: {entry['source']}]" if entry.get('source') else ''
        lines.append(f"- {entry['at'][:10]} {entry['kind']} by {entry['author']}{source}: {entry['note']}")
    return '\n'.join(lines) + '\n'


# Who is calling: the session id lets the Stop hook match this session's receipts.

def session_from_env():
    return os.environ.get('CLAUDE_CODE_SESSION_ID') or os.environ.get('CODEX_THREAD_ID') or None


def author_from_env():
    if os.environ.get('CLAUDECODE') or os.environ.get('CLAUDE_CODE_SESSION_ID'):
        return 'claude'
    if os.environ.get('CODEX_THREAD_ID'):
        return 'codex'
    return 'unknown'


def session_file_name(session):
    """A session id as one safe file name (no separators, never `.` or `..`); shared with the Stop hook."""
    return 's-' + re.sub(r'[^A-Za-z0-9_-]', '_', session)


def receipt_folders(paths):
    """Where receipts go: the hub, else the user's temp folder.

    A sandboxed agent (Codex in workspace-write) can run `show` but cannot write under ~/.agents;
    its sandbox can write the temp folder, which the hooks, running outside it, read too.
    """
    runtime = Path(os.environ.get('AGENTS_HUB_RUNTIME') or tempfile.gettempdir()) / f'agents-hub-{os.getuid()}'
    return [paths.workstreams / '.receipts', runtime / 'workstream-receipts']


def add_receipt(paths, session, kind, workstream_id, revision):
    """Written by the CLI only after a command succeeded; the Stop hook reads it.

    The command already did its work, so a receipt that cannot be written anywhere is only warned
    about: failing here would make a caller retry an update that already landed.
    """
    if not session:
        return
    line = json.dumps({'at': datetime.now(timezone.utc).isoformat(), 'kind': kind, 'id': workstream_id, 'revision': revision}) + '\n'
    errors = []
    for receipt_folder in receipt_folders(paths):
        try:
            receipt_folder.mkdir(parents=True, exist_ok=True)
            with open(receipt_folder / f'{session_file_name(session)}.jsonl', 'a') as handle:
                handle.write(line)
            return
        except OSError as error:
            errors.append(str(error))
    print(f'agents-hub: could not write the workstream receipt ({"; ".join(errors)}); the command itself '
          'succeeded', file=sys.stderr)


def receipts(paths, session):
    """This session's receipts from every receipt folder, oldest first."""
    found = []
    for receipt_folder in receipt_folders(paths):
        path = receipt_folder / f'{session_file_name(session)}.jsonl'
        if path.is_file():
            found += [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return sorted(found, key=lambda receipt: receipt['at'])
