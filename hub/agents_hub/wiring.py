"""What install.py writes and check.py verifies: one definition shared by both.

Covers the rules reference each client loads, the hooks the hub owns in Claude
settings.json and Codex hooks.json, and the Codex agent files generated from
agents/*.md. Nothing here writes to disk.
"""
import json
from pathlib import Path
import re
import shlex
import tomllib

MARKER = 'managed by ~/.agents/install.py'  # only files carrying this are ever replaced
PROMPT_MARKER = '<!-- agents-hub hook: {name} -->'
PROMPT_MARKER_RE = re.compile(r'^<!-- agents-hub hook: (\S+) -->$', re.M)
PROMPT_TIMEOUT = 240
PROMPT_HEADERS = ('status', 'model')
# Unmarked hooks written by hand before the hub managed them: name -> a line only that prompt contains.
LEGACY_PROMPTS = {'completion-check': 'You are a READ-ONLY completion checker'}


class WiringError(Exception):
    pass


# Claude memory provisioning hook

def provision_command(hub):
    """Calls the hub's own launcher, which finds a Python 3.11+ itself; no interpreter is pinned."""
    return f'{shlex.quote(str(hub / "hub" / "agents-hub"))} memory provision'


def is_provision_hook(hook):
    """True only for the command install.py generates, with or without an older pinned interpreter."""
    try:
        words = shlex.split(hook.get('command', ''))
    except ValueError:
        return False
    if words[:1] and Path(words[0]).name.startswith('python'):
        words = words[1:]
    return len(words) == 3 and Path(words[0]).name == 'agents-hub' and words[1:] == ['memory', 'provision']


# Rules references

def load_yaml(path):
    """Parsed YAML, or None when PyYAML is not installed (callers must say they could not verify)."""
    try:
        import yaml
    except ImportError:
        return None
    return yaml.safe_load(path.read_text()) or {}


def rules_snippet(name, agents_md):
    return {'aider': f'read:\n  - {agents_md}',
            'continue': f'rules:\n  - name: Shared agent rules\n    rule: Read and follow {agents_md}.'}[name]


def merged_reference(name, path, agents_md):
    """True if a merge-mode config loads agents_md, False if not, None if PyYAML is missing."""
    if not path.exists():
        return False
    data = load_yaml(path)
    if data is None:
        return None
    if not isinstance(data, dict):
        return False
    wanted = str(agents_md)
    if name == 'aider':
        read = data.get('read')
        return wanted in ([read] if isinstance(read, str) else read if isinstance(read, list) else [])
    rules = data.get('rules')
    for rule in rules if isinstance(rules, list) else []:
        text = rule.get('rule', '') if isinstance(rule, dict) else rule
        if isinstance(text, str) and wanted in text:
            return True
    return False


def render(template, agents_md):
    return template.read_text().replace('{AGENTS_MD}', str(agents_md))


def rendered_reference(path, template, agents_md):
    """A rendered rule loads agents_md only if it carries MARKER and the template's reference line."""
    if path.is_symlink() or not path.is_file():
        return False
    text = path.read_text(errors='replace')
    lines = set(text.splitlines())
    references = [line for line in render(template, agents_md).splitlines()
                  if str(agents_md) in line and line.strip()]
    return MARKER in text and bool(references) and all(line in lines for line in references)


# Hooks

HOST_TIMEOUT_MARGIN = 15  # the agent waits a little longer than the adapter, so the adapter decides


def adapter_command(hub, client, name, fail_closed=False, timeout=None):
    words = [str(hub / 'hooks' / 'adapters' / 'run.py'), client, name]
    words += (['--fail-closed'] if fail_closed else []) + (['--timeout', str(timeout)] if timeout else [])
    return shlex.join(words)


def read_prompt(hub, name):
    """(prompt, headers) from hooks/prompts/<name>.md. Leading `status:`/`model:` lines are
    headers, not prompt text; blank lines around the prompt are dropped."""
    path = hub / 'hooks' / 'prompts' / f'{name}.md'
    if not path.is_file():
        raise WiringError(f'{path} is missing; hook {name} needs it')
    lines = path.read_text().splitlines()
    headers = {}
    while lines:
        match = re.match(r'^(\w+):\s*(.*)$', lines[0])
        if not match or match.group(1) not in PROMPT_HEADERS:
            break
        headers[match.group(1)] = match.group(2).strip()
        lines.pop(0)
    return '\n'.join(lines).strip('\n') + '\n', headers


def desired_hook(hub, client, entry):
    """(event, matcher, native hook dict) for one registry hook entry."""
    name, kind = entry['name'], entry.get('kind')
    event, matcher = entry['event'], entry.get('matcher', '')
    if kind == 'prompt':
        if client != 'claude':
            raise WiringError(f'{client}: prompt hook {name} is supported only for claude')
        prompt, headers = read_prompt(hub, name)
        hook = {'type': 'agent', 'prompt': PROMPT_MARKER.format(name=name) + '\n' + prompt,
                'timeout': PROMPT_TIMEOUT}
        if headers.get('model'):
            hook['model'] = headers['model']
        if headers.get('status'):
            hook['statusMessage'] = headers['status']
    elif kind == 'command':
        if client not in ('claude', 'codex'):
            raise WiringError(f'{client}: command hooks are supported only for claude and codex')
        timeout = entry.get('timeout')
        hook = {'type': 'command',
                'command': adapter_command(hub, client, name, entry.get('fail_closed', False), timeout)}
        if timeout:
            hook['timeout'] = timeout + HOST_TIMEOUT_MARGIN
    else:
        raise WiringError(f'{client}: hook {name} has unknown kind {kind!r}')
    return event, matcher, hook


def hook_owner(hook, hub, client):
    """The registry hook name this hub owns `hook` as, else None."""
    if hook.get('type') == 'agent':
        first = hook.get('prompt', '').split('\n', 1)[0]
        match = PROMPT_MARKER_RE.match(first)
        if match:
            return match.group(1)
    if hook.get('type') == 'command':
        try:
            words = shlex.split(hook.get('command', ''))
        except ValueError:
            return None
        adapter = str(hub / 'hooks' / 'adapters' / 'run.py')
        options = words[3:]
        if '--fail-closed' in options:
            options.remove('--fail-closed')
        if options[:1] == ['--timeout'] and len(options) == 2 and options[1].isdigit():
            options = []
        if len(words) >= 3 and words[0] == adapter and words[1] == client and not options:
            return words[2]
    return None


def legacy_owner(hook):
    """The hook name an unmarked, hand-written predecessor belongs to, else None."""
    if hook.get('type') != 'agent':
        return None
    lines = set(line.strip() for line in hook.get('prompt', '').splitlines())
    for name, line in LEGACY_PROMPTS.items():
        if any(text.startswith(line) for text in lines):
            return name
    return None


def hook_entries(config):
    """(event, matcher, hook) for every hook in a parsed Claude settings.json or Codex hooks.json."""
    return [(event, group.get('matcher', ''), hook)
            for event, groups in (config.get('hooks') or {}).items() for group in groups
            for hook in group.get('hooks', [])]


# Agent definitions

def parse_agent(path):
    """(front matter dict, body) of an agents/<name>.md file. Only flat `key: value` lines are read."""
    text = path.read_text()
    match = re.match(r'---\n(.*?)\n---\n?(.*)', text, re.S)
    if not match:
        raise WiringError(f'{path} has no front matter')
    meta = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(':')
        if not sep or line[:1].isspace():
            continue
        value = value.strip()
        if value.startswith('"'):
            value = json.loads(value)
        elif value.startswith("'") and value.endswith("'") and len(value) > 1:
            value = value[1:-1].replace("''", "'")
        meta[key.strip()] = value
    for key in ('name', 'description'):
        if not meta.get(key):
            raise WiringError(f'{path} has no {key} in its front matter')
    return meta, match.group(2).strip()


def toml_string(value):
    """A TOML basic string; every control character is escaped."""
    named = {'"': '\\"', '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r', '\b': '\\b', '\f': '\\f'}
    out = []
    for char in value:
        if char in named:
            out.append(named[char])
        elif ord(char) < 0x20 or ord(char) == 0x7f:
            out.append(f'\\u{ord(char):04X}')
        else:
            out.append(char)
    return '"' + ''.join(out) + '"'


def codex_agent(path):
    """The generated ~/.codex/agents/<name>.toml text for agents/<name>.md."""
    meta, body = parse_agent(path)
    return (f'# {MARKER}; edit {path.name} in ~/.agents/agents instead\n'
            f'name = {toml_string(meta["name"])}\n'
            f'description = {toml_string(meta["description"])}\n'
            f'developer_instructions = {toml_string(body)}\n')


def same_toml(left, right):
    try:
        return tomllib.loads(left) == tomllib.loads(right)
    except tomllib.TOMLDecodeError:
        return False
