"""Learning loop: promote recurring memories into shared skills.

Memories are facts an agent recalls when relevant. A skill is a procedure every
agent loads and follows. When the same guidance keeps showing up as memory
(especially `feedback` memories, often repeated across projects), it belongs in
a skill under ~/.agents/skills, which Claude, Codex, Cursor and OpenCode all read.

Promotion never edits memory files (Claude owns those); it records what was
promoted in memory/.promotions.json and writes only to skills it created itself.
"""
from collections import defaultdict
from datetime import date
import json
import re

from .locking import exclusive
from .memory import INDEX, MemoryError, read_scalar, slug, superseded_files, yaml_scalar

LEARNED_MARKER = '<!-- agents-hub:learned-skill -->'
LEARNABLE_TYPES = ('feedback', 'user')


def ledger_path(paths):
    return paths.memory / '.promotions.json'


def load_ledger(paths):
    ledger = ledger_path(paths)
    return json.loads(ledger.read_text()) if ledger.exists() else {}


def skills_dir(paths):
    return paths.hub / 'skills'


def _frontmatter(text):
    match = re.match(r'---\n(.*?)\n---\n?(.*)', text, re.S)
    if not match:
        return {}, text
    fields = {key: read_scalar(value)
              for key, value in re.findall(r'(?m)^\s*(name|description|type):\s*(.+)$', match.group(1))}
    return fields, match.group(2).strip()


def memory_files(paths):
    folders = [('global', paths.global_memory)]
    if paths.scopes.is_dir():
        folders += [(d.name, d) for d in sorted(paths.scopes.iterdir()) if d.is_dir()]
    for scope_name, folder in folders:
        for file in sorted(folder.glob('*.md')):
            if file.name != INDEX:
                yield f'{scope_name}/{file.name}', file


def _topic(name):
    # Claude's file names carry a type prefix and project words; compare on the rest.
    return re.sub(r'^(feedback|user|project|reference)[_-]', '', name.removesuffix('.md')).replace('_', '-')


def candidates(paths):
    """Unpromoted feedback/user memories, the ones repeated across scopes first."""
    ledger = load_ledger(paths)
    files = list(memory_files(paths))
    folders = {ref.split('/')[0]: file.parent for ref, file in files}
    superseded = {f'{name}/{replaced}' for name, folder in folders.items() for replaced in superseded_files(folder)}
    found = []
    for ref, file in files:
        if ref in ledger or ref in superseded:
            continue  # promoted already, or replaced by a correction
        fields, body = _frontmatter(file.read_text(errors='replace'))
        if fields.get('type') not in LEARNABLE_TYPES:
            continue
        found.append({'ref': ref, 'topic': _topic(file.name), 'type': fields['type'],
                      'description': fields.get('description', ''), 'body': body})
    scopes_per_topic = defaultdict(set)
    for item in found:
        scopes_per_topic[item['topic']].add(item['ref'].split('/')[0])
    for item in found:
        item['seen_in_scopes'] = len(scopes_per_topic[item['topic']])
    return sorted(found, key=lambda i: (-i['seen_in_scopes'], i['topic'], i['ref']))


def format_candidates(items):
    if not items:
        return 'No unpromoted feedback or user memories.'
    lines = []
    for item in items:
        lines.append(f"{item['ref']}  [{item['type']}, seen in {item['seen_in_scopes']} scope(s)]")
        lines.append(f"    {item['description']}")
    return '\n'.join(lines)


def _new_skill(name, description):
    return '\n'.join([
        '---', f'name: {name}', f'description: {yaml_scalar(description)}', '---', '', LEARNED_MARKER, '',
        f'# {name}', '',
        'Learned from memories the user confirmed. Follow every rule below; each one',
        'came from a correction or preference the user gave in a past session.', '',
        '## Rules', ''])


def promote(paths, skill, refs, description=None, today=None):
    """Append the given memories to a learned skill, creating it if needed."""
    name = slug(skill)
    available = dict(memory_files(paths))
    missing = [ref for ref in refs if ref not in available]
    if missing:
        raise MemoryError(f'Unknown memory: {", ".join(missing)} (use `agents-hub learn candidates`)')
    target = skills_dir(paths) / name / 'SKILL.md'
    with exclusive(paths.memory_lock):
        ledger = load_ledger(paths)
        eligible = {c['ref'] for c in candidates(paths)}
        stale = [ref for ref in refs if ref not in eligible]
        if stale:
            raise MemoryError(f'Already promoted or replaced by a correction: {", ".join(stale)}')
        if target.exists():
            text = target.read_text()
            if LEARNED_MARKER not in text:
                raise MemoryError(f'{target} was not created by `learn`; edit that skill by hand')
        else:
            if not description:
                raise MemoryError('A new skill needs --description (when should agents use it?)')
            target.parent.mkdir(parents=True)
            text = _new_skill(name, description)
        stamp = (today or date.today()).isoformat()
        for ref in refs:
            fields, body = _frontmatter(available[ref].read_text(errors='replace'))
            heading = fields.get('description') or _topic(ref.split('/')[-1])
            text = text.rstrip('\n') + f'\n\n### {heading}\n\n{body}\n\n_Learned from `{ref}` on {stamp}._\n'
            ledger[ref] = {'skill': name, 'date': stamp}
        target.write_text(text)
        ledger_path(paths).write_text(json.dumps(ledger, indent=1, sort_keys=True))
    return target
