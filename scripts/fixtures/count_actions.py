#!/usr/bin/env python3
"""Recount the actions and form fields in docs/reference/view-checklist.md and check every declared count.

  python3 scripts/fixtures/count_actions.py [CHECKLIST] [--summary SUMMARY.json]

For each view section it counts the bullets under **Actions (N)** and **Form fields (N)** and checks N, the
summary table row and the totals line against them. With the committed summary (the default), it also checks
the table's handler-site and nav-site columns against `views.perView`. The counting rule itself is written in
the checklist. Prints one line per view and the totals; exit 0 when everything agrees, 1 otherwise.
"""
from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DEFAULT_CHECKLIST = os.path.join(REPO, "docs", "reference", "view-checklist.md")
DEFAULT_SUMMARY = os.path.join(REPO, "docs", "reference", "v5-summary.json")

_SECTION = re.compile(r"^## .*\(`([^`]+)`\)\s*$")
_SHELL = re.compile(r"^## Shared shell\b")
_LIST = re.compile(r"^- \*\*(Actions|Form fields) \((\d+)\):\*\*\s*$")
_ROW = re.compile(r"^\| *\d+ \| .*?\(`([^`]+)`\) \|")
_TOTALS = re.compile(r"^Totals: (\d+) actions and (\d+) form fields across the (\d+) views \((\d+) more actions "
                     r"in the shared shell\)")


def check(path: str, summary=None) -> dict:
    errors: list[str] = []
    views: dict[str, dict] = {}
    table: dict[str, list[str]] = {}
    totals = None
    current = kind = None
    for line in open(path, encoding="utf-8").read().split("\n"):
        if m := _ROW.match(line):
            table[m.group(1)] = [c.strip() for c in line.strip().strip("|").split("|")]
            continue
        if m := _TOTALS.match(line):
            totals = tuple(int(g) for g in m.groups())
            continue
        if (m := _SECTION.match(line)) or _SHELL.match(line):
            current = m.group(1) if m else "_shell"
            views[current] = {"Actions": [None, 0], "Form fields": [None, 0]}
            kind = None
            continue
        if line.startswith("## "):
            current = kind = None
            continue
        if current is None:
            continue
        if m := _LIST.match(line):
            kind = m.group(1)
            views[current][kind][0] = int(m.group(2))
        elif line.startswith("- "):
            kind = None
        elif kind and line.startswith("  - "):
            views[current][kind][1] += 1
    per_view = {}
    for vid, counts in views.items():
        for kind, (declared, bullets) in counts.items():
            if declared is None and kind == "Actions":
                errors.append(f"{vid}: no Actions list")
            elif declared is not None and declared != bullets:
                errors.append(f"{vid}: {kind} declares {declared} but lists {bullets}")
        per_view[vid] = {"actions": counts["Actions"][1], "fields": counts["Form fields"][1]}
    shell = per_view.pop("_shell", {"actions": 0, "fields": 0})
    head = None
    for vid, row in table.items():
        if vid not in per_view:
            errors.append(f"{vid}: in the summary table but has no section")
            continue
        head = head or row
        if (row[6], row[7]) != (str(per_view[vid]["actions"]), str(per_view[vid]["fields"])):
            errors.append(f"{vid}: summary table says {row[6]} actions and {row[7]} fields; the section lists "
                          f"{per_view[vid]['actions']} and {per_view[vid]['fields']}")
        if summary:
            s = summary["views"]["perView"].get(vid, {})
            if (row[8], row[9]) != (str(s.get("handlerSites")), str(s.get("navigationSites"))):
                errors.append(f"{vid}: handler/nav sites {row[8]}/{row[9]} differ from the summary "
                              f"{s.get('handlerSites')}/{s.get('navigationSites')}")
    for vid in per_view:
        if vid not in table:
            errors.append(f"{vid}: has a section but no summary table row")
    actions = sum(v["actions"] for v in per_view.values())
    fields = sum(v["fields"] for v in per_view.values())
    want = (actions, fields, len(per_view), shell["actions"])
    if totals != want:
        errors.append(f"totals line {totals} differs from the recount {want}")
    return {"errors": errors, "views": per_view, "actions": actions, "fields": fields, "shell": shell["actions"]}


def main(argv) -> int:
    args = list(argv)
    summary_path = DEFAULT_SUMMARY
    if "--summary" in args:
        i = args.index("--summary")
        summary_path = args[i + 1]
        del args[i:i + 2]
    path = args[0] if args else DEFAULT_CHECKLIST
    with open(summary_path, encoding="utf-8") as fh:
        summary = json.load(fh)
    result = check(path, summary)
    for vid, v in result["views"].items():
        print(f"{vid:22} actions {v['actions']:3} fields {v['fields']:3}")
    print(f"total: {result['actions']} actions and {result['fields']} form fields in {len(result['views'])} views; "
          f"{result['shell']} shell actions")
    for e in result["errors"]:
        print(f"FAIL  {e}")
    print("count-actions: " + ("PASS" if not result["errors"] else f"FAIL ({len(result['errors'])})"))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
