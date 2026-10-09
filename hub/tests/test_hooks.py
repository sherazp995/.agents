"""The shared completion-check Stop hook (Codex side) and the adapter's Stop handling."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HOOKS = Path(__file__).resolve().parents[2] / 'hooks'
CHECK = HOOKS / 'bin' / 'completion-check'
ADAPTER = HOOKS / 'adapters' / 'run.py'

FAKE_CODEX = '''#!/bin/sh
# Records that it ran, then writes the canned answer to the file after -o.
echo ran >> "$FAKE_LOG"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { shift; printf '%s' "$FAKE_ANSWER" > "$1"; }; shift; done
'''


class CompletionCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        bin_dir = Path(self.tmp.name) / 'bin'
        bin_dir.mkdir()
        codex = bin_dir / 'codex'
        codex.write_text(FAKE_CODEX)
        codex.chmod(0o755)
        self.log = Path(self.tmp.name) / 'codex.log'
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'FAKE_LOG': str(self.log)}
        self.env.pop('AGENTS_HUB_IN_COMPLETION_CHECK', None)

    def tearDown(self):
        self.tmp.cleanup()

    def run_check(self, answer, **event):
        event = {'event': 'turn_completed', 'cwd': self.tmp.name, 'transcript_path': '/t.jsonl', **event}
        result = subprocess.run([sys.executable, str(CHECK)], input=json.dumps(event), capture_output=True,
                                text=True, env={**self.env, 'FAKE_ANSWER': answer})
        return json.loads(result.stdout) if result.stdout.strip() else None

    def test_answers_without_finish_or_fix_lines_let_the_turn_end(self):
        for answer in ('OK, nothing to do.', 'SKIP', 'The task is complete and I found no issues.', ''):
            self.assertIsNone(self.run_check(answer), answer)

    def test_findings_block_the_stop_with_the_checker_text(self):
        verdict = self.run_check('FIX: install.py:12 typo')

        self.assertEqual(verdict, {'decision': 'deny', 'reason': 'FIX: install.py:12 typo'})

    def test_an_already_checked_turn_or_the_checkers_own_run_is_skipped(self):
        self.assertIsNone(self.run_check('FIX: x', stop_hook_active=True))
        self.env['AGENTS_HUB_IN_COMPLETION_CHECK'] = '1'
        self.assertIsNone(self.run_check('FIX: x'))
        self.assertFalse(self.log.exists())  # codex never started in either case

    def test_the_prompt_sent_to_codex_has_no_claude_header_lines(self):
        from importlib.machinery import SourceFileLoader
        module = SourceFileLoader('completion_check', str(CHECK)).load_module()

        body = module.prompt_body()

        self.assertFalse(body.startswith(('status:', 'model:')))
        self.assertIn('$ARGUMENTS', body)


class AdapterTimeoutTests(unittest.TestCase):
    def run_slow(self, sleep_seconds, timeout):
        with tempfile.TemporaryDirectory() as tmp:
            hooks = Path(tmp)
            (hooks / 'adapters').mkdir()
            (hooks / 'bin').mkdir()
            adapter = hooks / 'adapters' / 'run.py'
            adapter.write_text(ADAPTER.read_text())
            marker = hooks / 'child-finished'
            script = hooks / 'bin' / 'slow'
            # The script starts a child (like codex exec) that outlives it unless the whole group dies.
            script.write_text(f"#!/bin/sh\n(sleep {sleep_seconds}; touch {marker}) &\nwait\n"
                              "echo '{\"decision\": \"deny\", \"reason\": \"FINISH: x\"}'\n")
            script.chmod(0o755)
            native = {'hook_event_name': 'Stop', 'transcript_path': '/t.jsonl'}
            result = subprocess.run([sys.executable, str(adapter), 'codex', 'slow', '--timeout', str(timeout)],
                                    input=json.dumps(native), capture_output=True, text=True)
            import time
            time.sleep(sleep_seconds + 0.5)
            return result, marker.exists()

    def test_a_check_slower_than_30s_default_but_within_its_timeout_still_blocks(self):
        result, _ = self.run_slow(sleep_seconds=1, timeout=5)

        self.assertEqual(result.returncode, 2)

    def test_a_timed_out_check_leaves_no_process_behind(self):
        result, child_finished = self.run_slow(sleep_seconds=2, timeout=1)

        self.assertEqual(result.returncode, 0)  # fail-open: the turn may end
        self.assertFalse(child_finished)


class AdapterStopTests(unittest.TestCase):
    def test_a_deny_on_stop_blocks_the_turn_in_the_native_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            hooks = Path(tmp)
            (hooks / 'adapters').mkdir()
            (hooks / 'bin').mkdir()
            adapter = hooks / 'adapters' / 'run.py'
            adapter.write_text(ADAPTER.read_text())
            script = hooks / 'bin' / 'probe'
            script.write_text('#!/bin/sh\necho \'{"decision": "deny", "reason": "finish the tests"}\'\n')
            script.chmod(0o755)
            native = {'hook_event_name': 'Stop', 'transcript_path': '/t.jsonl', 'stop_hook_active': False}

            result = subprocess.run([sys.executable, str(adapter), 'codex', 'probe'], input=json.dumps(native),
                                    capture_output=True, text=True)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout), {'decision': 'block', 'reason': 'finish the tests'})


if __name__ == '__main__':
    unittest.main()
