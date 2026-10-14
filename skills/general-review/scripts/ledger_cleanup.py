#!/usr/bin/env python3
"""Clean one runner's finished records in the review ledger (references/ledger-cleanup.md).

Usage:
  python3 -I ledger_cleanup.py --ledger-root LEDGER_ROOT --repo REPO --gh-repo OWNER/NAME|none \
      --runner RUNNER [--list-only | --delete]

List-only is the default: it prints the paths it would delete and deletes nothing.
--delete removes only RUNNER's files of each finished key, under RUNNER's lock
(with_lock.py), after re-checking that the record was not rewritten since it was read.
Never touches other runners' files, lock or conflict files, and never fetches or changes refs.
Exit: 0 always after a report; 2 on bad arguments.
"""
import argparse
import glob
import os
import re
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WITH_LOCK = os.path.join(HERE, "with_lock.py")
CHANGED, BUSY = 3, 75


def run(cmd, cwd):
    """Run a read-only gh or git command; return (exit code, stdout)."""
    try:
        done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    except OSError:
        return 127, ""
    return done.returncode, done.stdout


def decode(name):
    return name.replace("%2F", "/").replace("%25", "%")


def own_records(folder, runner):
    current = os.path.join(folder, f"{runner}.md")
    olds = sorted(glob.glob(os.path.join(glob.escape(folder), f"{glob.escape(runner)}.old-*.md")))
    return (current if os.path.isfile(current) else None), olds


def own_paths(folder, runner):
    esc, run_esc = glob.escape(folder), glob.escape(runner)
    paths = [os.path.join(folder, f"{runner}.md")] + glob.glob(os.path.join(esc, f"{run_esc}.old-*.md"))
    paths += [os.path.join(folder, "repro", runner)] + glob.glob(os.path.join(esc, "repro", f"{run_esc}.old-*"))
    return sorted(p for p in paths if os.path.lexists(p))


def field(text, name):
    m = re.search(rf"^{name}:\s*(\S+)\s*$", text, re.M)
    return m.group(1) if m else None


def open_findings(text):
    return [line for line in text.splitlines()
            if re.match(r"^#[^#\s]\S*\s+\[[^\]]+\]\s", line) and " — " in line
            and re.match(r"(OPEN|PARTLY)\b", line.rsplit(" — ", 1)[-1].strip())]


class Checker:
    def __init__(self, repo, gh_repo):
        self.repo, self.gh_repo = repo, gh_repo

    def gh(self, *args):
        if self.gh_repo == "none":
            return None
        code, out = run(["gh", *args, "--repo", self.gh_repo], self.repo)
        return out.strip() if code == 0 else None

    def git(self, *args):
        return run(["git", *args], self.repo)

    def local_branch_exists(self, branch):
        return self.git("show-ref", "--verify", "--quiet", f"refs/heads/{branch}")[0] == 0

    def absent_on_origin(self, branch):
        code, out = self.git("ls-remote", "--heads", "origin", f"refs/heads/{branch}")
        return code == 0 and f"refs/heads/{branch}" not in [ln.split("\t")[-1] for ln in out.splitlines()]

    def commit_exists(self, sha):
        return self.git("cat-file", "-e", f"{sha}^{{commit}}")[0] == 0

    def pr_finished(self, number):
        state = self.gh("pr", "view", number, "--json", "state", "-q", ".state")
        return (state in ("MERGED", "CLOSED"), state.lower() if state else "unknown")

    def branch_finished(self, branch, base):
        if self.gh("pr", "list", "--head", branch, "--state", "all", "--json", "number", "-q", ".[0].number"):
            return False, "has a PR"
        if self.absent_on_origin(branch):
            if self.local_branch_exists(branch):
                return False, "still exists locally"
            return True, "deleted on origin"
        if not base:
            return False, "no base in record"
        code, out = self.git("ls-remote", "origin", f"refs/heads/{branch}", f"refs/heads/{base}")
        pairs = (ln.split("\t", 1) for ln in out.splitlines() if "\t" in ln) if code == 0 else ()
        shas = {ref: sha for sha, ref in pairs}
        head, base_sha = shas.get(f"refs/heads/{branch}"), shas.get(f"refs/heads/{base}")
        if head and base_sha and self.commit_exists(head) and self.commit_exists(base_sha) \
                and self.git("merge-base", "--is-ancestor", head, base_sha)[0] == 0:
            return True, "merged"
        return False, "not merged"

    def local_finished(self, branch):
        if branch == "detached":
            return False, "detached"
        if not self.local_branch_exists(branch) and self.absent_on_origin(branch):
            return True, "deleted"
        return False, "branch still exists"


def decide(checker, key, text):
    """Return (finished, reason) for one key, per the decision table."""
    if key.isdigit():
        return checker.pr_finished(key)
    if key.startswith("branch-"):
        return checker.branch_finished(decode(key[len("branch-"):]), field(text, "base"))
    for prefix in ("local-", "staged-"):
        if key.startswith(prefix):
            return checker.local_finished(decode(key[len(prefix):]))
    return False, "always kept"


def delete(folder, runner, run_id, paths):
    """Delete under RUNNER's lock if the record is unchanged; return the exit code."""
    record = shlex.quote(f"{runner}.md")
    check = (f"grep -qx {shlex.quote('run_id: ' + run_id)} {record}" if run_id
             else f"[ ! -e {record} ]")
    rel = " ".join(shlex.quote(os.path.relpath(p, folder)) for p in paths)
    script = f"{check} || exit {CHANGED}; rm -rf -- {rel}"
    return subprocess.call([sys.executable, "-I", WITH_LOCK, os.path.join(folder, f"{runner}.lock"),
                            "--", "bash", "-c", script], cwd=folder)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--ledger-root", required=True)
    p.add_argument("--repo", required=True)
    p.add_argument("--gh-repo", required=True)
    p.add_argument("--runner", required=True)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--list-only", action="store_true")  # the default; named for clarity
    mode.add_argument("--delete", action="store_true")
    a = p.parse_args(argv)
    checker = Checker(a.repo, a.gh_repo)
    would, cleaned, kept, skipped, unfixed = [], [], [], [], []
    for key in sorted(os.listdir(a.ledger_root)):
        folder = os.path.join(a.ledger_root, key)
        if key == ".origin" or not os.path.isdir(folder):
            continue
        current, olds = own_records(folder, a.runner)
        if not current and not olds:
            continue
        with open(current or olds[-1], encoding="utf-8") as f:
            text = f.read()
        finished, reason = decide(checker, key, text)
        if not finished:
            kept.append(f"{key} ({reason})")
            continue
        found = open_findings(text)
        if found:
            unfixed.append(f"{key} finished with these still open:\n" + "\n".join(found))
        paths = own_paths(folder, a.runner)
        if not a.delete:
            would += paths
            continue
        code = delete(folder, a.runner, field(text, "run_id") if current else None, paths)
        (cleaned if code == 0 else skipped).append(f"{key} ({reason})" if code == 0 else f"{key} (exit {code})")
    if would:
        print("Would clean (list-only): " + " ".join(would))
    elif cleaned:
        print("Cleaned: " + ", ".join(cleaned))
    else:
        print("Nothing to clean")
    for block in unfixed:
        print(block)
    if kept:
        print("Kept: " + ", ".join(kept))
    if skipped:
        print("Skipped (locked or changed): " + ", ".join(skipped))
    return 0


if __name__ == "__main__":
    sys.exit(main())
