"""Shared shapes for importers.

Each importer module defines AGENT, VERSION, root(paths), discover(paths) and parse(source).
root() is the folder or file whose absence means "agent not installed", not "sessions deleted".
Bump an importer's VERSION whenever its parsing changes; its sessions are then
re-imported on the next index run.
"""
from dataclasses import dataclass, field
import json
from datetime import datetime, timezone

from .. import redact

USER = 'user'
ASSISTANT = 'assistant'
TOOL = 'tool'


@dataclass(frozen=True)
class Source:
    session_id: str
    files: tuple

    def fingerprint(self):
        parts = []
        for file in self.files:
            stat = file.stat()
            parts.append(f'{file}:{stat.st_mtime_ns}:{stat.st_size}')
        return '|'.join(parts)


@dataclass
class Message:
    role: str
    text: str
    ts: str = None


@dataclass
class Session:
    session_id: str
    cwd: str = None
    title: str = None
    started_at: str = None
    parent_session_id: str = None
    profile: str = None
    messages: list = field(default_factory=list)

    def add(self, role, text, ts=None):
        text = (text or '').strip()
        if text:
            self.messages.append(Message(role, text, ts))


def tool_line(name, target=''):
    # Redact before clipping: a cut can remove the delimiter a secret pattern needs.
    target = ' '.join(redact.redact(str(target)).split())[:160]
    return f'[tool] {name} {target}'.strip()


def jsonl_records(path):
    """Parsed records of a JSONL transcript.

    An unfinished last line (a live session mid-write) is skipped; any other
    malformed line raises, so the run reports a failure instead of storing a
    silently truncated session.
    """
    with open(path, 'rb') as handle:
        data = handle.read()
    lines = data.split(b'\n')
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError as error:
            if number == len(lines) and not data.endswith(b'\n'):
                return
            raise ValueError(f'{path.name}: malformed record on line {number}') from error


def millis_to_iso(value):
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()
