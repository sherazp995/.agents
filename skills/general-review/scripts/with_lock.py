#!/usr/bin/env python3
"""Run one command while holding an exclusive flock on LOCKFILE.

Usage: python3 -I with_lock.py LOCKFILE -- command [args...]
Exit: the command's exit code, or 75 when another process holds the lock.
The kernel drops the lock when this process ends, so a crash never leaves it held.
"""
import fcntl
import os
import subprocess
import sys

BUSY = 75


def main():
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        sys.stderr.write(__doc__)
        return 2
    path = sys.argv[1]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return BUSY
        return subprocess.call(sys.argv[3:], pass_fds=(handle.fileno(),))


if __name__ == "__main__":
    sys.exit(main())
