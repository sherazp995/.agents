"""Shared memory: one store in ~/.agents/memory, linked into every Claude project.

Write protocol (see plans/2026-10-09-unified-agent-hub.md, Phase 1):
Claude owns and edits its own files natively. Every other agent only adds new
files through `add`, and index lines are appended to MEMORY.md, never rewritten.
"""
from datetime import datetime, timezone
import contextlib
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time

from . import scope
from .locking import exclusive

INDEX = 'MEMORY.md'
LINK_NAME = 'memory'


class MemoryError(Exception):
    pass


# Locating Claude's memory folders

def claude_memory_dirs(paths):
    if not paths.claude_projects.is_dir():
        return []
    return sorted(p / LINK_NAME for p in paths.claude_projects.iterdir()
                  if p.is_dir() and ((p / LINK_NAME).exists() or (p / LINK_NAME).is_symlink()))


def unadopted(paths):
    """Real memory folders that still live inside a Claude project folder."""
    return [d for d in claude_memory_dirs(paths) if d.is_dir() and not d.is_symlink()]


# Migration and adoption

def other_agents_running():
    """Claude or Codex processes other than this one's parents."""
    own = {os.getpid(), os.getppid()}
    try:
        result = subprocess.run(['pgrep', '-x', 'claude|codex'], capture_output=True, text=True)
    except FileNotFoundError:
        return [-1]  # no pgrep: cannot tell, so assume they are open
    return [int(pid) for pid in result.stdout.split() if int(pid) not in own]


def _backup(paths, sources, label, destinations):
    started = time.time()
    stamp = datetime.fromtimestamp(started, timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = paths.backups / f'memory-{label}-{stamp}-{os.getpid()}'
    target.mkdir(parents=True)
    manifest = []
    with tarfile.open(target / 'memory.tar.gz', 'w:gz') as archive:
        for source in sources:
            archive.add(source, arcname=source.parent.name)
            for file in sorted(f for f in source.rglob('*') if f.is_file()):
                manifest.append({'project': source.parent.name, 'file': str(file.relative_to(source)),
                                 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
    (target / 'manifest.json').write_text(json.dumps(
        {'created_at': stamp, 'created_epoch': started, 'projects': [s.parent.name for s in sources],
         'destinations': destinations, 'files': manifest}, indent=1))
    return target


def _free_name(target):
    """A path next to target that does not exist yet: target itself, else target.conflict-N."""
    if not target.exists():
        return target
    for n in itertools.count(1):
        candidate = target.with_name(f'{target.stem}.conflict-{n}{target.suffix}')
        if not candidate.exists():
            return candidate


def _move_without_replacing(file, target):
    # os.link fails if target exists, so nothing is ever overwritten, even in a race.
    while True:
        try:
            os.link(file, _free_name(target))
            break
        except FileExistsError:
            continue
    file.unlink()


def _merge_into(source, dest):
    """Move every file from source into dest without overwriting or deleting anything.

    Only files this call moved are removed from source. A file Claude writes into
    source meanwhile is picked up by the next pass; the folder goes only once empty.
    """
    while True:
        files = sorted(f for f in source.rglob('*') if f.is_file() or f.is_symlink())
        for file in files:
            target = dest / file.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.read_bytes() == file.read_bytes():
                file.unlink()
            else:
                _move_without_replacing(file, target)
        for folder in sorted((d for d in source.rglob('*') if d.is_dir()), key=lambda d: -len(d.parts)):
            with contextlib.suppress(OSError):
                folder.rmdir()
        try:
            source.rmdir()
            return
        except OSError:
            continue  # something new arrived; move it too


def _link_back(source, dest):
    """Replace source with a symlink to dest, absorbing a folder Claude recreated meanwhile."""
    for _ in range(3):
        try:
            os.symlink(os.path.relpath(dest, source.parent.resolve()), source)  # relative: no home path written
            return
        except FileExistsError:
            if source.is_symlink():
                return
            _merge_into(source, dest)
    raise MemoryError(f'Could not link {source}')


def adopt(paths, running_ok=False, label='adopt', targets=None):
    """Move real Claude memory folders into the hub and link them back.

    targets maps a Claude project folder name to the scope it belongs to; by
    default every unadopted folder goes to the scope of the same name.
    """
    def pending():
        found = {d.parent.name: d for d in unadopted(paths)}
        if targets is not None:
            wanted = targets
        else:
            # A folder whose project has an alias in registry.toml goes to the aliased scope.
            aliased = {scope.native_folder_key(paths, path): alias for path, alias in scope.aliases(paths).items()}
            wanted = {key: aliased.get(key, key) for key in found}
        return [(found[key], wanted[key]) for key in sorted(found) if key in wanted]

    if not pending():
        return []
    if not running_ok and other_agents_running():
        raise MemoryError('Claude or Codex is running; close them or pass --running-ok')
    with exclusive(paths.memory_lock):
        work = pending()
        if not work:
            return []
        backup = _backup(paths, [source for source, _key in work], label,
                         {source.parent.name: key for source, key in work})
        moved = []
        for source, key in work:
            dest = paths.scopes / key
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                _merge_into(source, dest)
            else:
                os.rename(source, dest)
            _link_back(source, dest)
            cwd = scope.transcript_cwd(source.parent)
            # Record the owner only when key is the project's own folder name, never an alias destination.
            if cwd and scope.recorded_path(paths, dest) is None and scope.native_folder_key(paths, cwd) == key:
                scope.record_path(paths, dest, cwd)
            moved.append(key)
        (backup / 'linked.json').write_text(json.dumps(moved, indent=1))
        return moved


def rollback(paths, backup_dir):
    """Undo one adopt run from its tarball, refusing if any destination file is newer than the backup.

    A destination scope is set aside in the backup folder (never deleted), unless
    projects outside this backup still link to it, in which case it stays.
    """
    manifest = json.loads((backup_dir / 'manifest.json').read_text())
    created = manifest['created_epoch']
    destinations = {key: manifest.get('destinations', {}).get(key, key) for key in manifest['projects']}
    with exclusive(paths.memory_lock):
        newer = [str(f) for dest in set(destinations.values()) for f in (paths.scopes / dest).rglob('*')
                 if f.is_file() and f.name != scope.PATH_FILE and f.stat().st_mtime > created]
        if newer:
            raise MemoryError('Files changed after the backup; restore them by hand:\n' + '\n'.join(newer))
        staging = backup_dir / 'restore'
        set_aside = backup_dir / 'rolled-back-scopes'
        with tarfile.open(backup_dir / 'memory.tar.gz') as archive:
            archive.extractall(staging, filter='data')
        for key in manifest['projects']:
            link = paths.claude_projects / key / LINK_NAME
            if link.is_symlink():
                link.unlink()
            if link.exists():
                raise MemoryError(f'{link} is a real folder again; merge it by hand')
            os.rename(staging / key, link)
        for dest in set(destinations.values()):
            folder = paths.scopes / dest
            still_linked = [d for d in claude_memory_dirs(paths)
                            if d.is_symlink() and d.resolve() == folder.resolve()]
            if folder.exists() and not still_linked:
                set_aside.mkdir(exist_ok=True)
                os.rename(folder, set_aside / dest)
        shutil.rmtree(staging, ignore_errors=True)
    return manifest['projects']


def provision(paths, cwd):
    """SessionStart hook: link this project's Claude memory folder to its hub scope.

    It only ever creates a link where no memory folder exists yet. A real folder
    is never moved here, because Claude may be writing to it; moving one is
    `agents-hub memory adopt`, which requires Claude and Codex to be closed.
    """
    # Claude keys memory by repository, never by subfolder, so its link follows the
    # repository's scope; a subfolder alias applies only to agents-hub commands run there.
    scope_key, root = scope.resolve(paths, scope.project_root(cwd))
    # Claude may key a worktree by its main repository or by its own folder; link both.
    roots = {root, scope.worktree_root(cwd)}
    folder_keys = {key for key in (scope.native_folder_key(paths, r) for r in roots) if key}
    if not folder_keys:
        raise MemoryError(f'No Claude project folder known for {root}')
    with exclusive(paths.memory_lock):
        dest = scope.ensure(paths, scope_key, root)
        for folder_key in sorted(folder_keys):
            _link(paths.claude_projects / folder_key / LINK_NAME, dest)
    return scope_key


def _holds_memories(folder):
    return folder.is_dir() and any(folder.glob('*.md'))


def _link(link, dest):
    """Point link at dest. Never moves a real folder; re-points only away from an empty scope."""
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() and link.resolve() != dest.resolve():
        if _holds_memories(link.resolve()):
            return  # the old scope has notes; doctor reports the mismatch for the user to merge
        link.unlink()  # e.g. a new alias for a project whose old scope is still empty
    try:
        os.symlink(os.path.relpath(dest, link.parent.resolve()), link)  # relative: no home path written
    except FileExistsError:
        pass  # already linked, or a real folder that doctor reports for `memory adopt`


# Reading and adding

def scope_dir(paths, cwd, use_global):
    if use_global:
        return paths.global_memory
    key, _root = scope.resolve(paths, cwd)
    return paths.scopes / key


def resolve_memory_name(directory, name):
    """The file a `supersedes` name points at: the exact file (Claude keeps underscores), else its slug."""
    name = name.strip().removesuffix('.md')
    exact = directory / f'{name}.md'
    return exact.name if exact.exists() else f'{slug(name)}.md'


def superseded_files(directory):
    """File names in directory that a later memory replaces."""
    replaced = set()
    for file in directory.glob('*.md'):
        for name in re.findall(r'(?m)^\s*supersedes:\s*"?([^"\n]+)"?\s*$', file.read_text(errors='replace')):
            replaced.add(resolve_memory_name(directory, name))
    return replaced


def current_index(directory):
    """The MEMORY.md lines of directory, without entries a correction has replaced."""
    index = directory / INDEX
    lines = index.read_text().strip().splitlines() if index.exists() else []
    replaced = superseded_files(directory) if directory.is_dir() else set()
    return [line for line in lines if not any(f'({name})' in line for name in replaced)]


APP_MEMORY_SUMMARIES = {'Codex': ('codex', 'memory_summary.md')}  # apps whose own memory lives in the hub


def app_memory_summaries(paths):
    """(title, path, text) for each app's own memory digest kept in the hub, when it has one."""
    found = []
    for app, (folder, name) in APP_MEMORY_SUMMARIES.items():
        summary = paths.memory / folder / name
        text = summary.read_text(errors='replace').strip() if summary.is_file() else ''
        if text:
            found.append((f'{app} memory summary', summary, text))
    return found


def show(paths, cwd):
    """Global, project and app memories, without entries a correction has replaced."""
    sections = []
    for title, directory in (('Global memory', paths.global_memory), ('Project memory', scope_dir(paths, cwd, False))):
        kept = current_index(directory)
        body = '\n'.join(kept) if kept else '(empty)'
        sections.append(f'## {title}: {directory}\n\n{body}')
    for title, summary, text in app_memory_summaries(paths):
        sections.append(f'## {title}: {summary}\n\n{text}')
    return '\n\n'.join(sections) + '\n'


def slug(name):
    value = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    if not value:
        raise MemoryError('Memory name must contain letters or digits')
    return value


def add(paths, cwd, name, description, body, kind, author, use_global=False, supersedes=None):
    """Create one new memory file and append its index line. Never edits existing files."""
    if kind not in ('user', 'feedback', 'project', 'reference'):
        raise MemoryError(f'Unknown memory type: {kind}')
    with exclusive(paths.memory_lock):
        if use_global:
            directory = paths.global_memory
            directory.mkdir(parents=True, exist_ok=True)
        else:
            key, root = scope.resolve(paths, cwd)
            directory = scope.ensure(paths, key, root)
        file_name = f'{slug(name)}.md'
        target = directory / file_name
        if target.exists():
            raise MemoryError(f'{target} exists; add a new file with --supersedes instead of editing')
        metadata = [f'  type: {kind}', f'  author: {yaml_scalar(author)}']
        index_description = description
        if supersedes:
            replaced = resolve_memory_name(directory, supersedes)
            if not (directory / replaced).exists():
                raise MemoryError(f'No memory {supersedes!r} in {directory} to supersede')
            metadata.append(f'  supersedes: {yaml_scalar(replaced.removesuffix(".md"))}')
            # Claude reads MEMORY.md natively and may still list the old line; this marks it replaced.
            index_description = f'{description} (replaces {replaced})'
        text = '\n'.join(['---', f'name: {slug(name)}', f'description: {yaml_scalar(description)}', 'metadata:',
                          *metadata, '---', '', body.strip(), ''])
        with open(target, 'x') as handle:
            handle.write(text)
        append_index_line(directory, file_name, index_description)
        return target


def yaml_scalar(value):
    # A JSON string is a valid double-quoted YAML scalar, so `Use when: x` stays one value.
    return json.dumps(' '.join(str(value).split()), ensure_ascii=False)


def read_scalar(raw):
    raw = raw.strip()
    if raw.startswith('"'):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw.strip('"')
    return raw


def append_index_line(directory, file_name, description):
    # One small O_APPEND write: a concurrent native edit of MEMORY.md is never replaced by us.
    line = f'- [{Path(file_name).stem}]({file_name}) — {description}\n'
    index = directory / INDEX
    prefix = ''
    if index.exists() and index.stat().st_size and not index.read_bytes().endswith(b'\n'):
        prefix = '\n'
    fd = os.open(index, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, (prefix + line).encode())
    finally:
        os.close(fd)


# Health

def frontmatter_description(file):
    match = re.search(r'(?m)^description:\s*(.+)$', file.read_text(errors='replace'))
    return read_scalar(match.group(1)) if match else file.stem


def written_by_hub(file):
    # Only files created by `add` carry an author; Claude's own notes are Claude's to index.
    return re.search(r'(?m)^\s*author:\s*\S', file.read_text(errors='replace')) is not None


def expected_scope(paths, project_folder):
    """The scope a Claude project folder should link to, from the cwd its transcripts record."""
    cwd = scope.transcript_cwd(project_folder)
    if not cwd:
        # No transcripts yet: fall back to the owner recorded in the linked scope, if it is this folder's project.
        link = project_folder / LINK_NAME
        owner = scope.recorded_path(paths, link.resolve()) if link.is_symlink() else None
        if not owner or scope.native_folder_key(paths, owner) != project_folder.name:
            return None
        cwd = owner
    if not Path(cwd).is_dir():
        return None  # the project is gone (a deleted temp repo or worktree): its git root cannot be known
    try:
        return scope.resolve(paths, scope.project_root(cwd))[0]
    except scope.ScopeError:
        return None


def doctor(paths, fix=False):
    """Returns (problems, notes). Problems need action; notes are informational."""
    problems, notes = [], []
    for link in claude_memory_dirs(paths):
        if link.is_symlink() and link.exists():
            expected = expected_scope(paths, link.parent)
            if expected and link.resolve().name != expected:
                problems.append(f'{link} uses scope {link.resolve().name}, but its project resolves to {expected}; '
                                f'merge the notes into scopes/{expected} by hand, then remove the link')
        if link.is_symlink() and not link.exists():
            problems.append(f'dangling link: {link}')
        elif not link.is_symlink():
            problems.append(f'not in hub (run `agents-hub memory adopt`): {link}')
    directories = [paths.global_memory] + (sorted(paths.scopes.iterdir()) if paths.scopes.is_dir() else [])
    for directory in directories:
        if not directory.is_dir():
            continue
        index = directory / INDEX
        listed = index.read_text(errors='replace') if index.exists() else ''
        for file in sorted(directory.glob('*.md')):
            if file.name == INDEX or f'({file.name})' in listed:
                continue
            if not written_by_hub(file):
                notes.append(f'unindexed Claude note (left alone): {file}')
                continue
            if not fix:
                problems.append(f'missing index line: {file}')
                continue
            with exclusive(paths.memory_lock):
                append_index_line(directory, file.name, frontmatter_description(file))
            notes.append(f'restored index line: {file}')
    return problems, notes
