#!/usr/bin/env python3
"""Tests for ledger_cleanup.py with gh and git stubbed. Run: python3 -B -m unittest test_ledger_cleanup"""
import contextlib
import io
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ledger_cleanup as lc  # noqa: E402

RECORD = "run_id: R1\nbase: main\nverdict: CHANGES REQUIRED\n\n#I-1 [high] bug — OPEN\n#I-2 [low] nit — FIXED\n"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.responses = {}

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel, text=RECORD):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def fake_run(self, cmd, cwd):
        """Stubbed gh/git: the first response whose words all appear in the command; else exit 1."""
        line = " ".join(cmd)
        for words, result in self.responses.items():
            if all(w in line for w in words.split()):
                return result
        return 1, ""

    def cleanup(self, *extra, gh_repo="o/r"):
        out = io.StringIO()
        with mock.patch.object(lc, "run", self.fake_run), contextlib.redirect_stdout(out):
            lc.main(["--ledger-root", self.root, "--repo", self.root, "--gh-repo", gh_repo,
                     "--runner", "claude", *extra])
        return out.getvalue()


class Decisions(Base):
    def test_no_flag_and_list_only_both_delete_nothing(self):
        rec = self.write("42/claude.md")
        self.responses["gh pr view 42"] = (0, "MERGED\n")
        for extra in ((), ("--list-only",)):
            self.assertIn("Would clean (list-only):", self.cleanup(*extra))
            self.assertTrue(os.path.exists(rec))

    def test_merged_pr_is_listed_with_open_findings_and_nothing_deleted(self):
        rec = self.write("42/claude.md")
        old = self.write("42/claude.old-2026-01-01-abc-x.md")
        repro = self.write("42/repro/claude/spec.rb")
        sibling = self.write("42/codex.md")
        self.responses["gh pr view 42"] = (0, "MERGED\n")
        out = self.cleanup()
        self.assertIn("Would clean (list-only):", out)
        self.assertIn(rec, out)
        self.assertIn(old, out)
        self.assertIn(os.path.dirname(repro), out)
        self.assertNotIn(sibling, out)
        self.assertIn("42 finished with these still open:\n#I-1 [high] bug — OPEN", out)
        self.assertNotIn("#I-2", out)
        self.assertTrue(os.path.exists(rec) and os.path.exists(repro))

    def test_open_pr_and_gh_none_keep(self):
        self.write("42/claude.md")
        self.write("43/claude.md")
        self.responses["gh pr view 42"] = (0, "OPEN\n")
        self.responses["gh pr view 43"] = (0, "MERGED\n")
        self.assertIn("Kept: 42 (open)", self.cleanup())
        self.assertIn("Kept: 42 (unknown), 43 (unknown)", self.cleanup(gh_repo="none"))

    def test_other_runners_and_files_keys_are_ignored_or_kept(self):
        self.write("42/codex.md")
        self.write("files-abc/claude.md")
        self.write("codebase/claude.md")
        self.responses["gh pr view"] = (0, "MERGED\n")
        out = self.cleanup()
        self.assertIn("Nothing to clean", out)
        self.assertIn("Kept: codebase (always kept), files-abc (always kept)", out)

    def test_branch_with_pr_is_kept(self):
        self.write("branch-feat%2Fx/claude.md")
        self.responses["gh pr list --head feat/x"] = (0, "7\n")
        self.assertIn("Kept: branch-feat%2Fx (has a PR)", self.cleanup())

    def test_branch_deleted_on_origin_needs_local_absence_and_a_successful_lookup(self):
        self.write("branch-a%25b/claude.md")
        no_pr = {"gh pr list --head a%b": (0, "")}
        self.responses = dict(no_pr, **{"ls-remote --heads origin refs/heads/a%b": (0, "")})
        self.assertIn("Would clean", self.cleanup())
        self.responses = dict(no_pr, **{"show-ref --verify --quiet refs/heads/a%b": (0, ""),
                                        "ls-remote --heads origin refs/heads/a%b": (0, "")})
        self.assertIn("Kept: branch-a%25b (still exists locally)", self.cleanup())
        self.responses = dict(no_pr)  # failed remote lookup is not evidence of deletion
        self.assertIn("Kept: branch-a%25b (not merged)", self.cleanup())

    def test_failed_or_timed_out_lookups_never_clean(self):
        self.write("branch-a/claude.md")
        self.write("local-b/claude.md")
        gone = {"ls-remote --heads origin refs/heads/a": (0, ""), "ls-remote --heads origin refs/heads/b": (0, "")}
        self.responses = dict(gone, **{"gh pr list --head a": (124, "")})
        out = self.cleanup()
        self.assertIn("Kept: branch-a (PR lookup failed)", out)
        self.responses = dict(gone, **{"gh pr list --head a": (0, ""),
                                       "show-ref --verify --quiet refs/heads/a": (124, ""),
                                       "show-ref --verify --quiet refs/heads/b": (124, "")})
        out = self.cleanup()
        self.assertIn("branch-a (local lookup failed)", out)
        self.assertIn("local-b (branch still exists)", out)
        self.assertIn("Nothing to clean", out)

    def test_branch_merged_into_base_is_finished_only_when_both_commits_exist(self):
        self.write("branch-x/claude.md")
        self.responses = {
            "gh pr list --head x": (0, ""),
            "ls-remote --heads origin refs/heads/x": (0, "aaa\trefs/heads/x\n"),
            "ls-remote origin refs/heads/x refs/heads/main": (0, "aaa\trefs/heads/x\nbbb\trefs/heads/main\n"),
            "cat-file -e aaa": (0, ""),
            "merge-base --is-ancestor aaa bbb": (0, ""),
        }
        self.assertIn("Kept: branch-x (not merged)", self.cleanup())
        self.responses["cat-file -e bbb"] = (0, "")
        self.assertIn("Would clean", self.cleanup())

    def test_local_key_finished_only_when_gone_locally_and_on_origin(self):
        self.write("local-feat/claude.md")
        self.write("staged-detached/claude.md")
        self.responses["ls-remote --heads origin refs/heads/feat"] = (0, "")
        out = self.cleanup()
        self.assertIn(os.path.join(self.root, "local-feat", "claude.md"), out)
        self.assertIn("Kept: staged-detached (detached)", out)
        self.responses["show-ref --verify --quiet refs/heads/feat"] = (0, "")
        self.assertIn("Kept: local-feat (branch still exists)", self.cleanup())


class Delete(Base):
    def test_delete_removes_only_this_runners_files_and_keeps_the_lock(self):
        self.write("42/claude.md")
        self.write("42/claude.old-2026-01-01-abc-x.md")
        self.write("42/repro/claude/spec.rb")
        self.write("42/repro/claude.old-2026-01-01-abc-x/spec.rb")
        keep = [self.write("42/codex.md"), self.write("42/claude.conflict-R2.md"),
                self.write("42/claude.lock", ""), self.write("42/repro/codex/spec.rb")]
        self.responses["gh pr view 42"] = (0, "MERGED\n")
        self.assertIn("Cleaned: 42 (merged)", self.cleanup("--delete"))
        left = sorted(os.path.join(d, f) for d, _, fs in os.walk(self.root) for f in fs)
        self.assertEqual(left, sorted(keep))

    def test_delete_skips_a_record_rewritten_since_it_was_read(self):
        rec = self.write("42/claude.md")
        self.responses["gh pr view 42"] = (0, "MERGED\n")
        real_delete = lc.delete

        def rewrite_then_delete(folder, runner, run_id, paths):
            self.write("42/claude.md", RECORD.replace("R1", "R2"))
            return real_delete(folder, runner, run_id, paths)

        with mock.patch.object(lc, "delete", rewrite_then_delete):
            out = self.cleanup("--delete")
        self.assertIn("Skipped (locked or changed): 42 (exit 3)", out)
        self.assertTrue(os.path.exists(rec))


if __name__ == "__main__":
    unittest.main()
