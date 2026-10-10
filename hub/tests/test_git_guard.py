"""git-guard: rules 43, 48 and 54 checked before a shell command runs, and the adapter's ask handling."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOKS = Path(__file__).resolve().parents[2] / 'hooks'
GUARD = HOOKS / 'bin' / 'git-guard'
ADAPTER = HOOKS / 'adapters' / 'run.py'
GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@t']


class GitGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name).resolve()
        self.git('init', '-q')

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        subprocess.run(['git', *GIT_ID, *args], cwd=self.repo, check=True, capture_output=True)

    def commit(self, n):
        for i in range(n):
            self.git('commit', '-q', '--allow-empty', '-m', f'c{i}')

    def push_all(self):
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')  # as if pushed

    def verdict(self, command, cwd=None):
        event = {'event': 'before_tool', 'cwd': str(cwd or self.repo), 'input': {'command': command}}
        result = subprocess.run([sys.executable, str(GUARD)], input=json.dumps(event), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def guard(self, command, cwd=None):
        verdict = self.verdict(command, cwd)
        return verdict['reason'] if verdict else None

    def test_first_commit_on_a_clean_branch_is_allowed(self):
        self.assertIsNone(self.guard("git commit -m 'Add thing'"))
        self.commit(1)
        self.push_all()
        self.assertIsNone(self.guard("git commit -m 'Next thing'"))

    def test_a_second_unpushed_commit_is_denied_with_the_amend_to_run_instead(self):
        self.commit(1)

        verdict = self.verdict("git commit -m 'More'")
        self.assertEqual(verdict['decision'], 'deny')
        self.assertIn('git commit --amend --no-edit', verdict['reason'])
        self.assertNotIn('user', verdict['reason'])
        self.assertIsNone(self.guard("git commit --amend --no-edit"))

    def test_a_second_commit_with_a_rule_48_break_still_asks_the_user(self):
        self.commit(1)

        verdict = self.verdict("git commit -m 'Title' -m 'Body'")
        self.assertEqual(verdict['decision'], 'ask')
        self.assertIn('--amend', verdict['reason'])

    def test_several_unpushed_commits_ask_about_squashing_even_for_amend(self):
        self.commit(2)

        for command in ("git commit -m 'x'", 'git commit --amend --no-edit'):
            verdict = self.verdict(command)
            self.assertEqual(verdict['decision'], 'ask', command)
            self.assertIn('ask the user whether to squash', verdict['reason'])

    def test_amending_a_pushed_commit_asks(self):
        self.commit(1)
        self.push_all()

        verdict = self.verdict('git commit --amend --no-edit')
        self.assertEqual(verdict['decision'], 'ask')
        self.assertIn('already pushed', verdict['reason'])

    def test_multi_line_messages_and_claude_attribution_ask(self):
        self.assertIn('single line', self.guard("git commit -m 'Title' -m 'Body'"))
        heredoc = "git commit -m \"$(cat <<'EOF'\nTitle\n\nBody\nEOF\n)\""
        self.assertIn('single line', self.guard(heredoc) or '')
        self.assertIn('attribution', self.guard("git commit -m 'Fix Co-Authored-By: Claude <x>'"))

    def test_git_dash_c_asks(self):
        self.assertIn('rule 43', self.guard(f'git -C {self.repo} status'))

    def test_cd_into_another_repo_checks_that_repo(self):
        self.commit(1)
        elsewhere = Path(self.tmp.name).parent

        self.assertIn('--amend', self.guard(f"cd {self.repo} && git commit -m 'x'", cwd=elsewhere))

    def test_a_git_commit_that_cannot_be_checked_is_asked_about(self):
        self.assertIn('could not check', self.guard("cd /no/such/folder && git commit -m 'x'"))

    def test_commits_hidden_by_newlines_comments_or_subshells_are_still_checked(self):
        self.commit(1)

        for command in ("git status\ngit commit -m two", "cd .\ngit commit -m two",
                        "git add issue#3 && git commit -m two", "(git commit -m two)",
                        f"(cd {self.repo} && git commit -m two)"):
            self.assertIn('--amend', self.guard(command) or '', command)

    def test_wrappers_and_global_options_do_not_hide_a_commit(self):
        self.commit(1)

        for command in ("git -c k=v commit -m two", "git --no-pager commit -m two", "command git commit -m two",
                        "env git commit -m two", "env -u FOO git commit -m two",
                        "sudo -u me git commit -m two", "GIT_AUTHOR_NAME=x git commit -m two", "/usr/bin/git commit -am two"):
            self.assertIn('--amend', self.guard(command) or '', command)


    def test_line_continuations_cannot_hide_commits(self):
        self.commit(1)

        for command in ("git \\\ncommit -m two", "git -c user.name=x \\\ncommit -m two",
                        "gi\\\nt commit -m two"):
            self.assertIn('--amend', self.guard(command) or '', command)
        for command in ("git commit --amend -m 'title\\\nbody'",
                        "echo \"$(git commit --amend -m 'title\\\nbody')\""):
            self.assertIn('single line', self.guard(command) or '', command)
        self.assertIsNone(self.guard('git commit --amend -m "title\\\nbody"'))

    def test_executable_substitutions_are_checked_but_literal_text_is_allowed(self):
        self.commit(1)

        for command in ('echo $(git commit -m two)', 'echo "$(git commit -m two)"',
                        'echo `git commit -m two`', 'echo "`git commit -m two`"',
                        'echo "$(echo $(git commit -m two))"'):
            self.assertIn('--amend', self.guard(command) or '', command)
        for command in ("echo '$(git commit -m two)'", "echo '`git commit -m two`'",
                        r'echo \$(git commit -m two)', r'echo \`git commit -m two\`'):
            self.assertIsNone(self.guard(command), command)

    def test_substitution_cd_is_local_and_uses_the_current_directory(self):
        self.commit(1)
        elsewhere = self.repo / 'empty'
        elsewhere.mkdir()
        subprocess.run(['git', 'init', '-q'], cwd=elsewhere, check=True, capture_output=True)

        self.assertIsNone(self.guard(f'echo "$(cd {elsewhere} && git commit -m first)"'))
        self.assertIn('--amend', self.guard(f'echo "$(cd {elsewhere})"; git commit -m two') or '')
        self.assertIn('--amend', self.guard(f'cd {self.repo}; echo "$(git commit -m two)"', cwd=elsewhere) or '')

    def test_heredoc_apostrophes_and_parse_failures_still_ask_about_git_dash_c(self):
        command = f"git -C {self.repo} status && cat <<EOF\ndon't\nEOF"
        self.assertIn('rule 43', self.guard(command) or '')
        self.assertIn('rule 43', self.guard("cat <<EOF\nit's literal\nEOF\ngit -C /tmp log") or '')
        self.assertIn('could not check', self.guard(command + "\necho '") or '')

    def test_quoted_heredoc_substitutions_are_literal_but_unquoted_ones_execute(self):
        for delimiter in ("'EOF'", '"EOF"', r'\EOF'):
            command = f"cat <<{delimiter}\n$(git -C . status)\n`git -C . status`\nEOF"
            self.assertIsNone(self.guard(command), command)
            self.assertIn('rule 43', self.guard(command + '\ngit -C . status') or '')
        self.assertIsNone(self.guard("cat <<-'EOF'\n\t$(git -C . status)\n\tEOF"))
        for expansion in ('$(git -C . status)', '`git -C . status`'):
            command = f"cat <<EOF\n'{expansion}'\nEOF"
            self.assertIn('rule 43', self.guard(command) or '', command)
        self.assertIsNone(self.guard(r"cat <<EOF" + "\n" + r"\$(git -C . status) \`git -C . status\`" + "\nEOF"))

    def test_shell_comments_are_inert_but_hashes_inside_words_are_literal(self):
        self.assertIsNone(self.guard('echo ok # $(git -C . status) `git -C . status`'))
        self.assertIn('rule 43', self.guard('echo ok # $(git -C . status)\ngit -C . status') or '')
        self.assertIn('rule 43', self.guard('echo issue#$(git -C . status)') or '')
        self.assertIn('rule 43', self.guard('echo "#$(git -C . status)"') or '')

    def test_nested_substitution_boundaries_respect_comments_and_heredoc_data(self):
        for opener, closer in (('$(', ')'), ('`', '`')):
            for body in ("cat <<'EOF'\n)\n$(git -C . status)\nEOF\n",
                         'echo ok # ) $(git -C . status)\n'):
                command = f'echo "{opener}{body}{closer}"'
                self.assertIsNone(self.guard(command), command)
            body = 'cat <<EOF\n)\n$(git -C . status)\nEOF\n'
            self.assertIn('rule 43', self.guard(f'echo "{opener}{body}{closer}"') or '')

    def test_dash_c_after_the_subcommand_is_a_different_option(self):
        self.commit(1)
        self.push_all()

        for command in ('git log -C --stat', 'git diff -C HEAD~1'):
            self.assertIsNone(self.guard(command), command)

    def test_an_apostrophe_in_a_heredoc_without_a_commit_is_not_flagged(self):
        self.assertIsNone(self.guard("git status && cat <<EOF\ndon't\nEOF"))

    def test_non_git_commands_are_untouched(self):
        self.commit(3)

        self.assertIsNone(self.guard('ls -la && echo commit'))


class AdapterVerdictTests(unittest.TestCase):
    def run_adapter(self, agent, decision='ask'):
        with tempfile.TemporaryDirectory() as tmp:
            hooks = Path(tmp)
            (hooks / 'adapters').mkdir()
            (hooks / 'bin').mkdir()
            shutil.copy(ADAPTER, hooks / 'adapters' / 'run.py')
            script = hooks / 'bin' / 'probe'
            script.write_text(f'#!/bin/sh\necho \'{{"decision": "{decision}", "reason": "rule 54"}}\'\n')
            script.chmod(0o755)
            native = {'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'tool_input': {'command': 'git commit'}}
            return subprocess.run([sys.executable, str(hooks / 'adapters' / 'run.py'), agent, 'probe'],
                                  input=json.dumps(native), capture_output=True, text=True)

    def test_claude_gets_an_approval_prompt(self):
        result = self.run_adapter('claude')

        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['hookSpecificOutput']['permissionDecision'], 'ask')

    def test_codex_gets_a_deny_that_says_only_the_user_can_approve(self):
        result = self.run_adapter('codex')

        self.assertEqual(result.returncode, 2)
        reason = json.loads(result.stdout)['hookSpecificOutput']['permissionDecisionReason']
        self.assertIn('they run it themselves', reason)

    def test_a_deny_reaches_both_agents_without_asking_the_user(self):
        for agent in ('claude', 'codex'):
            result = self.run_adapter(agent, decision='deny')

            self.assertEqual(result.returncode, 2, agent)
            output = json.loads(result.stdout)['hookSpecificOutput']
            self.assertEqual(output['permissionDecision'], 'deny', agent)
            self.assertEqual(output['permissionDecisionReason'], 'rule 54', agent)


if __name__ == '__main__':
    unittest.main()
