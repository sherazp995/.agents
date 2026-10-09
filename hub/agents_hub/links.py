"""The two helpers behind the user's rule: never write the full home path."""
import os
from pathlib import Path


def tilde(path, home=None):
    """path written with ~ for the home folder, whichever spelling (symlinked or real) either uses."""
    path, home = Path(path), Path(home or Path.home())
    for base in (home, home.resolve()):
        if path == base or path.is_relative_to(base):
            rest = path.relative_to(base)
            return '~' if rest == Path('.') else f'~/{rest}'
    return str(path)


def write_relative_link(link, target):
    """Create link, or replace it in one rename, as a relative link to target.

    The relative path is measured from the link's real folder, so it still reaches target when
    the link's folder is itself reached through a symlink. Only the target's folder is resolved,
    so a link to a link (an account's entry -> the first login's entry) stays a link to that link.
    """
    link = Path(link)
    temporary = link.with_name(link.name + '.agents-hub-tmp')
    if temporary.is_symlink():
        temporary.unlink()
    target = Path(target)
    temporary.symlink_to(os.path.relpath(target.parent.resolve() / target.name, link.parent.resolve()))
    os.replace(temporary, link)
