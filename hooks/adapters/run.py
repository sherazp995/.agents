#!/usr/bin/env python3
"""Run one shared hook script for one agent: `run.py <agent> <script-name>`.

Reads the agent's native hook payload on stdin, passes the script a normalized
event, and translates the script's verdict back into the agent's native format.

Normalized event (stdin of the script):
  {"event", "agent", "profile", "cwd", "session_id", "tool", "input"}
Script verdict (stdout, optional): {"decision": "deny", "reason": "..."}
An empty stdout means allow.

Failure policy: by default a hook that crashes, times out or prints something
unreadable allows, so a broken convenience hook never blocks work. Security
hooks run with --fail-closed: any such failure denies the tool call instead.

Usage: run.py <agent> <script-name> [--fail-closed] [--timeout SECONDS]

A script may add {"context": "..."}: extra instructions for the agent (with a deny they are
appended to the reason). A script may also answer {"decision": "ask", ...}: Claude Code then asks the user to approve
the tool call; agents without that ability (Codex) get a deny saying only the user can approve.
"""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys

SCRIPTS = Path(__file__).resolve().parent.parent / 'bin'

# Native event name -> normalized name. Claude and Codex share these names.
EVENTS = {
    'SessionStart': 'session_started',
    'PreToolUse': 'before_tool',
    'PostToolUse': 'after_tool',
    'Stop': 'turn_completed',
    'SessionEnd': 'session_ended',
}
ADAPTED_AGENTS = ('claude', 'codex')


def profile_for(agent):
    if agent == 'claude':
        return Path(os.environ.get('CLAUDE_CONFIG_DIR', '~/.claude')).expanduser().name
    return Path(os.environ.get('CODEX_HOME', '~/.codex')).expanduser().name


def tool_input(native):
    """Tool input with the shell command always under `command` as one string.

    Shell tools name the field `command` or `cmd`, and some pass argv as a list.
    """
    data = dict(native.get('tool_input') or {})
    command = data.get('command', data.get('cmd'))
    if isinstance(command, list):
        command = shlex.join(str(part) for part in command)
    if command is not None:
        data['command'] = command
    return data


def normalize(agent, native):
    return {
        'event': EVENTS.get(native.get('hook_event_name'), native.get('hook_event_name')),
        'agent': agent,
        'profile': profile_for(agent),
        # A shell tool can run in its own workdir; that, not the session cwd, is where it acts.
        'cwd': (native.get('tool_input') or {}).get('workdir') or native.get('cwd') or os.getcwd(),
        'session_id': native.get('session_id'),
        'tool': native.get('tool_name'),
        'input': tool_input(native),
        # Stop events: where the conversation is, and whether a hook already sent the agent back.
        'transcript_path': native.get('transcript_path'),
        # After a tool ran: what it reported (for example the file before a Write).
        'response': native.get('tool_response') or {},
        'stop_hook_active': bool(native.get('stop_hook_active')),
    }


def native_verdict(native, verdict):
    """A deny in the native shape: Stop blocks the turn from ending, tool events block the call."""
    reason = verdict.get('reason', 'Blocked by a shared hook.')
    if native.get('hook_event_name') in ('Stop', 'PostToolUse'):
        # Stop: the turn may not end yet. PostToolUse: the tool already ran; the reason goes back to the agent.
        return {'decision': 'block', 'reason': reason}
    # Claude and Codex both accept this PreToolUse response shape.
    return {'hookSpecificOutput': {
        'hookEventName': native.get('hook_event_name', 'PreToolUse'),
        'permissionDecision': 'deny',
        'permissionDecisionReason': verdict.get('reason', 'Blocked by a shared hook.'),
    }}


VERDICTS = ('allow', 'deny', 'ask')
# Agents that can put a tool call in front of the user for approval. Codex hooks reject "ask",
# so there an ask becomes a deny that tells the agent only the user can approve.
ASK_CAPABLE = ('claude',)


DEFAULT_TIMEOUT = 30


def run_script(script_name, native, agent, timeout=DEFAULT_TIMEOUT):
    """The script's verdict as a dict. Raises on any failure or malformed verdict.

    The script runs in its own process group, so a timeout kills everything it
    started (for example a model run), not just the script itself.
    """
    process = subprocess.Popen([str(SCRIPTS / script_name)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(json.dumps(normalize(agent, native)), timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise
    result = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
    if result.returncode != 0:
        raise RuntimeError(f'exit {result.returncode}: {result.stderr.strip()}')
    if not result.stdout.strip():
        return {'decision': 'allow'}
    verdict = json.loads(result.stdout)
    if not isinstance(verdict, dict) or verdict.get('decision', 'allow') not in VERDICTS:
        raise ValueError(f'unreadable verdict: {result.stdout.strip()[:200]}')
    return verdict


def main(argv):
    """Exit 2 with a reason on stderr is the deny every agent honours, even without JSON parsing."""
    agent, script_name = (argv + ['', ''])[:2]
    fail_closed = '--fail-closed' in argv[2:]
    timeout = int(argv[argv.index('--timeout') + 1]) if '--timeout' in argv[2:] else DEFAULT_TIMEOUT
    native = {}
    try:
        if agent not in ADAPTED_AGENTS:
            raise ValueError(f'no hook adapter for agent {agent!r}')
        native = json.loads(sys.stdin.read() or '{}')
        verdict = run_script(script_name, native, agent, timeout)
    except Exception as error:
        print(f'{script_name} failed: {error}', file=sys.stderr)
        if not fail_closed:
            return 0
        verdict = {'decision': 'deny', 'reason': f'{script_name} could not check this command ({error}); '
                                                 'blocked to be safe. Fix the hook or retry.'}
    decision = verdict.get('decision')
    context = verdict.get('context')
    if context and decision != 'deny':
        # Extra instructions for the agent (for example a skill to follow), nothing blocked.
        print(json.dumps({'hookSpecificOutput': {'hookEventName': native.get('hook_event_name', ''),
                                                 'additionalContext': context}}))
        return 0
    if context:
        verdict = {**verdict, 'reason': verdict.get('reason', '') + '\n\n' + context}
    if decision == 'ask' and native.get('hook_event_name') == 'PreToolUse' and agent in ASK_CAPABLE:
        print(json.dumps({'hookSpecificOutput': {
            'hookEventName': 'PreToolUse', 'permissionDecision': 'ask',
            'permissionDecisionReason': verdict.get('reason', 'A shared hook asks for approval.')}}))
        return 0  # the agent shows the user an approval prompt; JSON is only read on exit 0
    if decision == 'ask':
        verdict = {**verdict, 'reason': verdict.get('reason', '') + ' Ask the user; if they agree, they run it'
                                                                  ' themselves (this agent cannot approve it).'}
    elif decision != 'deny':
        return 0
    print(json.dumps(native_verdict(native, verdict)))
    print(verdict.get('reason', 'Blocked by a shared hook.'), file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
