"""run-planner.sh stops a planner only when it is idle or runs past the ceiling.

Fake `claude` and `codex` scripts on PATH stand in for the CLIs.
"""
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

RUNNER = Path(__file__).resolve().parents[1] / "run-planner.sh"

FAKE_CLAUDE = r"""#!/usr/bin/env bash
cat > /dev/null
case "$FAKE_MODE" in
  busy)
    for i in 1 2 3 4 5 6; do echo '{"type":"stream_event"}'; sleep 1; done
    printf '{"type":"result","is_error":false,"result":"## Steps\\n1. do it\\n"}\n' ;;
  silent) sleep 60 ;;
  forever) while :; do echo '{"type":"stream_event"}'; sleep 1; done ;;
  error) printf '{"type":"result","is_error":true,"result":"boom"}\n' ;;
esac
"""

FAKE_CODEX = r"""#!/usr/bin/env bash
cat > /dev/null
out=""
while [ "$#" -gt 0 ]; do
  [ "$1" = "-o" ] && out="$2"
  shift
done
printf '## Verdict\napprove\n' > "$out"
"""


def write_exec(path, body):
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class RunPlannerTest(unittest.TestCase):
    def setUp(self):
        if not (shutil.which("timeout") or shutil.which("gtimeout")):
            self.skipTest("needs GNU timeout")
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        write_exec(bin_dir / "claude", FAKE_CLAUDE)
        write_exec(bin_dir / "codex", FAKE_CODEX)
        self.prompt = self.tmp / "prompt.md"
        self.prompt.write_text("plan it\n")
        self.out = self.tmp / "out.md"
        self.env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", RETHINK_POLL="1")

    def run_planner(self, side, idle, sections="", **env):
        result = subprocess.run(
            ["bash", str(RUNNER), side, str(self.tmp), str(self.prompt), str(self.out), str(idle), sections],
            env={**self.env, **env},
            capture_output=True,
            text=True,
            timeout=60,
        )
        meta = dict(
            line.split(": ", 1) for line in Path(f"{self.out}.meta").read_text().splitlines()
        )
        return result.returncode, meta

    def test_busy_call_outlives_the_idle_limit(self):
        code, meta = self.run_planner("claude", 3, "## Steps", FAKE_MODE="busy")
        self.assertEqual((code, meta["check"]), (0, "ok"))
        self.assertGreaterEqual(int(meta["seconds"]), 5)
        self.assertIn("1. do it", self.out.read_text())

    def test_silent_call_is_stopped_as_idle(self):
        code, meta = self.run_planner("claude", 3, FAKE_MODE="silent")
        self.assertEqual((code, meta["check"]), (124, "idle"))

    def test_runaway_call_is_stopped_at_the_ceiling(self):
        code, meta = self.run_planner("claude", 30, FAKE_MODE="forever", RETHINK_CEILING="4")
        self.assertEqual((code, meta["check"]), (124, "ceiling"))

    def test_error_result_is_not_an_answer(self):
        code, meta = self.run_planner("claude", 3, FAKE_MODE="error")
        self.assertEqual((code, meta["check"]), (3, "no result in stream"))

    def test_section_check_still_applies(self):
        code, meta = self.run_planner("codex", 3, "## Verdict=approve,changes needed|## Findings")
        self.assertEqual((code, meta["check"]), (3, "missing heading line: ## Findings"))


if __name__ == "__main__":
    unittest.main()
