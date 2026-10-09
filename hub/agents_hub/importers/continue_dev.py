"""Continue sessions: ~/.continue/sessions/<id>.json (sessions.json is only an index)."""
import json

from .base import ASSISTANT, USER, Session, Source

AGENT = 'continue'
VERSION = 1


def root(paths):
    return paths.continue_sessions


def discover(paths):
    if not paths.continue_sessions.is_dir():
        return
    for file in sorted(paths.continue_sessions.glob('*.json')):
        if file.name != 'sessions.json':
            yield Source(file.stem, (file,))


def _text(content):
    if isinstance(content, str):
        return content
    return '\n'.join(item.get('text', '') for item in content or []
                     if isinstance(item, dict) and item.get('type') == 'text')


def parse(source):
    data = json.loads(source.files[0].read_text(errors='replace'))
    workspace = data.get('workspaceDirectory') or None
    if workspace and workspace.startswith('file://'):
        workspace = workspace[len('file://'):]
    session = Session(source.session_id, cwd=workspace, title=data.get('title'))
    for item in data.get('history') or []:
        message = item.get('message') or {}
        if message.get('role') in (USER, ASSISTANT):
            session.add(message['role'], _text(message.get('content')))
    return session
