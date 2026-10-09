"""Write a short brief of one indexed session for another agent to pick up."""
from datetime import datetime, timedelta, timezone
import re

from . import index
from .importers.base import ASSISTANT, TOOL, USER

RETENTION_DAYS = 30
FILE_PATTERN = re.compile(r'(?:~|/)[\w./\-]+\.[A-Za-z0-9]{1,6}\b')


def prune(paths):
    if not paths.handoffs.is_dir():
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).timestamp()
    for file in paths.handoffs.glob('*.md'):
        if file.stat().st_mtime < cutoff:
            file.unlink()


def _clip(text, limit):
    text = ' '.join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + '…'


def build(paths, agent, session_id, scope_filter=None):
    meta, rows = index.messages(paths, agent, session_id, scope_filter)
    _agent, _sid, scope_key, started_at, cwd, title = meta
    users = [text for role, text in rows if role == USER]
    replies = [text for role, text in rows if role == ASSISTANT]
    tools = [text for role, text in rows if role == TOOL]
    files = sorted({m for text in tools + replies for m in FILE_PATTERN.findall(text)})[:30]
    lines = [
        f'# Handoff: {title or session_id}',
        '',
        f'Source: {agent} session `{session_id}`, scope `{scope_key}`, cwd `{cwd}`, started {started_at}.',
        f'Full transcript: `agents-hub read {agent} {session_id}`.',
        '',
        '## Goal (first request)',
        _clip(users[0], 1500) if users else '(none)',
        '',
        '## Later requests',
        *[f'- {_clip(text, 300)}' for text in users[1:][-8:]],
        '',
        '## Files touched or named',
        *[f'- `{f}`' for f in files],
        '',
        '## Where it ended (last reply)',
        _clip(replies[-1], 2500) if replies else '(none)',
    ]
    body = '\n'.join(lines)
    return '\n'.join([index.ENVELOPE_NOTE, index.envelope((agent, session_id, scope_key, started_at), body)]) + '\n'


def write(paths, agent, session_id, scope_filter=None):
    prune(paths)
    paths.handoffs.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = paths.handoffs / f'{stamp}-{agent}-{session_id.replace("/", "_")}.md'
    target.write_text(build(paths, agent, session_id, scope_filter))
    target.chmod(0o600)
    return target
