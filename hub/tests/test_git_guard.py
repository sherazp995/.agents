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
        self.assertIn('("c0")', verdict['reason'])
        self.assertNotIn('user', verdict['reason'])
        self.assertIsNone(self.guard("git commit --amend --no-edit"))

    def test_a_second_commit_with_a_rule_48_break_is_denied_with_both_corrections(self):
        self.commit(1)

        verdict = self.verdict("git commit -m 'Title' -m 'Body'")
        self.assertEqual(verdict['decision'], 'deny')
        self.assertIn('--amend', verdict['reason'])
        self.assertIn('one `-m', verdict['reason'])

    def test_git_dash_c_is_denied_with_the_command_rewritten_to_cd_first(self):
        verdict = self.verdict("git -C '/tmp/a b' log -1 --format=%s")
        self.assertEqual(verdict['decision'], 'deny')
        self.assertIn("`cd '/tmp/a b' && git log -1 --format=%s`", verdict['reason'])
        self.assertIsNone(self.verdict('git log -C -1'))

    def test_several_unpushed_commits_deny_and_say_to_leave_it_uncommitted_and_report(self):
        self.commit(2)

        for command in ("git commit -m 'x'", 'git commit --amend --no-edit'):
            verdict = self.verdict(command)
            self.assertEqual(verdict['decision'], 'deny', command)
            self.assertIn('leave the change uncommitted and tell the user', verdict['reason'])

    def test_an_autonomous_task_branch_counts_only_its_own_commits(self):
        self.commit(1)  # the base holds an unpushed commit, as a local main often does
        self.git('checkout', '-q', '-b', 'autonomous/task')

        self.assertIsNone(self.guard("git commit -m 'Task change'"))
        self.commit(1)
        verdict = self.verdict("git commit -m 'Second task change'")
        self.assertEqual(verdict['decision'], 'deny')
        self.assertIn('--amend', verdict['reason'])
        self.git('checkout', '-q', '-b', 'feature')
        self.assertIn('2 unpushed commits', self.guard("git commit -m 'x'"))

    def test_amending_a_pushed_commit_is_denied_with_a_new_commit_instead(self):
        self.commit(1)
        self.push_all()

        verdict = self.verdict('git commit --amend --no-edit')
        self.assertEqual(verdict['decision'], 'deny')
        self.assertIn('already pushed. Rerun it as a new commit', verdict['reason'])

    def test_no_rule_break_ever_asks_the_user(self):
        self.commit(2)
        for command in ("git commit -m 'x'", "git -C . commit -m 'a' -m 'b'", "git commit -m x\necho '"):
            self.assertEqual(self.verdict(command)['decision'], 'deny', command)

    def test_multi_line_messages_and_claude_attribution_are_denied(self):
        self.assertIn('single line', self.guard("git commit -m 'Title' -m 'Body'"))
        heredoc = "git commit -m \"$(cat <<'EOF'\nTitle\n\nBody\nEOF\n)\""
        self.assertIn('single line', self.guard(heredoc) or '')
        self.assertIn('attribution', self.guard("git commit -m 'Fix Co-Authored-By: Claude <x>'"))

    def test_git_dash_c_is_denied_with_cd_rewrites_that_keep_home_and_variables_live(self):
        self.assertIn('rule 43', self.guard(f'git -C {self.repo} status'))
        self.assertIn('`cd ~/repo && git log`', self.guard('git -C ~/repo log'))
        self.assertIn('`cd $HOME/repo && git log`', self.guard('git -C $HOME/repo log'))
        self.assertIn('`cd a && cd b && git log`', self.guard('git -C a -C b log'))

    def test_cd_into_another_repo_checks_that_repo(self):
        self.commit(1)
        elsewhere = Path(self.tmp.name).parent

        self.assertIn('--amend', self.guard(f"cd {self.repo} && git commit -m 'x'", cwd=elsewhere))

    def test_a_commit_in_a_folder_only_the_shell_knows_is_allowed(self):
        self.assertIsNone(self.guard("D=$(mktemp -d); cd $D && git init -q && git commit -m 'x'"))
        self.assertIsNone(self.guard("cd /no/such/folder && git commit -m 'x'"))
        self.assertIn('single line', self.guard("cd $D && git commit -m 'a' -m 'b'") or '')

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

    def test_heredoc_apostrophes_and_parse_failures_are_still_caught_for_git_dash_c(self):
        command = f"git -C {self.repo} status && cat <<EOF\ndon't\nEOF"
        self.assertIn('rule 43', self.guard(command) or '')
        self.assertIn('rule 43', self.guard("cat <<EOF\nit's literal\nEOF\ngit -C /tmp log") or '')
        self.assertIn('could not be parsed', self.guard(command + "\necho '") or '')
        self.assertIn('could not be checked', self.guard(f"git -C {self.repo} commit -m x\necho '") or '')

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

    def per_feature(self, *subjects):
        (self.repo / '.git-guard.json').write_text('{"commits": "per-feature"}')
        for subject in subjects:
            self.git('commit', '-q', '--allow-empty', '-m', subject)

    def sha(self, rev):
        return subprocess.run(['git', 'rev-parse', '--short=12', rev], cwd=self.repo,
                              check=True, capture_output=True, text=True).stdout.strip()

    def test_per_feature_mode_allows_one_unpushed_commit_per_new_tag(self):
        self.per_feature('[login] Add form', '[search] Add box', '[export] Add csv')

        self.assertIsNone(self.guard("git commit -m '[Billing] Add plan'"))
        self.assertIn('git commit -m "[<feature>] <one line>"', self.guard("git commit -m 'Untagged'"))
        self.assertIn('-m "[<feature>]', self.guard('git commit -F msg.txt'))
        self.assertIsNone(self.guard("git commit -qm '[billing] Add plan'"))
        self.assertIsNone(self.guard("git commit -qm'[billing] Add plan'"))
        self.assertIn('must start with its feature tag', self.guard("git commit -am 'Untagged'"))

    def test_per_feature_mode_folds_a_repeated_tag_into_its_commit(self):
        self.per_feature('[login] Add form', '[search] Add box')

        self.assertIn('git commit --amend --no-edit', self.guard("git commit -m '[search] Tweak'"))
        login = self.sha('HEAD~1')
        reason = self.guard("git commit -m '[ Login ] Fix typo'")
        self.assertIn(f'`git commit --fixup={login}`', reason)
        self.assertIn('`git rebase --autosquash --autostash --root`', reason)
        self.assertIsNone(self.guard(f'git commit --fixup={login}'))
        self.assertIsNone(self.guard("git commit --fixup=':/[login]'"))
        self.assertIn('plain `git commit --fixup=<sha>`', self.guard(f'git commit --fixup=amend:{login} -m "[x] y"'))
        self.assertIn('cannot be checked', self.guard(f"git commit --squash={login} -m '[x] y'"))
        self.assertIn('cannot be checked', self.guard(f"git commit --squ={login} -m '[x] y'"))
        self.assertIn('one plain `git commit --fixup', self.guard(f'git commit --fixup={login} --fixup=amend:{login}'))
        self.assertIn('without --amend', self.guard(f'git commit --amend --fixup={login}'))

    def test_per_feature_fixup_advice_rebases_from_the_parent_of_the_feature_commit(self):
        self.per_feature('[base] Start')
        self.push_all()
        self.git('commit', '-q', '--allow-empty', '-m', '[login] Add form')
        self.git('commit', '-q', '--allow-empty', '-m', '[search] Add box')

        login = self.sha('HEAD~1')
        self.assertIn(f'`git rebase --autosquash --autostash {login}~1`', self.guard("git commit -m '[login] Fix'"))

    def test_per_feature_mode_never_rewrites_pushed_commits_or_relabels_a_feature(self):
        self.per_feature('[login] Add form')
        self.push_all()
        pushed = self.sha('HEAD')
        self.git('commit', '-q', '--allow-empty', '-m', '[search] Add box')

        self.assertIn('not an unpushed commit', self.guard(f'git commit --fixup={pushed}'))
        self.assertIsNone(self.guard("git commit -m '[login] Follow up'"))
        self.assertIsNone(self.guard("git commit --amend -m '[search] Add search box'"))
        self.assertIn('"[search]"', self.guard("git commit --amend -m '[login] Add box'"))
        self.git('commit', '-q', '--allow-empty', '-m', 'Untagged')
        self.assertIn('make a second one', self.guard("git commit --amend -m '[search] Retag'"))
        self.assertIsNone(self.guard("git commit --amend -m '[billing] Retag'"))
        self.git('reset', '-q', '--soft', 'HEAD~1')
        self.assertIn('--amend --no-edit', self.guard('git commit --amend -F msg.txt'))
        for command in ('git commit --amend --no-edit -C HEAD~1', 'git commit --amend --no-edit -c HEAD~1',
                        'git commit --amend --no-edit -F msg.txt', 'git commit --amend --no-edit --reuse-message=HEAD~1',
                        'git commit --amend --no-edit -aC HEAD~1', 'git commit --amend --no-edit --reuse=HEAD~1',
                        'git commit --amend --no-edit --fil=msg.txt'):
            self.assertIn('cannot be checked', self.guard(command), command)
        self.assertIn('"[search]"', self.guard("git commit --amend --no-edit -qm'[login] Add box'"))
        self.assertIn('"[search]"', self.guard("git commit --amen -m '[billing] Relabel'"))
        self.assertIn('git commit -m "[<feature>]', self.guard('git commit --fil=msg.txt'))
        self.assertNotIn('--amend', self.guard('git commit -F msg.txt'))
        self.push_all()
        self.assertIn('already pushed', self.guard('git commit --amend --no-edit'))

    def test_per_feature_mode_never_offers_a_rebase_across_a_merge(self):
        self.per_feature('[base] Start')
        self.push_all()
        self.git('commit', '-q', '--allow-empty', '-m', '[login] Add form')
        self.git('checkout', '-q', '-b', 'side', 'HEAD~1')
        self.git('commit', '-q', '--allow-empty', '-m', 'main work')
        self.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.git('checkout', '-q', '-')
        self.git('merge', '-q', '--no-edit', 'origin/main')
        self.git('commit', '-q', '--allow-empty', '-m', '[search] Add box')

        reason = self.guard("git commit -m '[login] Fix'")
        self.assertIn('Leave the change uncommitted', reason)
        self.assertNotIn('rebase --autosquash', reason)
        self.assertIn('Leave the change uncommitted', self.guard(f"git commit --fixup={self.sha('HEAD~2')}"))

        self.git('reset', '-q', '--hard', 'HEAD~1')
        self.git('commit', '-q', '--amend', '--allow-empty', '-m', '[merge] Join main')
        self.git('commit', '-q', '--allow-empty', '-m', '[search] Add box')
        self.assertIn('Leave the change uncommitted', self.guard("git commit -m '[merge] Fix'"))
        self.assertIn('Leave the change uncommitted', self.guard(f"git commit --fixup={self.sha('HEAD~1')}"))

    def test_per_feature_mode_never_offers_a_rebase_across_an_unpushed_merge(self):
        self.per_feature('[base] Start')
        self.push_all()
        self.git('commit', '-q', '--allow-empty', '-m', '[login] Add form')
        self.git('checkout', '-q', '-b', 'side', 'HEAD~1')
        self.git('commit', '-q', '--allow-empty', '-m', 'side work')
        self.git('checkout', '-q', '-')
        self.git('merge', '-q', '--no-edit', 'side')
        self.git('commit', '-q', '--allow-empty', '-m', '[search] Add box')

        self.assertIn('Leave the change uncommitted', self.guard("git commit -m '[login] Fix'"))
        self.assertIn('Leave the change uncommitted', self.guard(f"git commit --fixup={self.sha('HEAD~2')}"))

    def test_without_the_project_flag_feature_tags_do_not_lift_the_single_commit_rule(self):
        self.commit(1)

        self.assertIn('--amend', self.guard("git commit -m '[search] Add box'"))
        (self.repo / '.git-guard.json').write_text('{"commits": "per_feature"}')
        self.assertIn('but it has "commits": "per_feature"', self.guard("git commit -m '[search] Add box'"))
        for broken, problem in (('{"commits": "per-feature",}', 'cannot be read as JSON'),
                                ('["per-feature"]', 'not a JSON object')):
            (self.repo / '.git-guard.json').write_text(broken)
            self.assertIn(problem, self.guard("git commit -m '[search] Add box'"), broken)

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
