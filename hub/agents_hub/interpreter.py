"""Find a Python new enough for the hub (3.11+, for tomllib), on any machine.

Kept compatible with old Pythons on purpose: an old interpreter imports this to
find a newer one and re-run under it.
"""
import glob
import os
import shutil
import subprocess
import sys

MINIMUM = (3, 11)


def _candidates():
    for name in ('python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3'):
        found = shutil.which(name)
        if found:
            yield found
    home = os.path.expanduser('~')
    patterns = [
        '/opt/homebrew/bin/python3*', '/usr/local/bin/python3*', '/usr/bin/python3*',
        os.path.join(home, '.local/bin/python3*'),
        os.path.join(home, '.local/share/mise/installs/python/*/bin/python3'),
        os.path.join(home, '.pyenv/versions/*/bin/python3'),
        os.path.join(home, '.asdf/installs/python/*/bin/python3'),
    ]
    for pattern in patterns:
        for path in sorted(glob.glob(pattern), reverse=True):
            yield path


def _is_new_enough(path):
    try:
        result = subprocess.run(
            [path, '-c', 'import sys; print(sys.version_info[:2] >= (%d, %d))' % MINIMUM],
            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.stdout.strip() == 'True'


def find():
    """Absolute path of a Python >= MINIMUM, or None.

    Version-manager shims are resolved to the real binary, because a shim can
    pick a different version depending on the current folder.
    """
    if sys.version_info[:2] >= MINIMUM:
        return os.path.realpath(sys.executable)
    seen = set()
    for path in _candidates():
        real = os.path.realpath(path)
        if real in seen or not os.access(real, os.X_OK):
            continue
        seen.add(real)
        if _is_new_enough(real):
            return real
    return None


def ensure(script):
    """Re-run `script` under a new enough Python, or exit with a clear message."""
    if sys.version_info[:2] >= MINIMUM:
        return
    python = find()
    if python is None:
        sys.exit('agents-hub needs Python %d.%d+; install one and retry.' % MINIMUM)
    os.execv(python, [python, script] + sys.argv[1:])
