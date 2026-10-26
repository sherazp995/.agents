#!/usr/bin/env python3
"""Freeze a review's scope: manifest, STATE, a snapshot tree and the diff.

Usage (run from the repository, `cd <REPO> && python3 -I freeze_scope.py ...`):
  freeze_scope.py --kind uncommitted|staged --key KEY --tmp REVIEW_TMP [--prev DIR]
  freeze_scope.py --kind files --key KEY --tmp REVIEW_TMP [--prev DIR] PATH...
  freeze_scope.py --kind pr|branch --key KEY --tmp REVIEW_TMP --base BASE_SHA --head HEAD_SHA [--prev DIR]
  freeze_scope.py --verify REVIEW_TMP/KEY

Writes REVIEW_TMP/KEY/manifest.txt (MANIFEST or INDEX MANIFEST from
references/ledger.md; none for pr and branch), state.txt (STATE), tree.txt (the
snapshot tree) and diff.patch: the full diff on round 1, or with --prev (an
earlier round's KEY folder) the fix diff from that round's tree to this one.

The snapshot comes from HEAD's tree plus only the manifest paths (uncommitted,
files), a copy of the index with nothing added (staged), or HEAD_SHA's tree (pr,
branch). Its objects go to REVIEW_TMP/KEY/objects, with the repo's objects as an
alternate, so the repo's .git objects and index are never written.

--verify re-hashes the manifest and exits 1 when any file changed.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

UNTRACKED_DROPPED = ("tmp/", "log/", "coverage/", ".nyc_output/")


GIT_TIMEOUT = 300  # seconds; a hung git raises TimeoutExpired and the freeze fails instead of waiting forever


def git(*args, env=None, stdin=None, cwd=None):
    full = dict(os.environ, GIT_OPTIONAL_LOCKS="0", **(env or {}))
    return subprocess.run(["git", *args], cwd=cwd, env=full, input=stdin, capture_output=True, check=True,
                          timeout=GIT_TIMEOUT).stdout


def zsplit(out):
    return [p.decode() for p in out.split(b"\0") if p]


def under_review_tmp(path, top, review_tmp):
    rel = os.path.relpath(os.path.realpath(review_tmp), os.path.realpath(top))
    return not rel.startswith("..") and (path == rel or path.startswith(rel + "/"))


def worktree_manifest(top, review_tmp, kind, selection):
    """MANIFEST: changed and untracked paths (or the selected files), hashed from the working tree."""
    if kind == "files":
        # Index paths plus HEAD paths gone from the index (git rm, git mv sources), so deletions stay in scope.
        tracked = set(zsplit(git("ls-files", "-z", "-c", "--", *selection, cwd=top)))
        tracked |= set(zsplit(git("diff", "--name-only", "--no-renames", "-z", "HEAD", "--", *selection, cwd=top)))
        untracked = set(zsplit(git("ls-files", "-z", "-o", "--exclude-standard", "--", *selection, cwd=top)))
    else:
        tracked = set(zsplit(git("diff", "--name-only", "--no-renames", "-z", "HEAD", cwd=top)))
        untracked = set(zsplit(git("ls-files", "-z", "-o", "--exclude-standard", cwd=top)))
    untracked = {p for p in untracked if not p.startswith(UNTRACKED_DROPPED)}
    paths = sorted({p for p in tracked | untracked if not under_review_tmp(p, top, review_tmp)},
                   key=lambda p: p.encode())
    present = [p for p in paths if os.path.lexists(os.path.join(top, p))]
    hashes = dict(zip(present, git("hash-object", "--stdin-paths", cwd=top,
                                   stdin="".join(p + "\n" for p in present).encode()).decode().split()))
    lines = []
    for p in paths:
        full = os.path.join(top, p)
        if p not in hashes:
            lines.append(f"{p}\tdeleted\n")
            continue
        mode = "120000" if os.path.islink(full) else "100755" if os.stat(full).st_mode & 0o100 else "100644"
        lines.append(f"{p}\t{mode}\t{hashes[p]}\n")
    return paths, "".join(lines)


def index_manifest(top):
    """INDEX MANIFEST: staged paths with mode and blob from the index."""
    paths = sorted(set(zsplit(git("diff", "--cached", "--name-only", "--no-renames", "-z", cwd=top))),
                   key=lambda p: p.encode())
    staged = {}
    for entry in zsplit(git("ls-files", "-s", "-z", cwd=top)):
        info, path = entry.split("\t", 1)
        mode, blob, _stage = info.split()
        staged[path] = (mode, blob)
    lines = [f"{p}\t{staged[p][0]}\t{staged[p][1]}\n" if p in staged else f"{p}\tdeleted\n" for p in paths]
    return paths, "".join(lines)


def manifest_for(saved):
    if saved["kind"] == "staged":
        return index_manifest(saved["top"])
    return worktree_manifest(saved["top"], saved["review_tmp"], saved["kind"], saved["selection"])


def short_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def freeze(args):
    top = git("rev-parse", "--show-toplevel").decode().strip()
    common = os.path.abspath(os.path.join(top, git("rev-parse", "--git-common-dir", cwd=top).decode().strip()))
    out = os.path.join(args.tmp, args.key)
    objects = os.path.join(out, "objects")
    os.makedirs(objects, exist_ok=True)
    alternates = [os.path.join(common, "objects")]
    prev_tree = None
    if args.prev:
        with open(os.path.join(args.prev, "tree.txt"), encoding="utf-8") as f:
            prev_tree = f.read().strip()
        alternates.append(os.path.abspath(os.path.join(args.prev, "objects")))
    index = os.path.join(out, "index.tmp")
    env = {"GIT_OBJECT_DIRECTORY": os.path.abspath(objects),
           "GIT_ALTERNATE_OBJECT_DIRECTORIES": os.pathsep.join(alternates),
           "GIT_INDEX_FILE": os.path.abspath(index)}
    saved = {"kind": args.kind, "top": top, "review_tmp": os.path.abspath(args.tmp), "selection": args.paths}

    if args.kind in ("pr", "branch"):
        head = git("rev-parse", "--verify", args.head + "^{commit}", cwd=top).decode().strip()
        state = head
        tree = git("rev-parse", args.head + "^{tree}", cwd=top).decode().strip()
    else:
        head = git("rev-parse", "--verify", "HEAD", cwd=top).decode().strip()
        paths, manifest = manifest_for(saved)
        with open(os.path.join(out, "manifest.txt"), "w", encoding="utf-8", newline="") as f:
            f.write(manifest)
        state = short_hash(manifest) if args.kind == "files" else f"{head}+{short_hash(manifest)}"
        if args.kind == "staged":
            shutil.copyfile(git("rev-parse", "--path-format=absolute", "--git-path", "index", cwd=top).decode().strip(),
                            index)
        else:
            git("read-tree", "HEAD", env=env, cwd=top)
            if paths:
                git("add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul", cwd=top,
                    env=dict(env, GIT_LITERAL_PATHSPECS="1"), stdin="".join(p + "\0" for p in paths).encode())
        tree = git("write-tree", env=env, cwd=top).decode().strip()
        os.remove(index)

    if prev_tree:
        diff = git("diff", "--no-color", "--no-ext-diff", "-M", prev_tree, tree, env=env, cwd=top)
    elif args.kind in ("pr", "branch"):
        diff = git("diff", "--no-color", "--no-ext-diff", f"{args.base}...{args.head}", cwd=top)
    else:
        diff = git("diff", "--no-color", "--no-ext-diff", "HEAD", tree, env=env, cwd=top)
    for name, data in (("state.txt", state + "\n"), ("tree.txt", tree + "\n"), ("freeze.json", json.dumps(saved))):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            f.write(data)
    with open(os.path.join(out, "diff.patch"), "wb") as f:
        f.write(diff)
    print(state)


def verify(folder):
    with open(os.path.join(folder, "freeze.json"), encoding="utf-8") as f:
        saved = json.load(f)
    if saved["kind"] in ("pr", "branch"):
        print("nothing to verify: pr and branch reviews read the head commit, not the working tree")
        return 0
    with open(os.path.join(folder, "manifest.txt"), encoding="utf-8", newline="") as f:
        before = f.read().splitlines()
    after = manifest_for(saved)[1].splitlines()
    changed = sorted({line.split("\t")[0] for line in set(before) ^ set(after)})
    for path in changed:
        print(f"changed: {path}")
    return 1 if changed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--verify", metavar="DIR")
    parser.add_argument("--kind", choices=("uncommitted", "staged", "files", "pr", "branch"))
    parser.add_argument("--key")
    parser.add_argument("--tmp", help="REVIEW_TMP; output goes to REVIEW_TMP/KEY")
    parser.add_argument("--prev", metavar="DIR", help="an earlier round's REVIEW_TMP/KEY folder")
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args()
    if args.verify:
        return verify(args.verify)
    if not (args.kind and args.key and args.tmp):
        parser.error("--kind, --key and --tmp are required")
    if args.kind in ("pr", "branch") and not (args.base and args.head):
        parser.error("pr and branch need --base and --head")
    if (args.kind == "files") != bool(args.paths):
        parser.error("paths are given for --kind files only, and files needs at least one")
    freeze(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
