"""Codex rollouts: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl (shared by both profiles)."""

from .base import ASSISTANT, TOOL, USER, Session, Source, jsonl_records, tool_line

AGENT = 'codex'
VERSION = 1

# Codex injects these as user-role messages; they are context, not something the user typed.
INJECTED_PREFIXES = ('<environment_context', '<user_instructions', '<skills_instructions',
                     '# AGENTS.md instructions', '<permissions', '<collaboration_mode', '<turn_aborted')


def root(paths):
    return paths.codex_sessions


def discover(paths):
    if not paths.codex_sessions.is_dir():
        return
    for file in sorted(paths.codex_sessions.rglob('rollout-*.jsonl')):
        yield Source(file.stem[-36:], (file,))


def _texts(content):
    return [item.get('text', '') for item in content or []
            if isinstance(item, dict) and item.get('type') in ('input_text', 'output_text', 'text')]


def parse(source):
    session = Session(source.session_id)
    for record in jsonl_records(source.files[0]):
        payload = record.get('payload') or {}
        ts = record.get('timestamp')
        if record.get('type') == 'session_meta':
            session.cwd = payload.get('cwd')
            session.started_at = payload.get('timestamp') or ts
            session.parent_session_id = payload.get('parent_thread_id')
            continue
        if record.get('type') != 'response_item':
            continue
        kind = payload.get('type')
        if kind == 'message' and payload.get('role') in (USER, ASSISTANT):
            for text in _texts(payload.get('content')):
                if payload['role'] == USER and text.lstrip().startswith(INJECTED_PREFIXES):
                    continue
                session.add(payload['role'], text, ts)
                if payload['role'] == USER and not session.title:
                    session.title = text  # index._store redacts, then clips
        elif kind in ('function_call', 'custom_tool_call'):
            session.add(TOOL, tool_line(payload.get('name', 'tool'),
                                        payload.get('arguments') or payload.get('input') or ''), ts)
    return session
