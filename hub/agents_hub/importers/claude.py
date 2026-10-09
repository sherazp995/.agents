"""Claude Code transcripts: projects/<key>/<session>.jsonl plus nested subagent files."""
import re

from .base import ASSISTANT, TOOL, USER, Session, Source, jsonl_records, tool_line

AGENT = 'claude'
VERSION = 2

REMINDER = re.compile(r'<system-reminder>.*?</system-reminder>', re.S)
TOOL_TARGET_KEYS = ('command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill')


def root(paths):
    return paths.claude_projects


def discover(paths):
    root = paths.claude_projects
    if not root.is_dir():
        return
    for file in sorted(root.rglob('*.jsonl')):
        relative = file.relative_to(root).parts
        if len(relative) == 2:
            yield Source(file.stem, (file,))
        elif 'subagents' in relative:
            # projects/<key>/<parent>/subagents/[workflows/<id>/]<agent>.jsonl; the same agent
            # file name can appear under several workflows, so the whole sub-path is the id.
            parent = relative[1]
            nested = '/'.join(relative[3:])[:-len('.jsonl')]
            yield Source(f'{parent}/{nested}', (file,))


def _target(tool_input):
    if not isinstance(tool_input, dict):
        return ''
    for key in TOOL_TARGET_KEYS:
        if tool_input.get(key):
            return tool_input[key]
    return ''


def _user_text(content):
    if isinstance(content, str):
        return REMINDER.sub('', content)
    texts = [block.get('text', '') for block in content or []
             if isinstance(block, dict) and block.get('type') == 'text']
    return REMINDER.sub('', '\n'.join(texts))


def parse(source):
    session_id = source.session_id
    parent = session_id.split('/')[0] if '/' in session_id else None
    session = Session(session_id, parent_session_id=parent)
    for record in jsonl_records(source.files[0]):
        kind = record.get('type')
        if kind == 'ai-title':
            session.title = record.get('aiTitle')
            continue
        if kind not in ('user', 'assistant') or record.get('isMeta'):
            continue
        session.cwd = session.cwd or record.get('cwd')
        session.started_at = session.started_at or record.get('timestamp')
        ts = record.get('timestamp')
        content = (record.get('message') or {}).get('content')
        if kind == 'user':
            session.add(USER, _user_text(content), ts)
            continue
        for block in content if isinstance(content, list) else []:
            if block.get('type') == 'text':
                session.add(ASSISTANT, block.get('text'), ts)
            elif block.get('type') == 'tool_use':
                session.add(TOOL, tool_line(block.get('name', 'tool'), _target(block.get('input'))), ts)
    return session
