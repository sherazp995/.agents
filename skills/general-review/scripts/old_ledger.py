#!/usr/bin/env python3
"""Read old cohabit_pr_review ledger records for one key and print them as one
normalized earlier-findings list for general-review. Read-only: never writes.

Usage: python3 old_ledger.py --slug cohabit-web --key 3754 [--branch fix/x] [--json]
Exit: 0 found, 3 no old record, 4 some or all old records are locked (partial list printed; do not record).
"""
import argparse
import glob
import json
import os
import re
import sys

ROOT = os.path.expanduser("~/.claude/pr-review-ledger")
SHA = re.compile(r"\b[0-9a-f]{40}\b")
STATUS_WORDS = re.compile(r"\b(NOT FIXED|FIXED|OPEN|PARTLY|DROPPED|N/A|DECLINED|ACCEPTED)\b")
SEVERITIES = {"CRITICAL": "blocker", "BLOCKER": "blocker", "HIGH": "high",
              "MEDIUM": "medium", "LOW": "low", "NIT": "low"}
LOCAL_HINT = re.compile(r"local only|LOCAL commit|not pushed", re.I)


def fields(text):
    out = {}
    for line in text.splitlines():
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if m and m.group(1) not in out:
            out[m.group(1)] = m.group(2).strip()
    return out


def candidates(slug, key, branch):
    base = os.path.join(ROOT, slug)
    names = [key]
    if branch:
        names.append("branch-" + branch.replace("/", "__"))
    paths = []
    for name in names:
        paths += sorted(glob.glob(os.path.join(base, "agents", "*", name + ".md")))
        paths += sorted(glob.glob(os.path.join(base, "runs", "*", name + ".md")))
        root_path = os.path.join(base, name + ".md")
        if os.path.exists(root_path):
            paths.append(root_path)
    return base, paths


def runner_of(path, base):
    rel = os.path.relpath(path, base).split(os.sep)
    return rel[1] if rel[0] == "agents" and len(rel) > 2 else "legacy"


def status_of(segment):
    """The status word must open the segment; the explanation only refines it."""
    m = STATUS_WORDS.match(segment.strip())
    if not m:
        return "UNKNOWN"
    status = {"NOT FIXED": "OPEN", "DECLINED": "ACCEPTED"}.get(m.group(1), m.group(1))
    detail = segment.strip()[m.end():]
    # "(accepted)" or "; accepted, not blocking" close it; "(not yet accepted)" does not.
    if status in ("OPEN", "PARTLY") and re.search(r"[(;,]\s*accepted\b", detail, re.I):
        return "ACCEPTED"
    if status == "OPEN" and re.search(r"\(\s*PARTLY\b", detail):
        return "PARTLY"
    return status


def split_line(body):
    for sep in (" — ", " : "):
        if sep in body:
            head, _, tail = body.rpartition(sep)
            return head, tail
    head, _, tail = body.rpartition(": ")
    return (head, tail) if head else (body, "")


def parse_finding(line, runner):
    m = re.match(r"^#([^#\s]\S*)\s+(.*)$", line)
    if not m:
        return None
    old_id, rest = m.groups()
    tag = ""
    t = re.match(r"^\[([^\]]+)\]\s*(.*)$", rest)
    if t:
        tag, rest = t.groups()
    text, segment = split_line(rest)
    status = status_of(segment)
    tag_up = tag.upper()
    if "DROPPED" in tag_up:
        status = "DROPPED"
    sev_word = re.split(r"[,\s>-]+", tag_up)[0] if tag_up else ""
    severity = SEVERITIES.get(sev_word, "low")
    question = "QUESTION" in tag_up or "(question)" in line.lower()
    return {"id": f"O-{runner}-{old_id}", "severity": severity, "status": status,
            "question": question, "text": text.strip(), "status_text": segment.strip(),
            "raw": line}


def load(path, base):
    text = open(path, encoding="utf-8").read()
    f = fields(text)
    runner = f.get("runner") or runner_of(path, base)
    head_line = f.get("head", "")
    sha = SHA.search(head_line)
    findings, notes = [], []
    for line in text.splitlines():
        line = line.rstrip()
        if line.startswith("#"):
            item = parse_finding(line, runner)
            if item:
                findings.append(item)
        elif re.match(r"^(dropped|DROPPED|PRE-EXISTING|earlier)\b", line):
            notes.append(line)
    stamp = re.search(r"-(\d{8}T\d{6}Z)-", f.get("run_id", ""))
    return {"path": path, "runner": runner, "head": sha.group(0) if sha else None,
            "local_head": bool(LOCAL_HINT.search(text.split("base_sha:")[0])),
            "date": f.get("date", ""), "stamp": stamp.group(1) if stamp else "",
            "base_sha": f.get("base_sha", ""),
            "inherited_from": re.sub(r"\s+\(.*\)\s*$", "", f.get("inherited_from") or "") or None,
            "repro": f.get("repro", "none") or "none",
            "old_verdict": f.get("verdict", ""), "findings": findings, "notes": notes}


def verdict(findings):
    gating = [x for x in findings if x["status"] in ("OPEN", "PARTLY") and not x["question"]]
    if any(x["severity"] == "blocker" for x in gating):
        return "BLOCKED"
    if any(x["severity"] in ("high", "medium") for x in gating):
        return "CHANGES REQUIRED"
    return "PASS"


def build(slug, key, branch):
    base, paths = candidates(slug, key, branch)
    lock_dirs = glob.glob(os.path.join(base, "agents", "*.lock"))
    locked = {os.path.basename(d)[:-5] for d in lock_dirs}
    # Explicit lineage: inherited_from links in candidates and in their .old- archives.
    lineage = {}
    for p in paths:
        for f in [p] + glob.glob(p[:-3] + ".old-*.md"):
            src = fields(open(f, encoding="utf-8").read()).get("inherited_from")
            if src:
                lineage.setdefault(os.path.realpath(p), set()).add(
                    os.path.realpath(re.sub(r"\s+\(.*\)\s*$", "", src)))
    records, warnings, skipped_locked = [], [], False
    for p in paths:
        r = load(p, base)
        if r["runner"] in locked:
            skipped_locked = True
            lock_dir = os.path.join(base, "agents", r["runner"] + ".lock")
            age = int((__import__("time").time() - os.path.getmtime(lock_dir)) / 60)
            warnings.append(f"skipped {p}: runner {r['runner']} holds the old skill's lock {lock_dir} "
                            f"(age {age} min); if no old-skill run is active, ask the user to remove it")
            continue
        if not r["head"]:
            warnings.append(f"skipped {p}: no 40-hex head")
            continue
        records.append(r)
    # Every loaded record's unknown statuses are reported, before any dedupe.
    all_unknown = [x["raw"] for r in records for x in r["findings"] if x["status"] == "UNKNOWN"]
    # Records joined by inherited_from links form one copy chain; findings are only
    # ever matched against records of the same chain.
    by_path = {os.path.realpath(r["path"]): r for r in records}
    parent = {k: k for k in by_path}

    def root(k):
        while parent[k] != k:
            k = parent[k]
        return k

    for k, r in by_path.items():
        src = os.path.realpath(r["inherited_from"] or "")
        if src in by_path:
            parent[root(k)] = root(src)
    for k, r in by_path.items():
        r["chain"] = root(k)
    # A copy and its source describe one history: keep whichever is newer.
    drop = set()
    for r in records:
        src = by_path.get(os.path.realpath(r["inherited_from"] or ""))
        if src is not None:
            older = r if (r["date"], r["stamp"]) <= (src["date"], src["stamp"]) else src
            drop.add(os.path.realpath(older["path"]))
    dropped = [r for r in records if os.path.realpath(r["path"]) in drop]
    records = [r for r in records if os.path.realpath(r["path"]) not in drop]
    incomplete = skipped_locked
    if not records:
        return {"found": False, "locked": incomplete, "key": key, "warnings": warnings}
    newest = max(records, key=lambda r: (r["date"], r["stamp"]))
    chosen = [r for r in records if r["head"] == newest["head"]]
    older = [r for r in records if r["head"] != newest["head"]]
    history = [r["path"] for r in older]
    # An older record is superseded only through explicit lineage: a newest-head
    # record (or one of its archives) says it was inherited from it.
    copied = set().union(*(lineage.get(os.path.realpath(r["path"]), set()) for r in chosen))

    def superseded(r):
        return os.path.realpath(r["path"]) in copied

    seen = {}
    for r in records + dropped:
        for x in r["findings"]:
            n = seen.get(x["id"], 0) + 1
            seen[x["id"]] = n
            if n > 1:
                x["id"] = f"{x['id']}-r{n}"
    # A legacy record whose finding numbers all reappear in the current record is
    # most likely continued by it: fold its open lines into one group line.
    # Blocker and high lines are never folded.
    def num(x):
        return x["id"].split("-")[2]

    new_nums = {num(x) for r in chosen for x in r["findings"]}
    older_open, folded = [], []
    # A dropped copy/source may hold findings the kept record lacks. Group every
    # copy of such a finding across the chain and let one copy decide: a copy at
    # the current head if any, otherwise the newest. Order of the files never matters.
    kept = {(r["chain"], num(x), x["text"]) for r in records for x in r["findings"]}
    copies = [r["path"] for r in dropped]
    rescued_from = [r for r in dropped if r["repro"] != "none"]
    groups = {}
    for r in dropped:
        for x in r["findings"]:
            if (r["chain"], num(x), x["text"]) not in kept:
                groups.setdefault((r["chain"], num(x), x["text"]), []).append((r, x))
    chain_unknown = [x["raw"] for obs in groups.values() for _, x in obs if x["status"] == "UNKNOWN"]
    for obs in groups.values():
        current = [o for o in obs if o[0]["head"] == newest["head"]]
        r, x = max(current or obs, key=lambda o: (o[0]["date"], o[0]["stamp"], o[0]["path"]))
        if x["status"] in ("OPEN", "PARTLY", "UNKNOWN"):
            older_open.append(dict(x, id=x["id"] + "-dropped",
                                   older_head=None if r["head"] == newest["head"] else r["head"]))
    for r in older:
        if superseded(r):
            continue
        opens = [dict(x, older_head=r["head"]) for x in r["findings"]
                 if x["status"] in ("OPEN", "PARTLY", "UNKNOWN")]
        continued = r["runner"] == "legacy" and {num(x) for x in r["findings"]} <= new_nums
        fold = [x for x in opens if continued and x["severity"] not in ("blocker", "high")]
        older_open += [x for x in opens if x not in fold]
        if fold:
            folded.append({"path": r["path"], "head": r["head"], "members": fold})
    same_head = [x for x in older_open if x["older_head"] is None]
    findings_for_verdict = same_head
    if any(x["severity"] in ("blocker", "high") and not x["question"] for x in older_open):
        warnings.append("an older-head record has open blocker/high findings; recheck them")
    findings = [x for r in chosen for x in r["findings"]]
    unknown = list(dict.fromkeys(all_unknown + chain_unknown + [x["raw"] for x in findings + older_open + [m for g in folded for m in g["members"]]
               if x["status"] == "UNKNOWN"]))
    if unknown:
        warnings.append(f"{len(unknown)} line(s) with an unknown status; ask the user before trusting the verdict")
    return {"found": True, "incomplete": incomplete, "key": key, "state": newest["head"],
            "local_head": any(r["local_head"] for r in chosen),
            "base_sha": newest["base_sha"], "date": newest["date"],
            "sources": [r["path"] for r in chosen],
            "repro": {r["path"]: r["repro"] for r in chosen + [o for o in older if not superseded(o)] + rescued_from},
            "source_runners": sorted({r["runner"] for r in chosen}),
            "old_verdicts": {r["path"]: r["old_verdict"] for r in chosen},
            "verdict": verdict(findings + findings_for_verdict), "history": history, "copies": copies,
            "findings": findings, "older_open": older_open, "folded": folded, "unknown": unknown,
            "notes": [n for r in chosen for n in r["notes"]], "warnings": warnings}


def finding_line(x, tag=""):
    q = " (question)" if x["question"] else ""
    rest = re.sub(r"^\s*(NOT FIXED|FIXED|OPEN|PARTLY|DROPPED|N/A|DECLINED|ACCEPTED)\b[\s:]*", "", x["status_text"]).strip()
    if rest.startswith("(") and rest.endswith(")"):
        rest = rest[1:-1].strip()
    rest = re.sub(r"^(PARTLY|OPEN)\b[\s:]*", "", rest) if x["status"] in ("PARTLY", "OPEN") else rest
    parts = [p for p in (rest, tag) if p]
    detail = f" ({'; '.join(parts)})" if parts else ""
    return f"#{x['id']} [{x['severity']}] {x['text']} — {x['status']}{q}{detail}"


def render(d):
    if not d["found"]:
        lines = [f"no old record for {d['key']}"] + (
            ["complete: no (old records are locked; do not record)"] if d.get("locked") else [])
    else:
        lines = [f"imported_from: {', '.join(d['sources'])}",
                 f"complete: {'no (a source runner holds a lock; do not record)' if d['incomplete'] else 'yes'}",
                 f"source_runner: {', '.join(d['source_runners'])}",
                 f"state: {d['state']}" + ("  (local only, not pushed when recorded)" if d["local_head"] else ""),
                 f"base_sha: {d['base_sha']}", f"date: {d['date']}",
                 f"recomputed_verdict: {d['verdict']}"]
        for path, v in d["old_verdicts"].items():
            lines.append(f"old_verdict: {v}  ({path})")
        if len(d["source_runners"]) > 1:
            lines.append("note: merged runners may list the same problem twice")
        for path, repro in d["repro"].items():
            lines.append(f"repro: {repro}  ({path})")
        for c in d["copies"]:
            lines.append(f"history (copy or source replaced by its newer twin): {c}")
        for h in d["history"]:
            lines.append(f"history (older head): {h}")
        lines.append("")
        for x in d["findings"]:
            lines.append(finding_line(x))
        if d["older_open"]:
            lines.append("")
            lines.append("open findings outside the current record (give each a status; older-head lines do not count toward the verdict, same-head copy lines do):")
            for x in d["older_open"]:
                lines.append(finding_line(x, f"older head {x['older_head'][:9]}" if x["older_head"]
                                          else "dropped copy at the current head; counts like a current finding"))
        rank = {"low": 0, "medium": 1, "high": 2, "blocker": 3}
        for i, g in enumerate(d["folded"], 1):
            top = max((m["severity"] for m in g["members"]), key=rank.get)
            nums = ", ".join(m["id"].split("-")[2] for m in g["members"])
            lines.append("")
            lines.append(f"#O-group-{g['head'][:9]}-{i} [{top}] older head {g['head'][:9]} ({g['path']}): "
                         f"{len(g['members'])} open lines whose numbers ({nums}) all reappear in the current record — OPEN "
                         f"(compare each member; record a differing member as its own line, then give the group N/A for the rest)")
            for m in g["members"]:
                lines.append("  member: " + finding_line(m, f"older head {m['older_head'][:9]}"))
        for n in d["notes"]:
            lines.append(f"note: {n}")
    for w in d["warnings"]:
        lines.append(f"WARNING: {w}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--branch")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    d = build(a.slug, a.key, a.branch)
    print(json.dumps(d, indent=1) if a.json else render(d))
    if d.get("locked") or d.get("incomplete"):
        return 4
    return 0 if d["found"] else 3


if __name__ == "__main__":
    sys.exit(main())
