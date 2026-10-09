"""Advisory file locks shared by every hub writer."""
from contextlib import contextmanager
import fcntl


class LockBusy(Exception):
    pass


@contextmanager
def exclusive(path, wait=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'a') as handle:
        flags = fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB
        try:
            fcntl.flock(handle, flags)
        except BlockingIOError as error:
            raise LockBusy(str(path)) from error
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
