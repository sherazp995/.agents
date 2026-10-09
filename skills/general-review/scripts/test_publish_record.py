#!/usr/bin/env python3
"""Tests for publish_record.py. Run: python3 -B ~/.agents/skills/general-review/scripts/test_publish_record.py"""
import fcntl
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import publish_record as pr  # noqa: E402

SCRIPT = os.path.join(HERE, "publish_record.py")


def body(run_id="R1", verdict="PASS", findings="", state="s1"):
    return f"run_id: {run_id}\nstate: {state}\nkind: pr\nverdict: {verdict}\n\n{findings}"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.D = os.path.join(self.root, "L", "42")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        path = os.path.join(self.root, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def run_cli(self, *args):
        return subprocess.run([sys.executable, "-I", "-B", SCRIPT, "--dir", self.D, "--runner", "claude", *args],
                              capture_output=True, text=True).returncode


class Validation(Base):
    def bad(self, text, run_id=None):
        return pr.invalid_lines(self.write("b.md", text), run_id)

    def test_valid_records_pass(self):
        self.assertEqual(self.bad(body(findings="#I-1 [low] a — OPEN (parked for user)\n")), [])
        self.assertEqual(self.bad(body(verdict="CHANGES REQUIRED",
                                       findings="#I-1 [medium] a — OPEN\n#codex:I-2 [low] b — FIXED (checked by claude)\n")), [])
        self.assertEqual(self.bad(body(verdict="BLOCKED", findings="#I-1 [blocker] a — PARTLY (half)\n")), [])
        self.assertEqual(self.bad(body(verdict="INCOMPLETE")), [])

    def test_pass_with_open_gating_finding_is_rejected(self):
        self.assertTrue(self.bad(body(verdict="PASS", findings="#I-1 [blocker] a — OPEN\n")))
        self.assertTrue(self.bad(body(verdict="CHANGES REQUIRED", findings="#I-1 [blocker] a — OPEN\n")))
        self.assertTrue(self.bad(body(verdict="BLOCKED", findings="#I-1 [high] a — OPEN\n")))

    def test_pre_existing_question_and_older_head_do_not_gate(self):
        lines = ("#P-1 [high] a — OPEN (pre-existing)\n#I-2 [medium] b — OPEN (question)\n"
                 "#O-legacy-3 [high] c — OPEN (older head aaaaaaaaa)\n#I-4 [high] d — FIXED\n")
        self.assertEqual(self.bad(body(verdict="PASS", findings=lines)), [])

    def test_markers_only_count_in_the_status_detail(self):
        for line in ('#I-31 [medium] labeled "older head" wrongly — OPEN\n',
                     "#I-2 [high] parser treats (question) tag wrong — PARTLY (half)\n",
                     "#I-3 [high] (pre-existing) text in the description — OPEN\n"):
            self.assertTrue(self.bad(body(verdict="PASS", findings=line)), line)
        for line in ("#I-4 [high] a — OPEN (pre-existing; checked by claude)\n",
                     "#P-1 [medium] b — OPEN\n", "#codex:P-2 [high] c — OPEN (checked by claude)\n",
                     "#codex:I-5 [low] d — OPEN (checked by claude)\n"):
            self.assertEqual(self.bad(body(verdict="PASS", findings=line)), [], line)
        self.assertTrue(self.bad(body(verdict="PASS", findings="#codex:I-6 [high] e — OPEN (checked by claude)\n")))

    def test_invalid_verdict_status_severity_and_format(self):
        self.assertTrue(self.bad(body(verdict="LGTM")))
        self.assertTrue(self.bad(body(findings="#I-1 [low] a — OPENED\n")))
        self.assertTrue(self.bad(body(findings="#I-1 [nit] a — OPEN\n")))
        self.assertTrue(self.bad(body(findings="- **[I-1] bug** — OPEN\n")))
        self.assertTrue(self.bad(body(verdict="CHANGES REQUIRED")))
        self.assertTrue(self.bad("run_id: R1\nstate: s\n"))

    def test_run_id_must_match(self):
        self.assertTrue(self.bad(body(run_id="R1"), run_id="R2"))
        self.assertEqual(self.bad(body(run_id="R1"), run_id="R1"), [])


class Publish(Base):
    def test_first_publish_then_stale_read_then_correct_read(self):
        self.assertEqual(self.run_cli("--run-id", "R1", "--read-run-id", "none", "--body", self.write("a.md", body("R1"))), 0)
        self.assertEqual(self.run_cli("--run-id", "R2", "--read-run-id", "none", "--body", self.write("b.md", body("R2"))), 3)
        self.assertTrue(os.path.exists(os.path.join(self.D, "claude.conflict-R2.md")))
        self.assertEqual(self.run_cli("--run-id", "R3", "--read-run-id", "R1", "--body", self.write("c.md", body("R3"))), 0)

    def test_invalid_body_writes_nothing(self):
        self.assertEqual(self.run_cli("--run-id", "R1", "--read-run-id", "none",
                                      "--body", self.write("a.md", body(verdict="PASS", findings="#I-1 [high] a — OPEN\n"))), 2)
        self.assertFalse(os.path.exists(self.D))

    def test_busy_lock_keeps_conflict(self):
        os.makedirs(self.D)
        with open(os.path.join(self.D, "claude.lock"), "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            self.assertEqual(self.run_cli("--run-id", "R1", "--read-run-id", "none", "--body", self.write("a.md", body())), 75)
        self.assertTrue(os.path.exists(os.path.join(self.D, "claude.conflict-R1.md")))

    def test_full_and_branch_move_in_one_run_keep_both_archives(self):
        branch = os.path.join(self.root, "L", "branch-x")
        os.makedirs(branch)
        self.assertEqual(self.run_cli("--run-id", "R1", "--read-run-id", "none", "--body", self.write("a.md", body("R1", state="same"))), 0)
        with open(os.path.join(branch, "claude.md"), "w") as f:
            f.write(body("B1", state="same"))
        rc = self.run_cli("--run-id", "R2", "--read-run-id", "R1", "--full", "--branch-dir", branch,
                          "--read-run-id-branch", "B1", "--body", self.write("b.md", body("R2", state="new")))
        self.assertEqual(rc, 0)
        olds = sorted(f for f in os.listdir(self.D) if f.startswith("claude.old-"))
        self.assertEqual(len(olds), 2, olds)

    def test_repro_staged_and_old_proofs_archived(self):
        r1, r2 = os.path.join(self.root, "r1"), os.path.join(self.root, "r2")
        os.makedirs(r1); os.makedirs(r2)
        open(os.path.join(r1, "old_spec.rb"), "w").close()
        open(os.path.join(r2, "new_spec.rb"), "w").close()
        self.assertEqual(self.run_cli("--run-id", "R1", "--read-run-id", "none", "--repro", r1, "--body", self.write("a.md", body("R1"))), 0)
        self.assertEqual(self.run_cli("--run-id", "R2", "--read-run-id", "R1", "--repro", r2, "--body", self.write("b.md", body("R2"))), 0)
        repro = os.path.join(self.D, "repro")
        self.assertEqual(os.listdir(os.path.join(repro, "claude")), ["new_spec.rb"])
        archived = [d for d in os.listdir(repro) if d.startswith("claude.old-")]
        self.assertEqual(len(archived), 1)
        self.assertEqual(os.listdir(os.path.join(repro, archived[0])), ["old_spec.rb"])

    def test_failed_proof_copy_leaves_old_record_in_place(self):
        self.assertEqual(self.run_cli("--run-id", "R1", "--read-run-id", "none", "--body", self.write("a.md", body("R1"))), 0)
        r2 = os.path.join(self.root, "r2")
        os.makedirs(r2)
        args = mock.Mock(dir=self.D, runner="claude", run_id="R2", read_run_id="R1", body=self.write("b.md", body("R2")),
                         repro=r2, full=True, branch_dir=None, read_run_id_branch="none")
        with mock.patch.object(pr.shutil, "copytree", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                pr.publish(args)
        self.assertEqual(pr.run_id_of(os.path.join(self.D, "claude.md")), "R1")

    def test_unique_names(self):
        p = os.path.join(self.root, "x.old-a.md")
        self.assertEqual(pr.unique(p), p)
        open(p, "w").close()
        self.assertEqual(pr.unique(p), os.path.join(self.root, "x.old-a-2.md"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
