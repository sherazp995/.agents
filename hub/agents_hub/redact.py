"""Secret redaction applied to every piece of text before it enters the index.

Bump VERSION whenever a pattern changes: every indexed session is then re-imported.
"""
import re

VERSION = 7
MASK = '[REDACTED]'

# (pattern, replacement). Replacements keep the label and drop only the secret.
PATTERNS = [
    re.compile(r'sk-ant-[A-Za-z0-9_\-]{20,}'),
    re.compile(r'\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}'),
    re.compile(r'sk-(?:proj-)?[A-Za-z0-9_\-]{20,}'),
    re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}'),
    re.compile(r'github_pat_[A-Za-z0-9_]{30,}'),
    re.compile(r'xox[abposr]-[A-Za-z0-9\-]{10,}'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(r'AIza[0-9A-Za-z_\-]{35}'),
    re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----'),
    re.compile(r'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}'),
    re.compile(r'(?i)(authorization:\s*(?:bearer|basic|token)\s+)\S+'),
    # key=value, key: value, quoted JSON/YAML keys, and names such as AWS_SECRET_ACCESS_KEY.
    # Any length: short passwords are still passwords. A quoted value is masked up to its
    # closing quote (escaped quotes inside it included), spaces included, and keeps its quotes.
    re.compile(r'(?i)(\b[A-Za-z0-9_\-]*(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)[A-Za-z0-9_\-]*'
               r'["\']?\s*[:=]\s*)(?:(?P<q>["\'])(?:\\.|(?!(?P=q))[^\\\n])+(?P=q)|["\']?(?![\[{])[^\s"\'&,}]+)'),
    # Passwords in connection strings: scheme://user:password@host
    re.compile(r'(\b[a-z][a-z0-9+.\-]*://[^\s:/@]+:)[^\s@/]+(?=@)'),
]


def _mask(match):
    quote = match.groupdict().get('q') or ''
    return (match.group(1) if match.re.groups else '') + quote + MASK + quote


def redact(text):
    for pattern in PATTERNS:
        text = pattern.sub(_mask, text)
    return text
