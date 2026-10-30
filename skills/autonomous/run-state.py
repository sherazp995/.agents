#!/usr/bin/env python3
"""The state of one autonomous run: which stage each task is at, and on which tree each stage ran.

A run directory (~/.agents/tmp/autonomous/<run id>/) holds state.json, report.md, tasks/<task>.md
(each task's own report section), plans/ (the plans as launched) and the runner logs. launch.sh
creates it with `init`; the headless session moves each task through its stages with the commands
below, which are the only writers of state.json (one lock, atomic replace, so the sessions of
several repo groups can write at once).

Stages, in order: approval, worktree, build, review, qa-visual, qa-video, done-check, commit.

A finished stage counts only for what it ran on:
- approval: the plan's approval hash (plan-approval.py); a plan edited after its yes stops the task.
- worktree: the worktree path; a missing worktree reopens it.
- build, review, qa-visual, qa-video, done-check: the hash of the worktree's content (tracked and
  untracked files, ignored files and QA or test output folders left out). When the tree changes after
  such a stage finished, `next` reopens the first stage that ran on an older tree, so a repair after
  review reruns the build checks and the review recheck, and a repair after QA reruns the stages after it.
- commit: the commit made; the task is then done.

Commands (each prints one line or JSON; a refusal exits 1 with the reason on stderr):
  init <run dir> [--engine E] [--mode here --session S --owner-pid P | --slack-channel C --slack-thread T] <plan>...
                                   JSON: groups, stopped plans
  next <run dir> <task>            the stage to run now, `done`, or `stopped: <reason>`
  start <run dir> <task> <stage>   marks the stage running (only the stage `next` names)
  finish <run dir> <task> <stage> [--worktree PATH] [--commit SHA] [--skipped REASON] [--result TEXT]
  stop <run dir> <task> <reason>   the task stops; the run goes on with the next task
  queue <run dir> <group>          the group's tasks still to run, one per line, in order
  show <run dir>                   state.json
  report <run dir>                 writes report.md from state.json and tasks/*.md, prints its path
  group-started <run dir> <group> <pid> <log>
  group-done <run dir> <group>     the session finished its group: `last` (write and send the report), `wait`,
                                   or in a here run `next` (go on with the next group's prompt)
  group-exit <run dir> <group> <exit code>   the runner saw the session exit: `ok`, `crashed` or `crashed last`
  resume <run dir>                 groups to start again (unfinished tasks, no live session), one per line
  claim <run dir> --session S --owner-pid P   a here run's new owning chat; refused while another live
                                   chat owns it; then prints the groups still to run, like resume

A here run (launch.sh --here) runs in the user's own chat. Its owner (that chat's session id and its
host process) is recorded in state.json and in <runs root>/here-sessions/<session>, so the hooks
(no-remote-writes, done-check) find the run from the session id alone: here_run_for(session).
"""
import contextlib
import datetime
import fcntl
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
approval = SourceFileLoader('plan_approval', str(HERE / 'plan-approval.py')).load_module()

STAGES = ('approval', 'worktree', 'build', 'review', 'qa-visual', 'qa-video', 'done-check', 'commit')
TREE_STAGES = ('build', 'review', 'qa-visual', 'qa-video', 'done-check')
SKIPPABLE = ('qa-visual', 'qa-video')
# Output that QA and test runs write inside the worktree; it is evidence, not part of the change.
OUTPUT_DIRS = ('tmp/visual-qa', 'tmp/video-qa', 'tmp/test-cache')
ENDED = ('done', 'stopped')


class Refusal(Exception):
    """A command that cannot run as asked; the message says why."""


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


def git(directory, *args, env=None):
    result = subprocess.run(['git', *args], cwd=directory, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise Refusal(f'git {args[0]} failed in {directory}: {result.stderr.strip()}')
    return result.stdout.strip()


def tree_hash(worktree):
    """The tree object of the worktree's content now, staged, unstaged and untracked alike, without
    touching its index. A fresh index (HEAD's tree, no stat cache, so every file is read) takes
    `git add -A`, then `git write-tree`. QA and test output folders are left out even when tracked."""
    if not Path(worktree).is_dir():
        raise Refusal(f'worktree {worktree} does not exist')
    with tempfile.TemporaryDirectory() as scratch:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(scratch) / 'index'))
        git(worktree, 'read-tree', 'HEAD', env=env)
        git(worktree, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', *OUTPUT_DIRS, env=env)
        git(worktree, 'add', '-A', '--', '.', *(f':(exclude){d}' for d in OUTPUT_DIRS), env=env)
        return git(worktree, 'write-tree', env=env)


@contextlib.contextmanager
def locked(run_dir, create=False):
    """state.json for read-modify-write under one lock; written back atomically when the block succeeds."""
    run_dir = Path(run_dir)
    path = run_dir / 'state.json'
    if not create and not path.is_file():
        raise Refusal(f'{run_dir} has no state.json')
    run_dir.mkdir(parents=True, exist_ok=True)
    with open(run_dir / '.state.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(path.read_text()) if path.is_file() else {}
        yield state
        temporary = path.with_name('.state.json.tmp')
        temporary.write_text(json.dumps(state, indent=2) + '\n')
        os.replace(temporary, path)


def read_state(run_dir):
    path = Path(run_dir) / 'state.json'
    if not path.is_file():
        raise Refusal(f'{run_dir} has no state.json')
    return json.loads(path.read_text())


def task_of(state, task):
    if task not in state.get('tasks', {}):
        raise Refusal(f'no task {task!r} in this run')
    return state['tasks'][task]


def task_ids(plans):
    ids = []
    for plan in plans:
        base = re.sub(r'[^A-Za-z0-9._-]+', '-', Path(plan).stem).strip('-') or 'task'
        name, n = base, 2
        while name in ids:
            name, n = f'{base}-{n}', n + 1
        ids.append(name)
    return ids


def init(run_dir, plans, engine='claude', slack=None, mode='headless', owner=None):
    run_dir = Path(run_dir).resolve()
    if (run_dir / 'state.json').exists():
        raise Refusal(f'{run_dir} already holds a run')
    if not plans:
        raise Refusal('no plans to run')
    if mode == 'here' and slack:
        raise Refusal('a here run runs in your own chat, never from Slack')
    if mode == 'here' and not owner:
        raise Refusal('a here run needs its owning chat (--session and --owner-pid)')
    (run_dir / 'plans').mkdir(parents=True, exist_ok=True)
    (run_dir / 'tasks').mkdir(exist_ok=True)
    tasks, groups, stopped = {}, [], []
    for task, plan in zip(task_ids(plans), plans):
        plan = str(Path(plan).expanduser().resolve())
        entry = {'plan': plan, 'repo': None, 'group': None, 'status': 'pending', 'stop_reason': None,
                 'stopped_stage': None, 'worktree': None, 'commit': None, 'stages': {}}
        try:
            found = approval.verify(plan)
        except approval.PlanError as error:
            entry.update(status='stopped', stop_reason=f'approval: {error}', stopped_stage='approval')
            stopped.append({'task': task, 'plan': plan, 'reason': entry['stop_reason']})
        else:
            shutil.copyfile(plan, run_dir / 'plans' / f'{task}.md')
            entry['repo'] = found['Repo']
            entry['stages']['approval'] = {'status': 'done', 'tree': found['Approved-sha256'], 'finished': now()}
            group = next((i for i, g in enumerate(groups) if g['repo'] == found['Repo']), None)
            if group is None:
                group = len(groups)
                groups.append({'repo': found['Repo'], 'tasks': [], 'status': 'pending', 'pid': None,
                               'log': None, 'exit': None})
            groups[group]['tasks'].append(task)
            entry['group'] = group
        tasks[task] = entry
    with locked(run_dir, create=True) as state:
        state.update(run_id=run_dir.name, run_dir=str(run_dir), created=now(), engine=engine, mode=mode,
                     slack=slack, owner=owner, report_claimed=False, order=list(tasks), groups=groups, tasks=tasks)
    if owner:
        bind(run_dir, owner['session'])
    return {'run_id': run_dir.name, 'run_dir': str(run_dir),
            'groups': [{'group': i, 'repo': g['repo'], 'tasks': g['tasks']} for i, g in enumerate(groups)],
            'stopped': stopped}


def stage_valid(entry, stage, record, current_tree):
    """Whether a finished stage still counts for what the task is now."""
    if not record or record.get('status') not in ('done', 'skipped'):
        return False
    if stage == 'worktree':
        return bool(entry.get('worktree')) and Path(entry['worktree']).is_dir()
    if stage in TREE_STAGES:
        return record.get('tree') == current_tree()
    return True


def next_stage(state, task):
    """(stage or None, stop reason or None). Stops the task, as a side effect, when its plan no longer verifies."""
    entry = task_of(state, task)
    if entry['status'] == 'stopped':
        return None, entry['stop_reason']
    if entry['status'] == 'done':
        return None, None
    try:
        found = approval.verify(entry['plan'])
    except approval.PlanError as error:
        stop(state, task, f'approval: {error}', 'approval')
        return None, entry['stop_reason']
    if entry['stages'].get('approval', {}).get('tree') != found['Approved-sha256']:
        entry['stages']['approval'] = {'status': 'done', 'tree': found['Approved-sha256'], 'finished': now()}
    cache = {}

    def current_tree():
        if 'tree' not in cache:
            cache['tree'] = tree_hash(entry['worktree'])
        return cache['tree']

    for stage in STAGES[1:]:
        if not stage_valid(entry, stage, entry['stages'].get(stage), current_tree):
            return stage, None
    return None, None


def stop(state, task, reason, stage=None):
    entry = task_of(state, task)
    if entry['status'] == 'done':
        raise Refusal(f'task {task} is already done')
    reason = ' '.join(str(reason).split())
    if not reason:
        raise Refusal('a stop needs a reason')
    if stage is None and entry['status'] != 'stopped':
        stage = next_stage(state, task)[0]
    stage = stage or entry.get('stopped_stage') or 'approval'
    entry.update(status='stopped', stop_reason=reason, stopped_stage=stage)


def start(state, task, stage):
    expected, reason = next_stage(state, task)
    if expected != stage:
        raise Refusal(f'task {task} is at {expected or (f"stopped: {reason}" if reason else "done")}, not {stage}')
    entry = task_of(state, task)
    entry['status'] = 'running'
    record = entry['stages'].get(stage, {})
    entry['stages'][stage] = {**record, 'status': 'running', 'started': now()}


def finish(state, task, stage, worktree=None, commit=None, skipped=None, result=None):
    if stage not in STAGES:
        raise Refusal(f'unknown stage {stage!r}; stages are {", ".join(STAGES)}')
    expected, reason = next_stage(state, task)
    entry = task_of(state, task)
    # A stage that repaired the worktree finishes on the new tree; `next` then reopens the stages before it.
    running = entry['status'] == 'running' and entry['stages'].get(stage, {}).get('status') == 'running'
    if expected != stage and not (running and stage in TREE_STAGES):
        raise Refusal(f'task {task} is at {expected or (f"stopped: {reason}" if reason else "done")}, not {stage}')
    if skipped and stage not in SKIPPABLE:
        raise Refusal(f'only {" and ".join(SKIPPABLE)} can be skipped')
    record = {**entry['stages'].get(stage, {}), 'status': 'skipped' if skipped else 'done', 'finished': now()}
    if skipped:
        record['skip_reason'] = ' '.join(skipped.split())
    if result:
        record['result'] = ' '.join(result.split())
    if stage == 'worktree':
        path = worktree or entry.get('worktree')
        if not path:
            raise Refusal('finish worktree needs --worktree <path>')
        entry['worktree'] = str(Path(path).expanduser().resolve())
        record['tree'] = tree_hash(entry['worktree'])
    elif stage in TREE_STAGES:
        record['tree'] = tree_hash(entry['worktree'])
    elif stage == 'commit':
        record['tree'] = tree_hash(entry['worktree'])
        entry['commit'] = commit or git(entry['worktree'], 'rev-parse', 'HEAD')
        record['commit'] = entry['commit']
    entry['stages'][stage] = record
    entry['status'] = 'done' if stage == 'commit' else 'running'


def queue(state, group):
    groups = state.get('groups', [])
    if not 0 <= group < len(groups):
        raise Refusal(f'no group {group} in this run')
    return [t for t in groups[group]['tasks'] if state['tasks'][t]['status'] not in ENDED]


def group_of(state, group):
    groups = state.get('groups', [])
    if not 0 <= group < len(groups):
        raise Refusal(f'no group {group} in this run')
    return groups[group]


def claim_report(state):
    """'last' once every group has ended and nobody has claimed the report yet."""
    if all(g['status'] in ('finished', 'crashed') for g in state['groups']) and not state.get('report_claimed'):
        state['report_claimed'] = True
        return True
    return False


def binding(root, session):
    return Path(root) / 'here-sessions' / re.sub(r'[^A-Za-z0-9_.-]', '_', str(session))


def bind(run_dir, session):
    file = binding(Path(run_dir).parent, session)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(str(run_dir))


def claim(state, session, pid):
    """A here run's new owner: refused while a different chat that owns it is still alive."""
    if state.get('mode') != 'here':
        raise Refusal('only a here run is claimed; resume a headless run with launch.sh --resume')
    if state.get('slack'):
        raise Refusal('a here run never has a Slack thread')
    owner = state.get('owner') or {}
    if owner.get('session') != session and pid_alive(owner.get('pid')):
        raise Refusal(f'chat {owner.get("session")} (pid {owner.get("pid")}) still owns this run; '
                      'finish it there, or close that chat first')
    if owner.get('session') and owner['session'] != session:
        binding(Path(state['run_dir']).parent, owner['session']).unlink(missing_ok=True)
    state['owner'] = {'session': session, 'pid': pid}
    bind(state['run_dir'], session)


def runs_root():
    return Path(os.environ.get('AGENTS_AUTONOMOUS_ROOT') or Path.home() / '.agents/tmp/autonomous')


def here_run_for(session, root=None):
    """The run directory of the live here run this session owns, or None."""
    if not session:
        return None
    try:
        run_dir = Path(binding(root or runs_root(), session).read_text().strip())
        state = json.loads((run_dir / 'state.json').read_text())
    except (OSError, ValueError):
        return None
    owner = state.get('owner') or {}
    if state.get('mode') != 'here' or owner.get('session') != session or not pid_alive(owner.get('pid')):
        return None
    if state.get('report_claimed') and all(g['status'] in ('finished', 'crashed') for g in state['groups']):
        return None
    return str(run_dir)


def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError):
        return False
    return True


def report(run_dir):
    """report.md: a status table for every task, then each task's own section from tasks/<task>.md."""
    run_dir = Path(run_dir)
    state = read_state(run_dir)
    lines = [f'# Autonomous run {state["run_id"]}', '', f'Started {state["created"]}, engine {state["engine"]}.', '',
             '| Task | Repo | Status | Commit | Worktree |', '| --- | --- | --- | --- | --- |']
    for task in state['order']:
        entry = state['tasks'][task]
        status = entry['status']
        if status == 'stopped':
            status = f'stopped at {entry["stopped_stage"]}: {entry["stop_reason"]}'
        elif status != 'done':
            stage, _ = next_stage(json.loads(json.dumps(state)), task)
            status = f'unfinished, at {stage}'
        cells = [task, entry['repo'] or '?', status, entry['commit'] or 'none', entry['worktree'] or 'none']
        lines.append('| ' + ' | '.join(str(c).replace('|', '\\|') for c in cells) + ' |')
    if any(state['tasks'][t]['status'] not in ENDED for t in state['order']):
        lines += ['', f'Unfinished tasks remain: resume with `{HERE / "launch.sh"} --resume {state["run_id"]}`.']
    for task in state['order']:
        section = run_dir / 'tasks' / f'{task}.md'
        lines += ['', f'## {task}', '']
        lines.append(section.read_text().strip() if section.is_file() else
                     f'No task report was written. Plan: {state["tasks"][task]["plan"]}')
    path = run_dir / 'report.md'
    path.write_text('\n'.join(lines) + '\n')
    return path


def option(args, name, default=None):
    if name in args:
        i = args.index(name)
        if i + 1 >= len(args):
            raise Refusal(f'{name} needs a value')
        value = args[i + 1]
        del args[i:i + 2]
        return value
    return default


def main(argv):
    if len(argv) < 2:
        print(__doc__.split('Commands')[1], file=sys.stderr)
        return 2
    command, run_dir, args = argv[0], argv[1], list(argv[2:])
    try:
        if command == 'init':
            engine = option(args, '--engine', 'claude')
            mode = option(args, '--mode', 'headless')
            if mode not in ('headless', 'here'):
                raise Refusal('--mode is headless or here')
            channel, thread = option(args, '--slack-channel'), option(args, '--slack-thread')
            if bool(channel) != bool(thread):
                raise Refusal('--slack-channel and --slack-thread go together')
            slack = {'channel': channel, 'thread': thread} if channel else None
            session, pid = option(args, '--session'), option(args, '--owner-pid')
            owner = {'session': session, 'pid': int(pid)} if session and pid and pid.isdigit() else None
            print(json.dumps(init(run_dir, args, engine, slack, mode, owner)))
        elif command == 'show':
            print(json.dumps(read_state(run_dir), indent=2))
        elif command == 'report':
            print(report(run_dir))
        elif command == 'resume':
            with locked(run_dir) as state:
                for i, group in enumerate(state['groups']):
                    if queue(state, i) and not pid_alive(group.get('pid')):
                        group.update(status='pending', pid=None, exit=None)
                        state['report_claimed'] = False
                        print(i)
        elif command == 'claim':
            session, pid = option(args, '--session'), option(args, '--owner-pid')
            if not session or not (pid or '').isdigit() or args:
                raise Refusal('claim needs --session S --owner-pid P')
            with locked(run_dir) as state:
                claim(state, session, int(pid))
                for i, group in enumerate(state['groups']):
                    if queue(state, i):
                        group.update(status='pending', pid=None, exit=None)
                        state['report_claimed'] = False
                        print(i)
        elif command in ('next', 'start', 'finish', 'stop') and args:
            task = args.pop(0)
            with locked(run_dir) as state:
                if command == 'next':
                    stage, reason = next_stage(state, task)
                    print(stage or (f'stopped: {reason}' if reason else 'done'))
                elif command == 'start' and len(args) == 1:
                    start(state, task, args[0])
                    print(f'{task}: {args[0]} started')
                elif command == 'finish' and args:
                    stage = args.pop(0)
                    finish(state, task, stage, worktree=option(args, '--worktree'), commit=option(args, '--commit'),
                           skipped=option(args, '--skipped'), result=option(args, '--result'))
                    if args:
                        raise Refusal(f'unexpected arguments: {" ".join(args)}')
                    print(f'{task}: {stage} finished')
                elif command == 'stop' and args:
                    stop(state, task, ' '.join(args))
                    print(f'{task}: stopped')
                else:
                    raise Refusal(f'wrong arguments for {command}')
        elif command in ('queue', 'group-started', 'group-done', 'group-exit') and args:
            group = int(args[0]) if args[0].isdigit() else -1
            with locked(run_dir) as state:
                entry = group_of(state, group)
                if command == 'queue':
                    print('\n'.join(queue(state, group)))
                elif command == 'group-started' and len(args) == 3:
                    entry.update(status='running', pid=int(args[1]), log=args[2], exit=None)
                elif command == 'group-done':
                    entry['status'] = 'finished'
                    if claim_report(state):
                        print('last')
                    elif state.get('mode') == 'here':
                        # One chat runs every group, so nobody else will send the report.
                        print('next')
                    else:
                        print('wait')
                elif command == 'group-exit' and len(args) == 2:
                    entry['exit'] = int(args[1])
                    if entry['status'] == 'finished':
                        print('ok')
                    else:
                        entry['status'] = 'crashed'
                        print('crashed last' if claim_report(state) else 'crashed')
                else:
                    raise Refusal(f'wrong arguments for {command}')
        else:
            raise Refusal(f'unknown command or missing arguments: {command}')
    except Refusal as error:
        print(f'run-state: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
