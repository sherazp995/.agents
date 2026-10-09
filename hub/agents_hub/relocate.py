"""Move an app's data folder into ~/.agents and leave a relative link behind.

Used for chat history (for example ~/.claude/projects -> ~/.agents/history/claude/projects).
The move is a rename on the same disk: instant, nothing copied, and every file an app has
open keeps writing to the same file. Run it with the app closed: install.py waits for that,
because a file the app creates between the rename and the link would land beside the moved
folder. If that happens the move stops and reports it rather than merging.
"""
import errno
import os
from pathlib import Path

from .links import tilde, write_relative_link


class RelocateError(Exception):
    pass


def state(source, dest):
    """'moved' (source links to dest), 'pending' (real folder to move), 'absent', or a conflict message."""
    if source.is_symlink():
        try:
            moved = dest.is_dir() and source.resolve() == dest.resolve()
        except (OSError, RuntimeError):  # a link loop
            moved = False
        if moved:
            return 'moved'
        return f'{tilde(source)} links somewhere else ({os.readlink(source)}); leave it or move it aside, then rerun'
    dest_has_files = dest.is_dir() and any(dest.iterdir())
    if not source.exists():
        if dest_has_files:
            return (f'{tilde(source)} is missing but {tilde(dest)} has files (a move stopped halfway); '
                    f'link it back with: ln -s {os.path.relpath(dest, source.parent.resolve())} {tilde(source)}')
        return 'absent'
    if not source.is_dir():
        return f'{tilde(source)} is not a folder; move it aside, then rerun'
    if dest_has_files or (dest.exists() and not dest.is_dir()):
        return f'{tilde(dest)} already has files; merge or remove it by hand, then rerun'
    return 'pending'


def same_disk(source, dest):
    """Whether a rename can move source to dest (checked on dest's nearest existing folder)."""
    existing = dest
    while not existing.exists():
        existing = existing.parent
    return os.stat(source).st_dev == os.stat(existing).st_dev


def relocate(source, dest):
    """Move source to dest and link source -> dest."""
    status = state(source, dest)
    if status != 'pending':
        if status in ('moved', 'absent'):
            return status
        raise RelocateError(status)
    try:
        inner_links = links_inside(source)  # relative links inside are measured from where they sit
    except (OSError, RuntimeError) as error:
        raise RelocateError(f'{tilde(source)} has a link that cannot be followed ({error}); fix it, then rerun') from error
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.rmdir()  # empty, checked by state()
    try:
        os.rename(source, dest)
    except OSError as error:
        reason = 'they must be on the same disk' if error.errno == errno.EXDEV else str(error)
        raise RelocateError(f'cannot move {tilde(source)} to {tilde(dest)}: {reason}') from error
    for relative_path, target in inner_links.items():
        moved_link = dest / relative_path
        if moved_link.is_symlink() and moved_link.resolve() != target:
            write_relative_link(moved_link, target)  # re-aim from its new place; same target as before
    try:
        os.symlink(os.path.relpath(dest, source.parent.resolve()), source)
    except FileExistsError as error:
        raise RelocateError(f'{tilde(source)} was recreated while moving (an app is open); its history is in '
                            f'{tilde(dest)}. Close the app, merge {tilde(source)} into it by hand, '
                            'then rerun') from error
    return 'moved now'


def links_inside(folder):
    """{path relative to folder: resolved target} for every relative link inside folder."""
    found = {}
    for directory, subdirs, files in os.walk(folder):
        for name in subdirs + files:
            path = Path(directory, name)
            if path.is_symlink() and not os.path.isabs(os.readlink(path)):
                target = path.resolve()
                if not target.is_relative_to(folder.resolve()):  # links within the folder move with it
                    found[path.relative_to(folder)] = target
    return found


def normalize_links(paths_to_check, hub):
    """Rewrite links that point into the hub with a full path as relative links (same target).

    Returns the links rewritten. Links pointing outside the hub are left as they are.
    """
    changed = []
    hub = Path(hub).resolve()
    for link in paths_to_check:
        if not link.is_symlink():
            continue
        current = os.readlink(link)
        if os.path.isabs(current) and Path(current).resolve().is_relative_to(hub) and link.exists():
            write_relative_link(link, Path(current).resolve())
            changed.append(link)
    return changed
