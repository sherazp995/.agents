"""Shared fixtures: a throwaway git repo and an approved plan file for it."""
from importlib.machinery import SourceFileLoader
from pathlib import Path
import subprocess
import sys

SKILL = Path(__file__).resolve().parents[1]
AGENTS = SKILL.parents[1]
GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@t']

PLAN = '''# Rename the widget

Request (verbatim):
- "rename it"

## Confirmed intent
- Outcome: the widget is called gadget.

## Steps
- [ ] 1. Rename the class.
- [ ] 2. Update the callers.

## Checks
- python3 -m unittest

## Log
- 2026-10-29: user approved ("yes").
'''


def load(name, path):
    return SourceFileLoader(name, str(path)).load_module()


def git(repo, *args):
    return subprocess.run(['git', *GIT_ID, *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def make_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    git(path, 'init', '-q')
    (path / 'app.txt').write_text('widget\n')
    git(path, 'add', '.')
    git(path, 'commit', '-q', '-m', 'init')
    return path.resolve()


def write_plan(path, repo, text=PLAN, words='yes'):
    """A plan signed from inside repo, as doing-substantial-work's approval gate does."""
    path.write_text(text)
    result = subprocess.run([sys.executable, str(SKILL / 'plan-approval.py'), 'sign', str(path), '--words', words],
                            cwd=repo, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return path
