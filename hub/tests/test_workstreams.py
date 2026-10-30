"""Behaviour tests for agents-hub workstreams. Run: python3 -m unittest discover -s ~/.agents/hub/tests"""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

HUB = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HUB))

from agents_hub import workstreams  # noqa: E402
from agents_hub.paths import Paths  # noqa: E402

CLI = HUB / 'agents-hub'
ADAPTER = HUB.parent / 'hooks' / 'adapters' / 'run.py'


class WorkstreamCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name).resolve()
        self.paths = Paths(self.home)
        runtime = mock.patch.dict(os.environ, {'AGENTS_HUB_RUNTIME': str(self.home / 'tmp')})
        runtime.start()
        self.addCleanup(runtime.stop)
        self.web = self.repo('web')
        self.data = self.repo('data')

    def tearDown(self):
        self.tmp.cleanup()

    def repo(self, name):
        path = self.home / name
        path.mkdir()
        subprocess.run(['git', 'init', '-q'], cwd=path, check=True)
        subprocess.run(['git', 'commit', '-q', '--allow-empty', '-m', 'init'], cwd=path, check=True,
                       env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                            'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'})
        return path

    def create(self, workstream_id='pipeline', repos=None):
        return workstreams.create(self.paths, workstream_id, 'Pipeline', repos or [self.web, self.data],
                                  ['CDT-15'], 'claude', 's1')

    def update(self, revision, state=None, note='n'):
        return workstreams.update(self.paths, 'pipeline', revision, note, 'gh pr view 1', True, 'codex', 's2',
                                  state=state)


class DiscoveryTests(WorkstreamCase):
    def test_a_workstream_is_listed_from_each_linked_repo_and_a_linked_worktree(self):
        self.create()
        worktree = self.home / 'web-feature'
        subprocess.run(['git', 'worktree', 'add', '-q', str(worktree)], cwd=self.web, check=True)

        for place in (self.web, self.data, worktree):
            self.assertEqual([r['id'] for r in workstreams.matching(self.paths, place)], ['pipeline'], place)

    def test_an_unrelated_repo_lists_nothing(self):
        self.create()
        self.assertEqual(workstreams.matching(self.paths, self.repo('other')), [])

    def test_a_path_like_id_is_refused(self):
        for bad in ('../escape', 'Upper', ''):
            with self.assertRaises(workstreams.WorkstreamError):
                workstreams.create(self.paths, bad, 't', [self.web], [], 'claude', 's1')


class UpdateTests(WorkstreamCase):
    def test_an_update_at_the_current_revision_replaces_state_and_logs_its_provenance(self):
        self.create()
        record = self.update(1, state='Stage: building')

        self.assertEqual((record['revision'], record['state']), (2, 'Stage: building'))
        entry = record['log'][-1]
        self.assertEqual((entry['author'], entry['session'], entry['source'], entry['verified'], entry['revision']),
                         ('codex', 's2', 'gh pr view 1', True, 2))
        self.assertEqual(workstreams.load(self.paths, 'pipeline'), record)

    def test_a_stale_revision_is_refused_names_the_current_one_and_changes_nothing(self):
        self.create()
        self.update(1, state='first')
        before = workstreams.load(self.paths, 'pipeline')

        with self.assertRaises(workstreams.StaleRevision) as caught:
            self.update(1, state='second')

        self.assertEqual(caught.exception.current, 2)
        self.assertEqual(workstreams.load(self.paths, 'pipeline'), before)

    def test_two_concurrent_updates_from_the_same_revision_let_exactly_one_win(self):
        self.create()
        outcomes, start = [], threading.Barrier(2)

        def attempt(text):
            start.wait()
            try:
                self.update(1, state=text)
                outcomes.append('won')
            except workstreams.StaleRevision:
                outcomes.append('stale')
        threads = [threading.Thread(target=attempt, args=(t,)) for t in ('a', 'b')]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(sorted(outcomes), ['stale', 'won'])
        self.assertEqual(workstreams.load(self.paths, 'pipeline')['revision'], 2)

    def test_state_over_the_size_limit_is_refused(self):
        self.create()
        with self.assertRaises(workstreams.WorkstreamError):
            self.update(1, state='x' * (workstreams.STATE_LIMIT + 1))
        self.assertEqual(workstreams.load(self.paths, 'pipeline')['revision'], 1)

    def test_a_crash_while_writing_leaves_the_previous_record_unchanged(self):
        self.create()
        before = workstreams.load(self.paths, 'pipeline')

        with mock.patch.object(workstreams.os, 'replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.update(1, state='lost')

        self.assertEqual(workstreams.load(self.paths, 'pipeline'), before)

    def test_a_log_only_update_bumps_the_revision_but_not_the_state_changed_date(self):
        self.create()
        record = self.update(1, state='s')
        changed = record['state_changed_at']
        with mock.patch.object(workstreams, 'now', return_value='2099-01-01T00:00:00+00:00'):
            record = self.update(2)

        self.assertEqual((record['revision'], record['state_changed_at']), (3, changed))

    def test_passing_the_same_state_as_verified_marks_it_current_and_an_empty_state_is_refused(self):
        self.create()
        first = self.update(1, state='s')['state_changed_at']
        with mock.patch.object(workstreams, 'now', return_value='2099-01-01T00:00:00+00:00'):
            confirmed = self.update(2, state='s')

        self.assertNotEqual(confirmed['state_changed_at'], first)
        with self.assertRaises(workstreams.WorkstreamError):
            self.update(3, state='  \n')

    def test_link_adds_a_repo_bumps_the_revision_and_refuses_a_stale_one(self):
        self.create(repos=[self.web])
        record = workstreams.link(self.paths, 'pipeline', 1, self.data, 'claude', 's1')

        self.assertEqual(record['revision'], 2)
        self.assertIn('~/data', record['repos'])
        with self.assertRaises(workstreams.StaleRevision):
            workstreams.link(self.paths, 'pipeline', 1, self.data, 'claude', 's1')

    def test_skip_logs_nothing_new_without_touching_state_or_revision(self):
        self.create()
        record = workstreams.skip(self.paths, 'pipeline', 'discussion only', 'claude', 's1')
        self.assertEqual((record['revision'], record['log'][-1]['kind']), (1, 'skip'))

    def test_old_log_entries_move_to_the_archive_and_none_are_lost(self):
        self.create()
        for revision in range(1, workstreams.LOG_KEPT + 5):
            self.update(revision)

        record = workstreams.load(self.paths, 'pipeline')
        archive = (self.paths.workstreams / 'pipeline' / workstreams.ARCHIVE).read_text().splitlines()
        self.assertEqual(len(record['log']), workstreams.LOG_KEPT)
        self.assertEqual(len(archive) + len(record['log']), workstreams.LOG_KEPT + 5)


class BrokenStorageTests(WorkstreamCase):
    def test_a_corrupt_record_is_a_clear_error_and_does_not_hide_the_others(self):
        self.create()
        self.create('other')
        (self.paths.workstreams / 'other' / workstreams.RECORD).write_text('{broken')

        with self.assertRaises(workstreams.WorkstreamError):
            workstreams.load(self.paths, 'other')
        self.assertEqual([r['id'] for r in workstreams.records(self.paths)], ['pipeline'])

    def block(self, folder):
        folder.parent.mkdir(parents=True, exist_ok=True)
        folder.write_text('not a folder')

    def test_a_sandboxed_session_that_cannot_write_the_hub_leaves_its_receipt_in_the_temp_folder(self):
        hub_folder, temp_folder = workstreams.receipt_folders(self.paths)
        self.block(hub_folder)
        workstreams.add_receipt(self.paths, 's', 'show', 'pipeline', 1)

        self.assertTrue((temp_folder / 's-s.jsonl').is_file())
        self.assertEqual([r['kind'] for r in workstreams.receipts(self.paths, 's')], ['show'])

    def test_receipts_from_both_folders_are_read_in_order(self):
        hub_folder, _ = workstreams.receipt_folders(self.paths)
        self.block(hub_folder)
        workstreams.add_receipt(self.paths, 's', 'show', 'pipeline', 1)
        hub_folder.unlink()
        workstreams.add_receipt(self.paths, 's', 'update', 'pipeline', 2)

        self.assertEqual([r['kind'] for r in workstreams.receipts(self.paths, 's')], ['show', 'update'])

    def test_no_writable_receipt_folder_only_warns(self):
        for folder in workstreams.receipt_folders(self.paths):
            self.block(folder)
        workstreams.add_receipt(self.paths, '../s', 'show', 'pipeline', 1)  # warns, no raise

    def test_session_ids_map_to_safe_file_names(self):
        for session in ('..', '../x', 'a/b'):
            name = workstreams.session_file_name(session)
            self.assertNotIn('/', name)
            self.assertNotIn(name, ('.', '..'))


class ShowTests(WorkstreamCase):
    def test_show_prints_only_recent_log_entries_and_flags_an_old_state(self):
        self.create()
        for revision in range(1, 4):
            self.update(revision, note=f'note {revision}')
        record = workstreams.load(self.paths, 'pipeline')
        later = datetime.fromisoformat(record['state_changed_at']) + timedelta(days=workstreams.STALE_DAYS + 2)

        text = workstreams.render(record, log_count=2, at=later)

        self.assertIn('note 3', text)
        self.assertNotIn('note 1', text)
        self.assertIn('WARNING: state not changed', text)
        self.assertNotIn('WARNING', workstreams.render(record, at=datetime.now(timezone.utc)))


class CommandTests(WorkstreamCase):
    def run_cli(self, *args, cwd=None, env=None):
        environment = {**os.environ, 'AGENTS_HUB_HOME': str(self.home), **(env or {})}
        for name in ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDECODE'):
            if name not in (env or {}):
                environment.pop(name, None)
        return subprocess.run([str(CLI), 'workstream', *args], cwd=cwd or self.web, env=environment,
                              capture_output=True, text=True)

    def receipts(self, session):
        return [(r['kind'], r['revision']) for r in workstreams.receipts(self.paths, session)]

    def test_receipts_are_written_only_for_successful_commands_keyed_by_the_session(self):
        self.assertEqual(self.run_cli('new', 'pipeline', '--title', 'P').returncode, 0)
        env = {'CODEX_THREAD_ID': 'thread-1'}
        self.run_cli('show', 'pipeline', env=env)
        ok = self.run_cli('update', 'pipeline', '--revision', '1', '--note', 'n', '--source', 's', env=env)
        stale = self.run_cli('update', 'pipeline', '--revision', '1', '--note', 'n', '--source', 's', env=env)

        self.assertEqual((ok.returncode, stale.returncode), (0, 3))
        self.assertEqual(self.receipts('thread-1'), [('show', 1), ('update', 2)])
        self.assertEqual(workstreams.load(self.paths, 'pipeline')['log'][-1]['author'], 'codex')

    def test_a_state_file_replaces_only_the_state_not_the_owned_fields(self):
        self.run_cli('new', 'pipeline', '--title', 'P')
        state = self.home / 'state.md'
        state.write_text('revision: 99\nrepos: []\n')

        self.run_cli('update', 'pipeline', '--revision', '1', '--note', 'n', '--source', 's',
                     '--state-file', str(state), '--session', 'x')

        record = workstreams.load(self.paths, 'pipeline')
        self.assertEqual((record['revision'], record['repos'], record['state']), (2, ['~/web'], state.read_text()))


class HookTests(WorkstreamCase):
    def hook(self, agent, name, native):
        environment = {**os.environ, 'AGENTS_HUB_HOME': str(self.home)}
        result = subprocess.run([sys.executable, str(ADAPTER), agent, name], input=json.dumps(native),
                                env=environment, capture_output=True, text=True)
        return result.returncode, result.stdout

    def start(self, agent, cwd):
        code, out = self.hook(agent, 'workstream-context', {'hook_event_name': 'SessionStart', 'cwd': str(cwd)})
        return code, json.loads(out)['hookSpecificOutput']['additionalContext'] if out.strip() else None

    def stop(self, session='s9', active=False):
        code, out = self.hook('claude', 'workstream-check', {'hook_event_name': 'Stop', 'session_id': session,
                                                             'stop_hook_active': active})
        return code, json.loads(out)['reason'] if out.strip() else None

    def receipt(self, kind, workstream_id='pipeline', session='s9'):
        workstreams.add_receipt(self.paths, session, kind, workstream_id, 1)

    def test_the_start_hook_lists_linked_workstreams_for_claude_and_codex(self):
        self.create()
        for agent in ('claude', 'codex'):
            code, context = self.start(agent, self.data)
            self.assertEqual(code, 0)
            self.assertIn('- pipeline: Pipeline', context)

    def test_the_start_hook_is_silent_in_an_unlinked_repo_and_on_a_broken_record(self):
        self.create()
        self.assertEqual(self.start('claude', self.repo('other')), (0, None))
        (self.paths.workstreams / 'pipeline' / workstreams.RECORD).write_text('{broken')
        self.assertEqual(self.start('claude', self.web), (0, None))

    def test_a_shown_workstream_with_no_update_is_sent_back_once(self):
        self.receipt('show')
        code, reason = self.stop()
        self.assertEqual(code, 2)
        self.assertIn('pipeline', reason)
        self.assertEqual(self.stop(), (0, None))

    def test_an_update_or_skip_after_the_show_lets_the_turn_end(self):
        for closing in ('update', 'skip'):
            session = f'after-{closing}'
            self.receipt('show', session=session)
            self.receipt(closing, session=session)
            self.assertEqual(self.stop(session), (0, None), closing)

    def test_only_the_workstream_left_unrecorded_is_named(self):
        self.receipt('show', 'pipeline')
        self.receipt('show', 'reports')
        self.receipt('update', 'reports')
        reason = self.stop()[1]
        self.assertIn('pipeline', reason)
        self.assertNotIn('reports', reason)

    def test_a_new_show_after_a_reminder_reminds_again_once(self):
        self.receipt('show')
        self.stop()
        self.receipt('show')
        self.assertEqual(self.stop()[0], 2)
        self.assertEqual(self.stop(), (0, None))

    def test_no_reminder_while_a_stop_hook_is_active_or_when_hook_state_is_unwritable(self):
        self.receipt('show')
        self.assertEqual(self.stop(active=True), (0, None))
        self.paths.workstreams.mkdir(parents=True, exist_ok=True)
        (self.paths.workstreams / '.hook-state').write_text('not a folder')
        self.assertEqual(self.stop(), (0, None))


if __name__ == '__main__':
    unittest.main()
