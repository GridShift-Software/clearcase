#!/usr/bin/env python3
"""Fail when a file tracked by Git contains case material from the local v5 fixture.

  python3 scripts/fixtures/leak_check.py                    scan `git ls-files` of the current checkout
  python3 scripts/fixtures/leak_check.py FILE...            scan the given files
  python3 scripts/fixtures/leak_check.py --range BASE..HEAD scan every blob added by every commit in the range

The needles come from the fixture itself (read locally, never printed in full): archive paths and file
names, chronology filenames, subjects and senders, people and entity names and e-mail addresses, matter
titles, bundle header defaults and quantum amounts. Dates are compared separately: every date written in a
scanned file (see v5fixture/redact.py for the forms) must not equal any date in the fixture's datasets or
archive names, except the build date and the fixed test clock. A hit prints the file, line and a hash of the
value, not the value. String matching cannot see paraphrase; committed prose still needs a human read.
Exit 0 clean, 1 hit, 2 fixture missing.
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from v5fixture import archive, build, examples, redact  # noqa: E402

DEFAULT_ROOT = "/home/vaper/Work/Active/MX-two/ClearCase/fixtures"
# Generic words that also occur in field names, UI labels or this repository's own prose.
ALLOW = {"correspondence", "supplementary", "original", "pleadings", "additional", "invoice", "statement",
         "affidavit", "schedule", "settlement", "agreement", "contract", "discovery", "arbitration", "documents",
         "outstanding documents", "court bundles", "original discovery", "attachment", "workspace",
         "defendant", "claimant", "extracts", "start here", "counsel", "plaintiff", "in the matter between:",
         # the main HTML's name, committed by the planning documents
         "ess_dcs_workspace"}


def _workspace(src):
    main = next(p for p in ("ESS_DCS_Workspace.html",) if p in {e.path for e in src.entries})
    return build.analyse_html(src.read(main), main)[0]


def case_dates(tree: str) -> set[str]:
    """Every date in any string of the main HTML's datasets or in any archive path, as ISO dates."""
    src = archive.TreeSource(tree, crc=False)
    ws = _workspace(src)
    out: set[str] = set()
    for e in src.entries:
        out |= redact.iso_dates(e.path)
    for name, value in ws.datasets.items():
        for _path, _key, v, _parent in build.walk(value, name):
            if isinstance(v, str):
                out |= redact.iso_dates(v)
    return out - redact.ALLOWED_DATES


def needles(tree: str) -> set[str]:
    src = archive.TreeSource(tree, crc=False)
    out: set[str] = set()
    for e in src.entries:
        for part in e.path.split("/"):
            out.add(re.sub(r"\.[A-Za-z0-9]{1,5}$", "", part))
    ws = _workspace(src)
    d = ws.data
    for r in d.get("chronology", []):
        for k in ("filename", "subject", "sender", "to", "cc"):
            out.add(re.sub(r"\.[A-Za-z0-9]{1,5}$", "", str(r.get(k) or "")))
    for p in d.get("people", []):
        out.update(str(p.get(k) or "") for k in ("name", "email", "org"))
    for e in d.get("entities", []):
        out.add(str(e.get("name") or ""))
    for w in d.get("witnesses", []):
        out.add(str(w.get("name") or ""))
    m = d.get("matter", {})
    out.update(str(m.get(k) or "") for k in ("title", "short", "forum"))
    out.update(str(v) for v in (d.get("bundles", {}).get("headerDefaults") or {}).values())
    q = d.get("quantum", {})
    for k in ("headline_due", "grossInvoiced"):
        try:
            out.add(examples.fmt_r(float(q.get(k))).replace("R ", ""))
        except (TypeError, ValueError):
            pass
    out.add(str(ws.meta.get("dataFolderName") or ""))
    result = set()
    for n in out:
        for piece in re.split(r"\s*[|;]\s*", n.strip()):
            piece = piece.strip(" ().,-_")
            if len(piece) >= 7 and piece.lower() not in ALLOW and not re.fullmatch(r"[\d\s.,/-]+", piece) or \
                    re.fullmatch(r"\d{1,3}( \d{3}){2,}\.\d{2}", piece):
                result.add(piece.lower())
    return result


def _git(*args) -> bytes:
    return subprocess.run(["git", *args], capture_output=True, check=True).stdout


def range_blobs(spec: str):
    """Yield (label, path, text) for every blob added or changed, and every message, in BASE..HEAD."""
    seen = set()
    for commit in _git("rev-list", "--reverse", spec).decode().split():
        names = _git("diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", commit).decode().split("\0")
        for path in filter(None, names):
            if subprocess.run(["git", "cat-file", "-e", f"{commit}:{path}"], capture_output=True).returncode:
                continue
            blob = _git("rev-parse", f"{commit}:{path}").decode().strip()
            if blob not in seen:
                seen.add(blob)
                yield f"{path}@{commit[:10]}", path, _git("cat-file", "-p", blob).decode("utf-8", "replace")
        yield f"(message)@{commit[:10]}", "", _git("log", "-1", "--format=%B", commit).decode("utf-8", "replace")


def scan(label: str, text: str, pattern, dates: set[str]) -> int:
    hits = 0
    low = text.lower()
    for m in pattern.finditer(low):
        line = low.count("\n", 0, m.start()) + 1
        print(f"HIT {label}:{line} needle sha256 {hashlib.sha256(m.group(0).encode()).hexdigest()[:12]} (len {len(m.group(0))})")
        hits += 1
    for start, _end, isos in redact.find_dates(text):
        for iso in sorted(isos & dates):
            line = text.count("\n", 0, start) + 1
            print(f"HIT {label}:{line} case date sha256 {hashlib.sha256(iso.encode()).hexdigest()[:12]}")
            hits += 1
    return hits


def main(argv) -> int:
    root = os.environ.get("CLEARCASE_FIXTURE_ROOT", DEFAULT_ROOT)
    tree = os.path.join(root, "v5-002", "tree")
    if not os.path.isdir(tree):
        print(f"fixture tree not found: {tree}", file=sys.stderr)
        return 2
    ns = sorted(needles(tree), key=len, reverse=True)
    pattern = re.compile("|".join(re.escape(n) for n in ns))
    dates = case_dates(tree)
    hits = files = 0
    if argv[:1] == ["--range"]:
        for label, path, text in range_blobs(argv[1]):
            files += 1
            hits += scan(label, path.lower() + "\n" + text, pattern, dates) if path else scan(label, text, pattern, dates)
    else:
        names = argv or _git("ls-files", "-z").decode().split("\0")
        for f in (f for f in names if f and os.path.isfile(f)):
            try:
                text = open(f, encoding="utf-8").read()
            except (UnicodeDecodeError, OSError):
                continue
            files += 1
            hits += scan(f, text, pattern, dates)
    print(f"leak check: {files} files, {len(ns)} needles, {len(dates)} case dates, {hits} hits")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
