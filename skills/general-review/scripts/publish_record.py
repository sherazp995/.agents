#!/usr/bin/env python3
"""Publish one agent's review record into its ledger folder, safely.

Usage:
  python3 -I publish_record.py --dir D --runner claude --run-id ID --read-run-id X \
      --body record.md [--repro DIR] [--full] [--branch-dir B --read-run-id-branch Y]

Holds this runner's OS lock on D (and first on B when a branch record moves to
the PR folder), checks that nobody wrote since READ_RUN_ID was noted, archives
and moves as asked, then publishes with a final rename. Never touches another runner's
files. The kernel drops the locks if this process dies.

Exit: 0 published; 2 invalid body (format, status, severity, header, run id, or a
verdict that does not match the open introduced findings; nothing written);
3 someone wrote meanwhile; 75 another run of this runner holds
the lock. On 3 or 75 the body is kept as D/<runner>.conflict-<run id>.md.
"""
import argparse
import datetime
import fcntl
import os
import re
import shutil
import sys

CHANGED, BUSY, INVALID = 3, 75, 2
STATUSES = ("OPEN", "PARTLY", "FIXED", "N/A", "ACCEPTED", "DROPPED")
REQUIRED = ("run_id", "state", "kind", "verdict")
VERDICTS = ("PASS", "CHANGES REQUIRED", "BLOCKED", "N/A", "INCOMPLETE")
OPEN_STATUSES = ("OPEN", "PARTLY")
RANK = {"low": 0, "medium": 1, "high": 2, "blocker": 3}


def run_id_of(path):
    if not os.path.exists(path):
        return "none"
    with open(path, encoding="utf-8") as f:
        m = re.search(r"^run_id:\s*(\S+)", f.read(), re.M)
    return m.group(1) if m else "none"


def state_of(path):
    with open(path, encoding="utf-8") as f:
        m = re.search(r"^state:\s*(\S+)", f.read(), re.M)
    return (m.group(1) if m else "nostate")[:12]


def expected_verdict(gating):
    """Unified Review Protocol verdict from the open introduced findings' severities."""
    if "blocker" in gating:
        return "BLOCKED"
    if "high" in gating or "medium" in gating:
        return "CHANGES REQUIRED"
    return "PASS"


def exempt(line, tail):
    """Pre-existing, question and older-head findings never gate. Only the ID and the
    status detail after the last ' — ' decide; words in the description never do."""
    if re.match(r"^#(?:[a-z0-9_-]+:)?P-", line):
        return True
    detail = tail.lower()
    return any(m in detail for m in ("(pre-existing", "pre-existing)", "(question", "question)", "older head"))


def invalid_lines(body, run_id=None):
    """Format errors, bad statuses, missing headers, and a verdict that does not match the findings."""
    text = open(body, encoding="utf-8").read()
    bad = [f"missing header: {h}:" for h in REQUIRED if not re.search(rf"^{h}:\s*\S", text, re.M)]
    findings, gating, in_manifest = 0, [], False
    for line in text.splitlines():
        if in_manifest and "\t" in line:
            continue
        in_manifest = line.startswith("manifest:")
        if not line.strip() or re.match(r"^[a-z_]+:", line):
            continue
        m = re.match(r"^#[^#\s]\S*\s+\[([^\]]+)\]\s", line)
        if m:
            tail = line.rsplit(" — ", 1)[-1].strip() if " — " in line else ""
            status = re.match(r"(OPEN|PARTLY|FIXED|N/A|ACCEPTED|DROPPED)\b", tail)
            if status:
                findings += 1
                severity = m.group(1).strip().lower()
                if severity not in RANK:
                    bad.append(f"unknown severity [{m.group(1)}]: {line}")
                elif status.group(1) in OPEN_STATUSES and not exempt(line, tail):
                    gating.append(severity)
                continue
        bad.append(line)
    verdict = (re.search(r"^verdict:\s*(.+)$", text, re.M) or [None, ""])[1].strip()
    if verdict and verdict not in VERDICTS:
        bad.append(f"verdict {verdict!r} is not one of {', '.join(VERDICTS)}")
    elif verdict in ("PASS", "CHANGES REQUIRED", "BLOCKED") and verdict != expected_verdict(gating):
        bad.append(f"verdict {verdict} does not match the open introduced findings "
                   f"(expected {expected_verdict(gating)})")
    if verdict in ("CHANGES REQUIRED", "BLOCKED") and not findings:
        bad.append(f"verdict {verdict} but no finding lines")
    body_run = re.search(r"^run_id:\s*(\S+)", text, re.M)
    if run_id and body_run and body_run.group(1) != run_id:
        bad.append(f"run_id {body_run.group(1)} in the body does not match --run-id {run_id}")
    return bad


def lock(folder, runner):
    os.makedirs(folder, exist_ok=True)
    handle = open(os.path.join(folder, f"{runner}.lock"), "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def unique(path):
    """path, or path with -2, -3 ... before its extension when it already exists."""
    base, ext = (path[:-3], ".md") if path.endswith(".md") else (path, "")
    candidate, n = path, 1
    while os.path.exists(candidate):
        n += 1
        candidate = f"{base}-{n}{ext}"
    return candidate


def archive(folder, runner, run_id, record):
    """Move this runner's record (and repro) to a unique .old- name in folder."""
    src_dir = os.path.dirname(record)
    stamp = f"{datetime.date.today().isoformat()}-{state_of(record)}-{run_id[-8:]}"
    os.rename(record, unique(os.path.join(folder, f"{runner}.old-{stamp}.md")))
    repro = os.path.join(src_dir, "repro", runner)
    if os.path.isdir(repro):
        os.makedirs(os.path.join(folder, "repro"), exist_ok=True)
        os.rename(repro, unique(os.path.join(folder, "repro", f"{runner}.old-{stamp}")))


def publish(a):
    record = os.path.join(a.dir, f"{a.runner}.md")
    tmp = os.path.join(a.dir, f"{a.runner}.md.tmp-{a.run_id}")
    os.makedirs(a.dir, exist_ok=True)
    shutil.copyfile(a.body, tmp)

    held = []
    for folder in ([a.branch_dir] if a.branch_dir else []) + [a.dir]:
        h = lock(folder, a.runner)
        if h is None:
            return BUSY, tmp
        held.append(h)

    if run_id_of(record) != a.read_run_id:
        return CHANGED, tmp
    branch_record = os.path.join(a.branch_dir, f"{a.runner}.md") if a.branch_dir else None
    if branch_record and run_id_of(branch_record) != a.read_run_id_branch:
        return CHANGED, tmp

    # Everything that can fail on content (copying the proofs) happens first.
    # After that only renames run, and every old file is kept under a unique name,
    # so a failure part way leaves the old record or its archive, never nothing.
    repro_root = os.path.join(a.dir, "repro")
    staged = None
    if a.repro:
        os.makedirs(repro_root, exist_ok=True)
        staged = os.path.join(repro_root, f"{a.runner}.tmp-{a.run_id}")
        shutil.copytree(a.repro, staged)
    if a.full and os.path.exists(record):
        archive(a.dir, a.runner, a.run_id, record)
    if branch_record and os.path.exists(branch_record):
        archive(a.dir, a.runner, a.run_id, branch_record)
    if staged:
        dest = os.path.join(repro_root, a.runner)
        if os.path.isdir(dest):
            stamp = f"{datetime.date.today().isoformat()}-{state_of(record) if os.path.exists(record) else 'nostate'}-{a.run_id[-8:]}"
            os.rename(dest, unique(os.path.join(repro_root, f"{a.runner}.old-{stamp}")))
        os.rename(staged, dest)
    os.replace(tmp, record)
    return 0, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--runner", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--read-run-id", required=True)
    ap.add_argument("--body", required=True)
    ap.add_argument("--repro")
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--branch-dir")
    ap.add_argument("--read-run-id-branch", default="none")
    a = ap.parse_args()
    if not re.fullmatch(r"[a-z0-9_-]+", a.runner):
        sys.stderr.write("runner must be a lowercase slug\n")
        return 2
    bad = invalid_lines(a.body, a.run_id)
    if a.repro and not os.path.isdir(a.repro):
        bad.append(f"--repro {a.repro} is not a directory")
    if bad:
        sys.stderr.write("not published: fix these lines (statuses: " + ", ".join(STATUSES) + ")\n")
        sys.stderr.write("\n".join(bad) + "\n")
        return INVALID
    code, leftover = publish(a)
    if leftover:
        conflict = os.path.join(a.dir, f"{a.runner}.conflict-{a.run_id}.md")
        os.replace(leftover, conflict)
        print(f"not recorded as current ({'busy' if code == BUSY else 'record changed meanwhile'}); kept {conflict}")
    else:
        print(f"published {os.path.join(a.dir, a.runner + '.md')}")
    return code


if __name__ == "__main__":
    sys.exit(main())
