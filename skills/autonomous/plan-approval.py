#!/usr/bin/env python3
"""Stamp a plan file with the user's approval, and check later that the approved plan is unchanged.

  plan-approval.py sign <plan> --words "<the user's approving words>"
  plan-approval.py verify <plan>

`sign` runs at doing-substantial-work's approval gate, inside the repo the plan builds. It writes (or
replaces) three lines at the end of the plan's header, the text before its first `## ` heading:

  Approved: <YYYY-MM-DD> <words>
  Repo: <absolute git toplevel of the current directory>
  Approved-sha256: <hash>

The hash covers the `## Confirmed intent`, `## Steps` and `## Checks` sections. Checkbox marks are
normalized first, so ticking a step (`- [ ]` to `- [x]`) keeps the stamp valid, while editing any
intent line, step or check voids it. The Log and every other section stay outside the hash.

`verify` exits 0 when the stamp is present and the hash still matches, else 1 with a one-line reason.
Autonomous runs build only plans that verify.
"""
import datetime
import hashlib
import re
import subprocess
import sys
from pathlib import Path

SECTIONS = ('Confirmed intent', 'Steps', 'Checks')
STAMP_KEYS = ('Approved', 'Repo', 'Approved-sha256')
HEADING = re.compile(r'^## (.+?)\s*$')
CHECKBOX = re.compile(r'^(\s*[-*+] )\[[ xX]\]')


class PlanError(Exception):
    """The plan cannot be signed or does not verify; the message is the one-line reason."""


def split_plan(text):
    """(header lines, {section title: body lines}) where the header is everything before the first `## `."""
    header, sections, current = [], {}, None
    for line in text.splitlines():
        match = HEADING.match(line)
        if match:
            current = match[1]
            sections.setdefault(current, [])
        elif current is None:
            header.append(line)
        else:
            sections[current].append(line)
    return header, sections


def payload_hash(text):
    """The sha256 of the approved sections, checkbox marks normalized. Raises PlanError if one is missing."""
    _, sections = split_plan(text)
    missing = [title for title in SECTIONS if title not in sections]
    if missing:
        raise PlanError('the plan has no ' + ', '.join(f'"## {title}"' for title in missing) + ' section')
    digest = hashlib.sha256()
    for title in SECTIONS:
        body = [CHECKBOX.sub(r'\1[ ]', line).rstrip() for line in sections[title]]
        while body and not body[0]:
            body.pop(0)
        while body and not body[-1]:
            body.pop()
        digest.update(('## ' + title + '\n' + '\n'.join(body) + '\n').encode())
    return digest.hexdigest()


def stamp(header):
    """{key: value} for the stamp lines found in the header."""
    found = {}
    for line in header:
        key, sep, value = line.partition(': ')
        if sep and key in STAMP_KEYS:
            found[key] = value.strip()
    return found


def repo_toplevel(directory):
    result = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=directory, capture_output=True, text=True)
    if result.returncode != 0:
        raise PlanError(f'{directory} is not inside a git repository; run sign from the repo the plan builds')
    return result.stdout.strip()


def sign(path, words, directory='.', today=None):
    words = ' '.join((words or '').split())
    if not words:
        raise PlanError('--words must hold the user\'s approving words')
    text = Path(path).read_text(encoding='utf-8')
    digest = payload_hash(text)
    repo = repo_toplevel(directory)
    lines = text.splitlines()
    first = next((i for i, line in enumerate(lines) if HEADING.match(line)), len(lines))
    old_stamp = set(stamp(lines[:first]))
    header = [line for line in lines[:first] if line.partition(': ')[0] not in old_stamp]
    while header and not header[-1].strip():
        header.pop()
    date = (today or datetime.date.today()).isoformat()
    block = [f'Approved: {date} {words}', f'Repo: {repo}', f'Approved-sha256: {digest}']
    rest = lines[first:]
    Path(path).write_text('\n'.join(header + [''] + block + ([''] + rest if rest else [])) + '\n', encoding='utf-8')
    return digest


def verify(path):
    """The stamp {key: value} when the plan verifies; raises PlanError otherwise."""
    try:
        text = Path(path).read_text(encoding='utf-8')
    except OSError as error:
        raise PlanError(f'cannot read the plan: {error.strerror}')
    header, _ = split_plan(text)
    found = stamp(header)
    missing = [key for key in STAMP_KEYS if not found.get(key)]
    if missing:
        raise PlanError('the plan is not signed: no ' + ', '.join(f'"{key}:"' for key in missing) + ' line')
    if payload_hash(text) != found['Approved-sha256']:
        raise PlanError('the Confirmed intent, Steps or Checks changed after the approval; '
                        'it needs the user\'s yes and a new sign')
    if not Path(found['Repo']).is_dir():
        raise PlanError(f'the plan\'s repo {found["Repo"]} does not exist')
    return found


def main(argv):
    usage = 'usage: plan-approval.py sign <plan> --words "<approving words>" | verify <plan>'
    if len(argv) == 2 and argv[0] == 'verify':
        action = lambda: verify(argv[1])
    elif len(argv) == 4 and argv[0] == 'sign' and argv[2] == '--words':
        action = lambda: sign(argv[1], argv[3])
    else:
        print(usage, file=sys.stderr)
        return 2
    try:
        action()
    except PlanError as error:
        print(f'{argv[1]}: {error}', file=sys.stderr)
        return 1
    except OSError as error:
        print(f'{argv[1]}: {error.strerror}', file=sys.stderr)
        return 1
    print(f'{argv[1]}: {"signed" if argv[0] == "sign" else "verified"}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
