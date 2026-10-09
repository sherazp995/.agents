"""OpenCode storage: session/<project>/<ses>.json, message/<ses>/*.json, part/<msg>/*.json."""
import json

from .base import ASSISTANT, TOOL, USER, Session, Source, millis_to_iso, tool_line

AGENT = 'opencode'
VERSION = 1


def _load(file):
    # A malformed file raises, so the run reports it instead of storing a partial session.
    return json.loads(file.read_text(errors='replace'))


def root(paths):
    return paths.opencode_storage / 'session'


def discover(paths):
    root = paths.opencode_storage
    if not (root / 'session').is_dir():
        return
    for session_file in sorted((root / 'session').glob('*/*.json')):
        session_id = session_file.stem
        messages = sorted((root / 'message' / session_id).glob('*.json'))
        parts = sorted(p for m in messages for p in (root / 'part' / m.stem).glob('*.json'))
        # Every dependent file is in the fingerprint, so a new part re-imports the session.
        yield Source(session_id, (session_file, *messages, *parts))


def parse(source):
    meta = _load(source.files[0])
    session = Session(source.session_id, cwd=meta.get('directory'), title=meta.get('title'),
                      started_at=millis_to_iso((meta.get('time') or {}).get('created')),
                      parent_session_id=meta.get('parentID'))
    messages = [m for m in (_load(f) for f in source.files[1:] if '/message/' in str(f)) if m]
    parts = {}
    for file in source.files[1:]:
        if '/part/' in str(file):
            part = _load(file)
            parts.setdefault(part.get('messageID'), []).append(part)
    for message in sorted(messages, key=lambda m: (m.get('time') or {}).get('created', 0)):
        role = message.get('role')
        ts = millis_to_iso((message.get('time') or {}).get('created'))
        for part in sorted(parts.get(message.get('id'), []), key=lambda p: p.get('id', '')):
            if part.get('type') == 'text' and role in (USER, ASSISTANT) and not part.get('synthetic'):
                session.add(role, part.get('text'), ts)
            elif part.get('type') == 'tool':
                tool_input = (part.get('state') or {}).get('input') or {}
                target = tool_input.get('command') or tool_input.get('filePath') or tool_input.get('pattern') or ''
                session.add(TOOL, tool_line(part.get('tool', 'tool'), target), ts)
    return session
