"""no-remote-writes: in an autonomous run, remote writes are denied and local or read-only work passes."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from helpers import AGENTS

HOOK = AGENTS / 'hooks' / 'bin' / 'no-remote-writes'
ADAPTER = AGENTS / 'hooks' / 'adapters' / 'run.py'

BLOCKED = [
    'git push',
    'git status && git push origin feature',
    'git log -1; git -c push.default=current push -u origin HEAD',
    'echo "$(git push --force)"',
    'bash -c "cd repo && git push"',
    'eval git push origin main',
    'env GIT_TRACE=1 timeout 60 git push',
    'git send-email --to x@y.z 0001.patch',
    'gh pr create --title x --body y',
    'gh pr merge 12 --squash',
    'gh pr comment 12 --body hi',
    'gh issue create -t x',
    'gh release create v1',
    'gh api -X POST repos/o/r/issues',
    'gh api repos/o/r/issues/1/comments -f body=hi',
    'gh api graphql -F query=@q.graphql',
    'gh api --method=PATCH repos/o/r',
    'curl -X POST https://api.example.com/hook',
    'curl -sd "a=1" https://example.com/form',
    'curl --json \'{"a":1}\' example.com/api',
    'wget --post-data=a=1 https://example.com',
    'npm publish --access public',
    'gem push pkg.gem',
    'cargo publish',
    'docker push org/image:tag',
    'scp build.tar deploy@prod.example.com:/srv',
    'rsync -av dist/ prod:/var/www',
    'ssh prod.example.com "touch x"',
    'relay daemon stop',
]

ALLOWED = [
    'git status && git diff --stat',
    'git commit -m "Block git push in the hook"',
    'git fetch origin && git log origin/main..HEAD',
    'gh pr view 12 --json title',
    'gh pr list --state open',
    'gh pr diff 12',
    'gh pr checks 12',
    'gh issue view 3',
    'gh run view 99 --log',
    'gh auth status',
    'gh api repos/o/r/pulls/12',
    'gh api -X GET search/issues -f q=bug',
    'gh search prs --author @me',
    'curl -s https://example.com/status',
    'curl -X POST http://localhost:3000/api/items -d a=1',
    'curl -d a=1 127.0.0.1:8080/x',
    'wget https://example.com/file.tar.gz',
    'npm test && npm run build',
    'rsync -a prod:/var/log/app.log ./logs/',
    'echo git push',
    'relay notify "run done"',
    'relay notify --file report.md "run done"',
]


class NoRemoteWritesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = Path(self.tmp.name)
        self.slack(None)

    def slack(self, thread):
        (self.run_dir / 'state.json').write_text(json.dumps({'slack': thread}))

    def verdict(self, command=None, tool='Bash', run=True, session=None, root=None):
        event = {'event': 'before_tool', 'tool': tool, 'session_id': session,
                 'input': {'command': command} if command else {}}
        env = {k: v for k, v in os.environ.items() if k not in ('AGENTS_AUTONOMOUS_RUN', 'AGENTS_AUTONOMOUS_ROOT')}
        env['AGENTS_AUTONOMOUS_ROOT'] = str(root or self.run_dir / 'no-runs')
        if run:
            env['AGENTS_AUTONOMOUS_RUN'] = str(self.run_dir)
        result = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(event), capture_output=True,
                                text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def test_blocks_remote_writes(self):
        for command in BLOCKED:
            with self.subTest(command=command):
                verdict = self.verdict(command)
                self.assertIsNotNone(verdict)
                self.assertEqual(verdict['decision'], 'deny')
                self.assertIn('Remote writes are off in autonomous runs', verdict['reason'])

    def test_allows_local_and_read_only_work(self):
        for command in ALLOWED:
            with self.subTest(command=command):
                self.assertIsNone(self.verdict(command))

    def test_inactive_outside_an_autonomous_run(self):
        self.assertIsNone(self.verdict('git push', run=False))
        self.assertIsNone(self.verdict(tool='mcp__claude_ai_Slack__slack_send_message', run=False))

    def test_a_here_run_guards_only_the_chat_that_owns_it(self):
        runs = self.run_dir / 'runs'
        run_dir = runs / 'r1'
        run_dir.mkdir(parents=True)
        (run_dir / 'state.json').write_text(json.dumps({
            'mode': 'here', 'slack': None, 'owner': {'session': 'chat-1', 'pid': os.getpid()},
            'report_claimed': False, 'groups': [{'status': 'pending'}]}))
        (runs / 'here-sessions').mkdir()
        (runs / 'here-sessions' / 'chat-1').write_text(str(run_dir))
        self.assertEqual(self.verdict('git push', run=False, session='chat-1', root=runs)['decision'], 'deny')
        self.assertIsNone(self.verdict('relay notify "run done"', run=False, session='chat-1', root=runs))
        self.assertIsNone(self.verdict('git push', run=False, session='chat-2', root=runs))
        state = json.loads((run_dir / 'state.json').read_text())
        state['owner']['pid'] = 999999  # the owning chat has closed
        (run_dir / 'state.json').write_text(json.dumps(state))
        self.assertIsNone(self.verdict('git push', run=False, session='chat-1', root=runs))

    def test_relay_live_say_only_in_the_runs_own_thread(self):
        say = 'relay live say --channel C1 --thread 17.5 --text done --file report.md'
        self.assertIn('started from the terminal', self.verdict(say)['reason'])
        self.slack({'channel': 'C1', 'thread': '17.5'})
        self.assertIsNone(self.verdict(say))
        self.assertIn('--channel C1 --thread 17.5',
                      self.verdict(say.replace('17.5', '99.1'))['reason'])

    def test_blocks_posting_tools_but_not_the_qa_browser(self):
        for tool in ('mcp__claude_ai_Slack__slack_send_message', 'mcp__github__create_pull_request',
                     'mcp__playwright-extension__browser_click', 'Artifact'):
            with self.subTest(tool=tool):
                self.assertEqual(self.verdict(tool=tool)['decision'], 'deny')
        for tool in ('mcp__playwright__browser_click', 'mcp__plugin_playwright_playwright__browser_navigate',
                     'Read', 'Edit'):
            with self.subTest(tool=tool):
                self.assertIsNone(self.verdict(tool=tool))

    def test_an_unparseable_command_that_may_push_is_denied(self):
        self.assertIn('could not be parsed', self.verdict('git push "unclosed')['reason'])
        self.assertIsNone(self.verdict('ls "unclosed'))

    def test_the_adapter_turns_a_deny_into_claudes_pretooluse_block(self):
        native = {'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'cwd': str(self.run_dir),
                  'tool_input': {'command': 'git status && git push'}}
        env = dict(os.environ, AGENTS_AUTONOMOUS_RUN=str(self.run_dir))
        result = subprocess.run([sys.executable, str(ADAPTER), 'claude', 'no-remote-writes', '--fail-closed'],
                                input=json.dumps(native), capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 2)
        output = json.loads(result.stdout)['hookSpecificOutput']
        self.assertEqual(output['permissionDecision'], 'deny')
        self.assertIn('git push', output['permissionDecisionReason'])


if __name__ == '__main__':
    unittest.main()
