#!/usr/bin/env python3
"""Tests for freeze_scope.py. Run: python3 -B ~/.agents/skills/general-review/scripts/test_freeze_scope.py"""
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "freeze_scope.py")
ENV = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_AUTHOR_NAME="t",
           GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")

# The hand-built manifests from references/ledger.md ("MANIFEST" and "INDEX MANIFEST"), as a coordinator types them.
HAND_MANIFEST = r"""
{ git diff --name-only HEAD; git ls-files -o --exclude-standard | grep -Ev '^(tmp|log|coverage|\.nyc_output)/'; } |
LC_ALL=C sort -u | while IFS= read -r p; do
  if [ -L "$p" ]; then m=120000; elif [ -e "$p" ]; then if [ -x "$p" ]; then m=100755; else m=100644; fi
  else printf '%s\tdeleted\n' "$p"; continue; fi
  printf '%s\t%s\t%s\n' "$p" "$m" "$(git hash-object "$p")"
done
"""
HAND_INDEX_MANIFEST = r"""
git diff --cached --name-only | LC_ALL=C sort -u | while IFS= read -r p; do
  l=$(git ls-files -s -- "$p")
  if [ -n "$l" ]; then set -- $l; printf '%s\t%s\t%s\n' "$p" "$1" "$2"; else printf '%s\tdeleted\n' "$p"; fi
done
"""


class FreezeScope(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self.tmp.name, "repo")
        self.review_tmp = os.path.join(self.tmp.name, "review")
        os.makedirs(self.repo)
        self.git("init", "-q", "-b", "main")
        for name, text in (("a.txt", "a\n"), ("b.txt", "b\n"), ("gone.txt", "gone\n"), ("old.txt", "old\n"),
                           ("tmp/kept.txt", "kept\n")):
            self.write(name, text)
        self.git("add", "-A")
        self.git("commit", "-qm", "base")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.repo, env=ENV, capture_output=True, check=True,
                              text=True).stdout

    def sh(self, script, cwd=None):
        return subprocess.run(["sh", "-c", script], cwd=cwd or self.repo, env=ENV, capture_output=True,
                              check=True).stdout.decode()

    def write(self, name, text, cwd=None):
        path = os.path.join(cwd or self.repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def read(self, key, name):
        with open(os.path.join(self.review_tmp, key, name), encoding="utf-8") as f:
            return f.read()

    def git_dir_snapshot(self, cwd=None):
        """Every file under the repo's object store, plus the index bytes."""
        common = os.path.join(cwd or self.repo, self.git("rev-parse", "--git-common-dir", cwd=cwd).strip())
        objects = sorted(os.path.join(d, f) for d, _, fs in os.walk(os.path.join(common, "objects")) for f in fs)
        index = self.git("rev-parse", "--path-format=absolute", "--git-path", "index", cwd=cwd).strip()
        with open(index, "rb") as f:
            return objects, f.read()

    def freeze(self, *args, cwd=None, code=0):
        before = self.git_dir_snapshot(cwd)
        run = subprocess.run([sys.executable, "-I", "-B", SCRIPT, "--tmp", self.review_tmp, *args],
                             cwd=cwd or self.repo, env=ENV, capture_output=True, text=True)
        self.assertEqual(run.returncode, code, run.stderr)
        self.assertEqual(self.git_dir_snapshot(cwd), before, "the repo's objects or index were written")
        return run.stdout

    def blob(self, tree, path):
        env = dict(ENV, GIT_ALTERNATE_OBJECT_DIRECTORIES=":".join(
            os.path.join(self.review_tmp, k, "objects") for k in os.listdir(self.review_tmp)))
        return subprocess.run(["git", "rev-parse", "--verify", "-q", f"{tree}:{path}"], cwd=self.repo, env=env, capture_output=True,
                              text=True).stdout.strip()

    def state_of(self, manifest):
        return self.git("rev-parse", "HEAD").strip() + "+" + hashlib.sha256(manifest.encode()).hexdigest()[:12]

    def test_uncommitted_matches_hand_built_manifest_and_keeps_scope(self):
        self.write("a.txt", "a changed\n")
        os.chmod(os.path.join(self.repo, "b.txt"), 0o755)
        os.remove(os.path.join(self.repo, "gone.txt"))
        os.symlink("a.txt", os.path.join(self.repo, "link"))
        self.write("new.txt", "new\n")
        self.write("tmp/scratch.txt", "untracked in tmp\n")
        self.write("tmp/kept.txt", "tracked in tmp\n")
        self.write("old.txt", "staged only\n")
        self.git("add", "old.txt")
        self.write("old.txt", "old\n")
        hand = self.sh(HAND_MANIFEST)

        self.freeze("--kind", "uncommitted", "--key", "local-main")

        self.assertEqual(self.read("local-main", "manifest.txt"), hand)
        self.assertEqual(self.read("local-main", "state.txt"), self.state_of(hand) + "\n")
        tree = self.read("local-main", "tree.txt").strip()
        diff = self.read("local-main", "diff.patch")
        self.assertIn("new file mode 100644", diff)
        self.assertIn("+new", diff)
        self.assertNotIn("scratch", diff)
        self.assertEqual(self.blob(tree, "tmp/scratch.txt"), "")
        self.assertNotIn("staged only", diff)
        self.assertEqual(self.blob(tree, "old.txt"), self.git("rev-parse", "HEAD:old.txt").strip())

    def test_staged_holds_only_the_staged_content(self):
        self.write("a.txt", "staged\n")
        self.git("add", "a.txt")
        self.write("a.txt", "unstaged\n")
        hand = self.sh(HAND_INDEX_MANIFEST)

        self.freeze("--kind", "staged", "--key", "staged-main")

        self.assertEqual(self.read("staged-main", "manifest.txt"), hand)
        self.assertEqual(self.read("staged-main", "state.txt"), self.state_of(hand) + "\n")
        tree = self.read("staged-main", "tree.txt").strip()
        self.assertEqual(self.blob(tree, "a.txt"), self.git("rev-parse", ":a.txt").strip())
        diff = self.read("staged-main", "diff.patch")
        self.assertIn("+staged", diff)
        self.assertNotIn("unstaged", diff)

    def test_pr_reads_the_head_commit_from_another_checkout(self):
        base = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-qb", "feature")
        self.write("a.txt", "feature\n")
        self.git("commit", "-qam", "feature")
        head = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-qb", "other", base)
        self.write("b.txt", "unrelated edit\n")

        self.freeze("--kind", "pr", "--key", "7", "--base", base, "--head", head)

        self.assertEqual(self.read("7", "state.txt"), head + "\n")
        self.assertEqual(self.read("7", "tree.txt").strip(), self.git("rev-parse", f"{head}^{{tree}}").strip())
        self.assertEqual(self.read("7", "diff.patch"), self.git("diff", f"{base}...{head}"))

    def test_files_holds_only_the_selected_files(self):
        self.write("a.txt", "a changed\n")
        self.write("new.txt", "new\n")
        self.write("b.txt", "unrelated edit\n")
        hand = self.sh(HAND_MANIFEST.replace(
            "{ git diff --name-only HEAD; git ls-files -o --exclude-standard | grep -Ev '^(tmp|log|coverage|\\.nyc_output)/'; }",
            "printf '%s\\n' a.txt new.txt"))

        self.freeze("--kind", "files", "--key", "files-x", "a.txt", "new.txt")

        self.assertEqual(self.read("files-x", "manifest.txt"), hand)
        self.assertEqual(self.read("files-x", "state.txt"), hashlib.sha256(hand.encode()).hexdigest()[:12] + "\n")
        tree = self.read("files-x", "tree.txt").strip()
        self.assertEqual(self.blob(tree, "b.txt"), self.git("rev-parse", "HEAD:b.txt").strip())
        diff = self.read("files-x", "diff.patch")
        self.assertEqual(sorted(line[6:] for line in diff.splitlines() if line.startswith("+++ b/")),
                         ["a.txt", "new.txt"])

    def test_files_keeps_selected_paths_removed_from_the_index(self):
        for name in ("lib/a.txt", "lib/gone.txt", "lib/old.txt"):
            self.write(name, name + "\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "lib")
        self.git("rm", "-q", "lib/gone.txt")
        self.git("mv", "lib/old.txt", "lib/moved.txt")
        self.git("rm", "-q", "b.txt")

        self.freeze("--kind", "files", "--key", "one", "lib/gone.txt")
        self.freeze("--kind", "files", "--key", "dir", "lib")

        self.assertEqual(self.read("one", "manifest.txt"), "lib/gone.txt\tdeleted\n")
        self.assertIn("deleted file mode 100644", self.read("one", "diff.patch"))
        manifest = self.read("dir", "manifest.txt")
        self.assertIn("lib/gone.txt\tdeleted\n", manifest)
        self.assertIn("lib/old.txt\tdeleted\n", manifest)
        self.assertIn("lib/moved.txt\t100644\t", manifest)
        self.assertNotIn("b.txt", manifest)
        diff = self.read("dir", "diff.patch")
        self.assertIn("--- a/lib/gone.txt", diff)
        self.assertIn("rename from lib/old.txt\nrename to lib/moved.txt", diff)
        tree = self.read("dir", "tree.txt").strip()
        self.assertEqual(self.blob(tree, "lib/gone.txt"), "")
        self.assertEqual(self.blob(tree, "lib/old.txt"), "")
        self.assertEqual(self.blob(tree, "b.txt"), self.git("rev-parse", "HEAD:b.txt").strip())

    def test_linked_worktree(self):
        linked = os.path.join(self.tmp.name, "linked")
        self.git("worktree", "add", "-q", "-b", "side", linked)
        self.write("a.txt", "in worktree\n", cwd=linked)
        hand = self.sh(HAND_MANIFEST, cwd=linked)

        self.freeze("--kind", "uncommitted", "--key", "local-side", cwd=linked)

        self.assertEqual(self.read("local-side", "manifest.txt"), hand)
        self.assertIn("+in worktree", self.read("local-side", "diff.patch"))

    def test_prev_gives_the_fix_diff_with_a_delete_and_a_rename(self):
        self.write("a.txt", "round one\n")
        self.freeze("--kind", "uncommitted", "--key", "r1")
        self.write("b.txt", "fixed\n")
        os.remove(os.path.join(self.repo, "gone.txt"))
        os.rename(os.path.join(self.repo, "old.txt"), os.path.join(self.repo, "renamed.txt"))

        self.freeze("--kind", "uncommitted", "--key", "r2", "--prev", os.path.join(self.review_tmp, "r1"))

        diff = self.read("r2", "diff.patch")
        self.assertIn("+fixed", diff)
        self.assertIn("deleted file mode 100644", diff)
        self.assertIn("rename from old.txt\nrename to renamed.txt", diff)
        self.assertNotIn("round one", diff)

    def test_verify_exits_1_when_a_file_changed(self):
        self.write("a.txt", "a changed\n")
        self.freeze("--kind", "uncommitted", "--key", "local-main")
        folder = os.path.join(self.review_tmp, "local-main")
        self.freeze("--verify", folder)
        self.write("a.txt", "edited during the review\n")
        self.assertIn("changed: a.txt", self.freeze("--verify", folder, code=1))


if __name__ == "__main__":
    unittest.main()
