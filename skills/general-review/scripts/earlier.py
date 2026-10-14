#!/usr/bin/env python3
"""Build earlier.md, the earlier findings handed to the reviewer (references/ledger.md, EARLIER).

Usage:
  round 1:     python3 -I earlier.py --dir D --runner claude [--source REC ...] [--adapter-output OUT] --out earlier.md
  rounds 2+:   python3 -I earlier.py --dir D --runner claude --from-record PREV_RECORD --prev-earlier PREV_EARLIER --out earlier.md

Own part: for each source record (default D/<runner>.md when it exists), its path, state:,
base_sha:, every repro: path, imported_from:/source_runner: when present, and every finding
line exactly as recorded; then the old-ledger adapter's output verbatim when given.
With --from-record, the previous round's record.md is the only own source.

Then `other agents (read-only):` with one block per sibling record D/<other>.md: its path,
run_id:, state:, verdict: and finding lines. With --from-record, a sibling whose run_id equals
the one saved in --prev-earlier keeps its saved block unread; a changed or new sibling is read
again, so findings another agent published between rounds are imported.

Prints `none` when there is nothing. Read-only for the ledger: writes only --out.
"""
import argparse
import os
import re
import sys

FINDING = re.compile(r"^#[^#\s]\S*\s+\[[^\]]+\]\s")
OTHERS = "other agents (read-only):"
SIBLING_NAME = re.compile(r"^([a-z0-9_-]+)\.md$")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def field(text, name):
    m = re.search(rf"^{name}:\s*(.*)$", text, re.M)
    return m.group(1).strip() if m else None


def findings(text):
    return [line for line in text.splitlines() if FINDING.match(line)]


def own_block(path):
    text = read(path)
    lines = [f"source: {path}"]
    for name in ("state", "base_sha", "imported_from", "source_runner"):
        value = field(text, name)
        if value is not None:
            lines.append(f"{name}: {value}")
    lines += [line for line in text.splitlines() if line.startswith("repro:")]
    return lines + [""] + findings(text)


def sibling_block(path):
    text = read(path)
    lines = [f"sibling: {path}"]
    for name in ("run_id", "state", "verdict"):
        lines.append(f"{name}: {field(text, name) or 'none'}")
    return lines + findings(text)


def saved_siblings(prev_earlier):
    """{path: (run_id, block lines)} from the other-agents section of an earlier earlier.md."""
    text = read(prev_earlier)
    if OTHERS not in text:
        return {}
    blocks, current = {}, None
    for line in text.split(OTHERS, 1)[1].splitlines():
        if line.startswith("sibling: "):
            current = line[len("sibling: "):]
            blocks[current] = [line]
        elif current and line.strip():
            blocks[current].append(line)
    return {path: (field("\n".join(b), "run_id"), b) for path, b in blocks.items()}


def siblings(folder, runner, saved):
    out = []
    names = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
    for name in names:
        m = SIBLING_NAME.match(name)
        if not m or m.group(1) == runner:
            continue
        path = os.path.join(folder, name)
        kept = saved.get(path)
        if kept and kept[0] == field(read(path), "run_id"):
            out.append(kept[1])
        else:
            out.append(sibling_block(path))
    return out


def build(a):
    if a.from_record:
        sources, adapter = [a.from_record], None
        saved = saved_siblings(a.prev_earlier)
    else:
        own = os.path.join(a.dir, f"{a.runner}.md")
        sources = a.source or ([own] if os.path.exists(own) else [])
        adapter, saved = a.adapter_output, {}
    parts = [own_block(p) for p in sources]
    if adapter:
        parts.append(read(adapter).rstrip("\n").splitlines())
    others = siblings(a.dir, a.runner, saved)
    if others:
        parts.append([OTHERS] + [line for block in others for line in block + [""]][:-1])
    if not parts:
        return "none\n"
    return "\n\n".join("\n".join(p) for p in parts) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--runner", required=True)
    ap.add_argument("--source", action="append")
    ap.add_argument("--adapter-output")
    ap.add_argument("--from-record")
    ap.add_argument("--prev-earlier")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if bool(a.from_record) != bool(a.prev_earlier):
        sys.stderr.write("--from-record and --prev-earlier go together\n")
        return 2
    if a.from_record and (a.source or a.adapter_output):
        sys.stderr.write("--from-record replaces --source and --adapter-output\n")
        return 2
    text = build(a)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
