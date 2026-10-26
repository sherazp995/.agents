#!/usr/bin/env python3
"""Run one command while holding an exclusive flock on LOCKFILE.

Usage: python3 -I with_lock.py LOCKFILE -- command [args...]
Exit: the command's exit code, 75 when another process holds the lock, or 124 when the command
runs longer than WITH_LOCK_TIMEOUT seconds (default 1800); its whole process group is then killed.
The kernel drops the lock when this process ends, so a crash never leaves it held.
"""
import fcntl
import os
import signal
import subprocess
import sys

BUSY = 75
TIMED_OUT = 124


def main():
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        sys.stderr.write(__doc__)
        return 2
    path = sys.argv[1]
    limit = os.environ.get("WITH_LOCK_TIMEOUT", "1800")
    if not limit.isdigit() or int(limit) == 0:
        sys.stderr.write(f"WITH_LOCK_TIMEOUT must be a positive integer of seconds: {limit}\n")
        return 2
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return BUSY
        # The command runs in its own group so a timeout can stop all of it. TERM and HUP to this
        # process are turned into an exit, so the group is stopped then too instead of orphaned.
        for sig in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, lambda signum, _frame: sys.exit(128 + signum))
        child = subprocess.Popen(sys.argv[3:], pass_fds=(handle.fileno(),), start_new_session=True)
        try:
            return child.wait(timeout=int(limit))
        except BaseException as stop:
            # Timeout, interrupt or TERM: stop the command and its children before the lock is dropped.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass  # already gone; macOS raises EPERM for a group whose leader is a zombie
            child.wait()
            if isinstance(stop, subprocess.TimeoutExpired):
                return TIMED_OUT
            raise


if __name__ == "__main__":
    sys.exit(main())
