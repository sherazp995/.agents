#!/usr/bin/env python3
"""Tests for earlier.py. Run: python3 -B ~/.agents/skills/general-review/scripts/test_earlier.py"""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "earlier.py")

OWN = """skill: general-review
runner: claude
run_id: R1
state: aaa
base_sha: bbb
kind: pr
verdict: CHANGES REQUIRED

#I-1 [high] app/a.rb:4 — nil user — OPEN
#I-2 [low] app/b.rb:9 — stale comment — FIXED (2026-10-01)

repro: D/repro/claude/
"""


def sibling(run_id, findings):
    return f"runner: codex\nrun_id: {run_id}\nstate: aaa\nkind: pr\nverdict: CHANGES REQUIRED\n\n{findings}"


class Earlier(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.D = os.path.join(self.root, "42")
        os.makedirs(self.D)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, text):
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def build(self, *args):
        out = os.path.join(self.root, f"earlier-{len(os.listdir(self.root))}.md")
        subprocess.run([sys.executable, "-I", "-B", SCRIPT, "--dir", self.D, "--runner", "claude", "--out", out, *args],
                       check=True)
        with open(out, encoding="utf-8") as f:
            return out, f.read()

    def test_round_one_from_ledger_folder(self):
        self.write(os.path.join(self.D, "claude.md"), OWN)
        self.write(os.path.join(self.D, "claude.old-2026-10-01-aaa-x.md"), sibling("OLD", "#I-7 [low] x — OPEN\n"))
        self.write(os.path.join(self.D, "codex.md"), sibling("C1", "#I-1 [medium] app/c.rb:2 — race — OPEN\n"))
        _, text = self.build()
        self.assertEqual(text, f"""source: {self.D}/claude.md
state: aaa
base_sha: bbb
repro: D/repro/claude/

#I-1 [high] app/a.rb:4 — nil user — OPEN
#I-2 [low] app/b.rb:9 — stale comment — FIXED (2026-10-01)

other agents (read-only):
sibling: {self.D}/codex.md
run_id: C1
state: aaa
verdict: CHANGES REQUIRED
#I-1 [medium] app/c.rb:2 — race — OPEN
""")

    def test_empty_folder_is_none(self):
        self.assertEqual(self.build()[1], "none\n")

    def test_later_round_uses_previous_record_and_imports_changed_sibling(self):
        self.write(os.path.join(self.D, "claude.md"), OWN)
        codex = self.write(os.path.join(self.D, "codex.md"), sibling("C1", "#I-1 [medium] app/c.rb:2 — race — OPEN\n"))
        first, _ = self.build()
        record = self.write(os.path.join(self.root, "record.md"),
                            OWN.replace("run_id: R1", "run_id: R2").replace("— nil user — OPEN", "— nil user — FIXED")
                            + "#codex:I-1 [medium] app/c.rb:2 — race — OPEN (checked by claude)\n")
        self.write(codex, sibling("C2", "#I-1 [medium] app/c.rb:2 — race — FIXED\n#I-2 [high] app/d.rb:5 — leak — OPEN\n"))
        _, text = self.build("--from-record", record, "--prev-earlier", first)
        self.assertIn(f"source: {record}\n", text)
        self.assertIn("#I-1 [high] app/a.rb:4 — nil user — FIXED\n", text)
        self.assertIn("#codex:I-1 [medium] app/c.rb:2 — race — OPEN (checked by claude)\n", text)
        self.assertIn("run_id: C2\n", text)
        self.assertIn("#I-2 [high] app/d.rb:5 — leak — OPEN\n", text)

    def test_later_round_keeps_unchanged_sibling_block(self):
        codex = self.write(os.path.join(self.D, "codex.md"), sibling("C1", "#I-1 [medium] app/c.rb:2 — race — OPEN\n"))
        first, first_text = self.build()
        record = self.write(os.path.join(self.root, "record.md"), OWN)
        self.write(codex, sibling("C1", "#I-1 [medium] edited without a new run — OPEN\n"))
        _, text = self.build("--from-record", record, "--prev-earlier", first)
        self.assertEqual(text.split("other agents (read-only):")[1], first_text.split("other agents (read-only):")[1])


if __name__ == "__main__":
    unittest.main(verbosity=1)
