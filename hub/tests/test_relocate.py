"""Moving an app's data folder into the hub behind a relative link."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agents_hub import links, relocate  # noqa: E402


class RelocateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.source = root / 'home' / '.claude' / 'projects'
        self.dest = root / 'home' / '.agents' / 'history' / 'claude' / 'projects'
        self.elsewhere = root / 'elsewhere'
        (self.source / 'p').mkdir(parents=True)
        (self.source / 'p' / 's.jsonl').write_text('one\n')

    def tearDown(self):
        self.tmp.cleanup()

    def test_moves_the_folder_and_leaves_a_relative_link_that_open_files_keep_writing_through(self):
        handle = open(self.source / 'p' / 's.jsonl', 'a')

        self.assertEqual(relocate.relocate(self.source, self.dest), 'moved now')
        handle.write('two\n')
        handle.close()

        self.assertFalse(os.path.isabs(os.readlink(self.source)))
        self.assertEqual((self.source / 'p' / 's.jsonl').read_text(), 'one\ntwo\n')
        self.assertEqual((self.dest / 'p' / 's.jsonl').read_text(), 'one\ntwo\n')
        self.assertEqual(relocate.relocate(self.source, self.dest), 'moved')

    def test_an_app_recreating_the_folder_mid_move_stops_the_move_without_merging(self):
        memory = self.source.parent.parent / '.agents' / 'memory' / 'scopes' / 'k'
        memory.mkdir(parents=True)
        (self.source / 'p' / 'memory').symlink_to(os.path.relpath(memory, self.source / 'p'))
        real_rename = os.rename

        def rename_then_app_writes(src, dst):
            real_rename(src, dst)
            (Path(src) / 'q').mkdir(parents=True)  # the app recreates the folder
            (Path(src) / 'q' / 'new.jsonl').write_text('late')

        with mock.patch.object(relocate.os, 'rename', rename_then_app_writes):
            with self.assertRaisesRegex(relocate.RelocateError, 'recreated while moving'):
                relocate.relocate(self.source, self.dest)

        self.assertEqual((self.source / 'q' / 'new.jsonl').read_text(), 'late')  # left for the user to merge
        self.assertEqual((self.dest / 'p' / 's.jsonl').read_text(), 'one\n')
        self.assertEqual((self.dest / 'p' / 'memory').resolve(), memory.resolve())  # still reachable

    def test_a_move_to_another_disk_is_reported_and_nothing_moves(self):
        with mock.patch.object(relocate.os, 'rename', side_effect=OSError(18, 'Cross-device link')):
            with self.assertRaisesRegex(relocate.RelocateError, 'same disk'):
                relocate.relocate(self.source, self.dest)

        self.assertTrue((self.source / 'p' / 's.jsonl').exists())

    def test_same_disk_compares_the_source_with_the_destinations_nearest_existing_folder(self):
        self.assertTrue(relocate.same_disk(self.source, self.dest))
        real_stat = os.stat
        other = lambda path, *a, **k: mock.Mock(st_dev=real_stat(path).st_dev + (path == self.source))
        with mock.patch.object(relocate.os, 'stat', other):
            self.assertFalse(relocate.same_disk(self.source, self.dest))

    def test_a_link_within_the_folder_moves_with_it_untouched(self):
        (self.source / 'p' / 'sib').symlink_to('s.jsonl')

        relocate.relocate(self.source, self.dest)

        self.assertEqual(os.readlink(self.dest / 'p' / 'sib'), 's.jsonl')

    def test_a_link_loop_inside_the_folder_is_reported_and_nothing_moves(self):
        (self.source / 'p' / 'loop').symlink_to('loop')
        real_resolve = Path.resolve

        def resolve(path, *args, **kwargs):  # Python 3.11 and 3.12 raise this for a loop; 3.13 does not
            if path.name == 'loop':
                raise RuntimeError('Symlink loop')
            return real_resolve(path, *args, **kwargs)

        with mock.patch.object(relocate.Path, 'resolve', resolve):
            with self.assertRaisesRegex(relocate.RelocateError, 'cannot be followed'):
                relocate.relocate(self.source, self.dest)

        self.assertFalse(self.source.is_symlink())

    def test_a_link_to_a_missing_destination_is_not_moved(self):
        self.source.rename(self.source.with_name('aside'))
        self.source.symlink_to(os.path.relpath(self.dest, self.source.parent))

        self.assertIn('links somewhere else', relocate.state(self.source, self.dest))

    def test_a_move_stopped_between_rename_and_link_is_a_conflict_not_absent(self):
        self.dest.parent.mkdir(parents=True)
        os.rename(self.source, self.dest)

        self.assertIn('stopped halfway', relocate.state(self.source, self.dest))

    def test_relative_links_inside_the_moved_folder_still_reach_their_target(self):
        memory = self.source.parent.parent / '.agents' / 'memory' / 'scopes' / 'k'
        memory.mkdir(parents=True)
        link = self.source / 'p' / 'memory'
        link.symlink_to(os.path.relpath(memory, link.parent))

        relocate.relocate(self.source, self.dest)

        moved = self.dest / 'p' / 'memory'
        self.assertEqual(moved.resolve(), memory.resolve())
        self.assertFalse(os.path.isabs(os.readlink(moved)))

    def test_a_destination_with_files_is_a_conflict_and_nothing_moves(self):
        (self.dest / 'x').mkdir(parents=True)

        with self.assertRaises(relocate.RelocateError):
            relocate.relocate(self.source, self.dest)
        self.assertFalse(self.source.is_symlink())

    def test_full_path_links_into_the_hub_become_relative_and_others_are_left(self):
        hub = self.dest.parents[2]
        (hub / 'memory' / 'scopes' / 'k').mkdir(parents=True)
        into_hub = self.source / 'p' / 'memory'
        into_hub.symlink_to(hub / 'memory' / 'scopes' / 'k')
        self.elsewhere.mkdir()
        elsewhere = self.source / 'p' / 'other'
        elsewhere.symlink_to(self.elsewhere)  # a real folder outside the hub

        changed = relocate.normalize_links([into_hub, elsewhere], hub)

        self.assertEqual(changed, [into_hub])
        self.assertFalse(os.path.isabs(os.readlink(into_hub)))
        self.assertEqual(into_hub.resolve(), (hub / 'memory' / 'scopes' / 'k').resolve())
        self.assertTrue(os.path.isabs(os.readlink(elsewhere)))


class LinksTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def test_tilde_matches_the_home_folder_by_either_spelling(self):
        real = self.root / 'Users' / 'me'
        (real / '.claude').mkdir(parents=True)
        spelled = self.root / 'home'
        spelled.symlink_to(real)

        self.assertEqual(links.tilde(real / '.claude', spelled), '~/.claude')
        self.assertEqual(links.tilde(spelled / '.claude', spelled), '~/.claude')
        self.assertEqual(links.tilde(self.root / 'x', spelled), str(self.root / 'x'))

    def test_a_relative_link_still_reaches_its_target_when_its_folder_is_reached_through_a_symlink(self):
        (self.root / '.claude').mkdir()
        (self.root / '.claude' / 'settings.json').write_text('{}')
        (self.root / 'accounts' / 'work').mkdir(parents=True)
        (self.root / '.work').symlink_to(self.root / 'accounts' / 'work')

        links.write_relative_link(self.root / '.work' / 'settings.json', self.root / '.claude' / 'settings.json')

        self.assertEqual((self.root / '.work' / 'settings.json').read_text(), '{}')
        self.assertFalse(os.path.isabs(os.readlink(self.root / '.work' / 'settings.json')))


if __name__ == '__main__':
    unittest.main()
