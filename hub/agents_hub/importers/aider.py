"""aider history: one Markdown file, one section per run starting `# aider chat started at`."""
import re

from .base import ASSISTANT, USER, Session, Source

AGENT = 'aider'
VERSION = 1

START = re.compile(r'^# aider chat started at (.+?)\s*$', re.M)
THINKING = re.compile(r'<thinking-content-[0-9a-f]+>.*?</thinking-content-[0-9a-f]+>', re.S)


def _sections(text):
    starts = list(START.finditer(text))
    for i, match in enumerate(starts):
        end = starts[i + 1].start() if i + 1 < len(starts) else len(text)
        yield match.group(1), text[match.end():end]


def root(paths):
    return paths.aider_history


def discover(paths):
    file = paths.aider_history
    if not file.is_file():
        return
    for started, _body in _sections(file.read_text(errors='replace')):
        yield Source(f'aider-{re.sub(r"[^0-9]", "", started)}', (file,))


def parse(source):
    for started, body in _sections(source.files[0].read_text(errors='replace')):
        if f'aider-{re.sub(r"[^0-9]", "", started)}' != source.session_id:
            continue
        session = Session(source.session_id, started_at=started)
        role, buffer = None, []

        def flush():
            if role:
                session.add(role, '\n'.join(buffer))

        for line in THINKING.sub('', body).splitlines():
            if line.startswith('> '):
                continue  # aider's own command output and prompts
            next_role = USER if line.startswith('#### ') else ASSISTANT
            if next_role != role:
                flush()
                role, buffer = next_role, []
            buffer.append(line[5:] if next_role == USER else line)
        flush()
        session.title = next((m.text for m in session.messages if m.role == USER), None)
        return session
    raise ValueError(f'aider session not found: {source.session_id}')
