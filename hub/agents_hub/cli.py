"""agents-hub: shared memory and chat search for every coding agent on this machine."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

from . import accounts, handoff, index, learn, memory, scope
from .paths import Paths


def _requested_cwd(args):
    return getattr(args, 'cwd', None) or args.root_cwd


def _cwd(args):
    return Path(_requested_cwd(args) or os.getcwd()).resolve()


def cmd_scope(paths, args):
    key, root = scope.resolve(paths, _cwd(args))
    print(f'{key}\t{root}')


def cmd_memory_show(paths, args):
    print(memory.show(paths, _cwd(args)), end='')


def cmd_memory_add(paths, args):
    body = sys.stdin.read() if args.body == '-' else args.body
    target = memory.add(paths, _cwd(args), args.name, args.description, body, args.type, args.author,
                        use_global=args.use_global, supersedes=args.supersedes)
    print(target)


def cmd_memory_adopt(paths, args):
    moved = memory.adopt(paths, running_ok=args.running_ok, label='migrate')
    print(f'linked {len(moved)} memory folder(s) into the hub')
    for key in moved:
        print(f'  {key}')


def cmd_memory_provision(paths, args):
    # Runs as a Claude SessionStart hook: it must never fail or print to the session.
    # Its stdout becomes session context, which is how global memory reaches Claude.
    try:
        payload = json.loads(sys.stdin.read() or '{}') if not _requested_cwd(args) else {}
        memory.provision(paths, Path(_requested_cwd(args) or payload.get('cwd') or os.getcwd()))
    except Exception as error:
        print(f'agents-hub provision: {error}', file=sys.stderr)
    try:
        lines = memory.current_index(paths.global_memory)
    except OSError as error:
        print(f'agents-hub provision: {error}', file=sys.stderr)
        return
    if lines:
        print(f'Global memory shared by every agent ({paths.global_memory}):\n' + '\n'.join(lines))
    for title, summary, text in memory.app_memory_summaries(paths):
        print(f'{title} ({summary}):\n{text}')


def cmd_memory_rollback(paths, args):
    restored = memory.rollback(paths, Path(args.backup))
    print(f'restored {len(restored)} folder(s)')


def cmd_memory_doctor(paths, args):
    problems, notes = memory.doctor(paths, fix=args.fix)
    # With --fix (the scheduled run) only actionable lines and repairs are logged.
    for line in problems + [n for n in notes if not args.fix or n.startswith('restored')]:
        print(line)
    if problems and not args.fix:
        sys.exit(1)


def cmd_learn_candidates(paths, args):
    print(learn.format_candidates(learn.candidates(paths)))


def cmd_learn_promote(paths, args):
    print(learn.promote(paths, args.skill, args.refs, args.description))


def cmd_account_add(paths, args):
    print('\n'.join(accounts.add(paths.home, args.client, args.alias, args.dir)))


def cmd_account_list(paths, args):
    print('\n'.join(accounts.listing(paths.home)))


def cmd_account_remove(paths, args):
    print('\n'.join(accounts.remove(paths.home, args.client, args.alias)))


def cmd_scheduled(paths, args):
    """The job the installer schedules: index, then memory doctor. Every attempt is recorded.

    scheduled.json keeps `succeeded_at` from the last complete run, so a run that
    found the index busy or failed never counts as fresh.
    """
    record_path = paths.chats / 'scheduled.json'
    try:
        previous = json.loads(record_path.read_text())
    except (OSError, ValueError):
        previous = {}
    now = datetime.now(timezone.utc).isoformat()
    record = {'attempted_at': now, 'succeeded_at': previous.get('succeeded_at'), 'error': None,
              'busy': False, 'doctor_problems': []}
    try:
        counts = index.sync(paths)
        record['index'] = counts
        record['busy'] = bool(counts.get('busy'))
        if counts['failed']:
            record['error'] = f"{counts['failed']} session(s) failed to import"
        problems, notes = memory.doctor(paths, fix=True)
        record['doctor_problems'] = problems
        for line in problems + [n for n in notes if n.startswith('restored')]:
            print(line)
    except Exception as error:  # recorded, so check.py can report a broken job
        record['error'] = f'{type(error).__name__}: {error}'
    if not record['error'] and not record['busy']:
        record['succeeded_at'] = now
    paths.chats.mkdir(parents=True, exist_ok=True)
    temporary = paths.chats / 'scheduled.json.tmp'
    temporary.write_text(json.dumps(record))
    os.replace(temporary, record_path)
    if record['error']:
        sys.exit(f"agents-hub scheduled: {record['error']}")


def cmd_index(paths, args):
    counts = index.sync(paths, rebuild=args.rebuild)
    if counts.get('busy'):
        print('Another index run is in progress (scheduled run); try again in a minute.')
        return
    if args.verbose or counts['imported'] or counts['failed'] or counts['removed'] or counts.get('rescoped'):
        print(' '.join(f'{k}={v}' for k, v in counts.items()))
    if counts['failed']:
        sys.exit(1)


def _scope_filter(paths, args):
    return None if args.all_scopes else scope.chat_filter(paths, _cwd(args))


def cmd_search(paths, args):
    print(index.search(paths, ' '.join(args.query), _scope_filter(paths, args), args.agent, args.limit))


def cmd_read(paths, args):
    print(index.read(paths, args.agent, args.session, _scope_filter(paths, args), args.start, args.count))


def cmd_recent(paths, args):
    print(index.recent(paths, _scope_filter(paths, args), args.limit))


def cmd_handoff(paths, args):
    print(handoff.write(paths, args.agent, args.session, _scope_filter(paths, args)))


# --cwd works at any level (`--cwd X memory show`, `memory --cwd X show`, `memory show --cwd X`).
# Subcommand levels SUPPRESS the default, so a level where it is absent never
# overwrites a value given at another level.
CWD_OPTION = argparse.ArgumentParser(add_help=False)
CWD_OPTION.add_argument('--cwd', default=argparse.SUPPRESS, help='Act as if run from this directory')


def command(subparsers, name, helptext):
    return subparsers.add_parser(name, help=helptext, parents=[CWD_OPTION])


def parser():
    root = argparse.ArgumentParser(prog='agents-hub', description=__doc__)
    root.add_argument('--cwd', dest='root_cwd', help='Act as if run from this directory')
    sub = root.add_subparsers(dest='command', required=True)

    command(sub, 'scope', 'Show the memory/chat scope for this directory').set_defaults(run=cmd_scope)

    mem = command(sub, 'memory', 'Shared memory').add_subparsers(dest='action', required=True)
    command(mem, 'show', 'Print global and project MEMORY.md').set_defaults(run=cmd_memory_show)
    add = command(mem, 'add', 'Add a new memory file (never edits existing ones)')
    add.add_argument('name')
    add.add_argument('--description', required=True)
    add.add_argument('--body', required=True, help="Text, or '-' to read stdin")
    add.add_argument('--type', default='project', choices=['user', 'feedback', 'project', 'reference'])
    add.add_argument('--author', required=True, help='codex, opencode, cursor, aider, continue, ...')
    add.add_argument('--global', dest='use_global', action='store_true')
    add.add_argument('--supersedes', help='Name of the memory this one corrects')
    add.set_defaults(run=cmd_memory_add)
    adopt = command(mem, 'adopt', 'Move Claude memory folders into the hub and link them back')
    adopt.add_argument('--running-ok', action='store_true', help='Proceed while Claude or Codex is running')
    adopt.set_defaults(run=cmd_memory_adopt)
    command(mem, 'provision', 'SessionStart hook for Claude').set_defaults(run=cmd_memory_provision)
    rollback = command(mem, 'rollback', 'Undo one adopt run from its backup folder')
    rollback.add_argument('backup')
    rollback.set_defaults(run=cmd_memory_rollback)
    doctor = command(mem, 'doctor', 'Report (or --fix) unlinked folders and missing index lines')
    doctor.add_argument('--fix', action='store_true')
    doctor.set_defaults(run=cmd_memory_doctor)

    learning = command(sub, 'learn', 'Turn recurring memories into shared skills').add_subparsers(
        dest='action', required=True)
    command(learning, 'candidates', 'List feedback/user memories not yet in a skill').set_defaults(
        run=cmd_learn_candidates)
    promote = command(learning, 'promote', 'Add memories to a learned skill (creates it if new)')
    promote.add_argument('skill')
    promote.add_argument('refs', nargs='+', help='scope/file.md, as printed by `learn candidates`')
    promote.add_argument('--description', help='Required for a new skill: when agents should use it')
    promote.set_defaults(run=cmd_learn_promote)

    account = command(sub, 'account', 'Extra logins for clients that support them (claude, codex)').add_subparsers(
        dest='action', required=True)
    account_add = command(account, 'add', 'Add an extra login sharing the first login\'s settings and history')
    account_add.add_argument('client')
    account_add.add_argument('alias', help='Shell alias and default folder name (~/.<alias>)')
    account_add.add_argument('--dir', help='Folder for the login (default ~/.<alias>)')
    account_add.set_defaults(run=cmd_account_add)
    command(account, 'list', 'Each client\'s first login and extra accounts, with status').set_defaults(
        run=cmd_account_list)
    account_remove = command(account, 'remove', 'Unlink an extra login; its folder and login files stay')
    account_remove.add_argument('client')
    account_remove.add_argument('alias')
    account_remove.set_defaults(run=cmd_account_remove)

    command(sub, 'scheduled', 'Index chats and repair memory; run by the installed scheduler').set_defaults(
        run=cmd_scheduled)

    idx = command(sub, 'index', 'Import changed chat sessions into the search index')
    idx.add_argument('--rebuild', action='store_true')
    idx.add_argument('--verbose', action='store_true', help='Print counts even when nothing changed')
    idx.set_defaults(run=cmd_index)

    search = command(sub, 'search', 'Search chats')
    search.add_argument('query', nargs='+')
    search.add_argument('--agent')
    search.add_argument('--limit', type=int, default=10)
    recent = command(sub, 'recent', 'Recent sessions')
    recent.add_argument('--limit', type=int, default=15)
    read = command(sub, 'read', 'Read part of one session')
    read.add_argument('agent')
    read.add_argument('session')
    read.add_argument('--start', type=int, default=0)
    read.add_argument('--count', type=int, default=40)

    brief = command(sub, 'handoff', 'Write a brief of a session for another agent')
    brief.add_argument('agent')
    brief.add_argument('session')

    for parsed, run in ((search, cmd_search), (recent, cmd_recent), (read, cmd_read), (brief, cmd_handoff)):
        parsed.add_argument('--all-scopes', action='store_true', help='Every project, not just this one')
        parsed.set_defaults(run=run)

    return root


def main(argv=None):
    args = parser().parse_args(argv)
    paths = Paths.from_env()
    try:
        args.run(paths, args)
    except (accounts.AccountError, memory.MemoryError, scope.ScopeError, LookupError, FileNotFoundError) as error:
        sys.exit(f'agents-hub: {error}')
