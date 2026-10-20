"""Build a disposable planning tree from the committed plan plus one graph fixture.

Usage: python3 make_tree.py REPO DEST FIXTURE.json
Copies the planning scripts and inputs into DEST, applies the fixture's edits
(set, append and delete on items; snapshot fields; view fields; editsBefore text replacements in any copied file),
regenerates the plan, applies editsAfter text replacements to the generated output, and writes
DEST/readback.json when the fixture asks for one (readback edits rows; readbackDropOwners omits created owners).
The readback is synthetic: it is derived from the plan and padded with closed
issues so that the counts recorded in the snapshot hold.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

repo, dest, fixture_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
fixture = json.loads(fixture_path.read_text())
for rel in [*(str(path.relative_to(repo)) for path in sorted((repo / "scripts/planning").glob("*.py"))),
            "docs/plan/work-items.json", "docs/plan/view-coverage.json", "docs/plan/program-intro.md"]:
    (dest / rel).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(repo / rel, dest / rel)
plan_path = dest / "docs/plan/work-items.json"
coverage_path = dest / "docs/plan/view-coverage.json"


def generate():
    subprocess.run([sys.executable, str(dest / "scripts/planning/generate.py")], check=True, stdout=subprocess.DEVNULL)


def edit(key):
    """Apply the fixture's [old, new] replacements for each file; an old text that is absent fails the build."""
    for rel, pairs in fixture.get(key, {}).items():
        path = dest / rel
        text = path.read_text()
        for old, new in pairs:
            if old not in text:
                raise SystemExit(f"{key}: {rel} does not contain {old!r}")
            text = text.replace(old, new, 1)
        path.write_text(text)


def patch():
    plan = json.loads(plan_path.read_text())
    items = {item["key"]: item for item in plan["items"]}
    for target, value in fixture.get("set", {}).items():
        key, field = target.split(".")
        items[key][field] = value
    for target, value in fixture.get("append", {}).items():
        key, field = target.split(".")
        items[key][field].append(value)
    for target in fixture.get("delete", []):
        key, field = target.split(".")
        del items[key][field]
    plan["snapshot"].update(fixture.get("snapshot", {}))
    plan_path.write_text(json.dumps(plan, indent=2) + "\n")
    coverage = json.loads(coverage_path.read_text())
    views = {view["id"]: view for view in coverage["views"]}
    for target, value in fixture.get("views", {}).items():
        view, field = target.split(".")
        views[view][field] = value
    coverage_path.write_text(json.dumps(coverage, indent=2) + "\n")


edit("editsBefore")
if fixture.get("patchAfterGenerate"):
    generate()
    patch()
else:
    patch()
    generate()
edit("editsAfter")

if "readback" in fixture:
    plan = json.loads(plan_path.read_text())
    items = {item["key"]: item for item in plan["items"]}
    snapshot = plan["snapshot"]
    parents = {child: items[key]["linear"]["identifier"] for key, item in items.items() for child in item.get("children", [])}
    milestones = {m["key"]: {"id": m["linear"]["id"], "name": m["name"]} for m in plan["milestones"]}
    rows = {}
    for key, item in items.items():
        link = item["linear"]
        rows[key] = {"id": link["identifier"], "uuid": link["id"], "url": link["url"], "title": item["title"],
                     "status": item["status"], "parentId": parents.get(key), "projectMilestone": milestones[item["milestone"]],
                     "blockedBy": item.get("nativeBlockedBy", []), "description": item.get("linearDescription", "")}
    for row in snapshot["readback"]["openOutsidePlan"]:
        rows[row["identifier"]] = {"id": row["identifier"], "status": row["status"], "parentId": None, "blockedBy": [],
                                   "projectMilestone": None, "description": "", "title": row["title"]}
    for identifier, status in snapshot["externalSources"].items():
        rows[identifier] = {"id": identifier, "status": status, "parentId": None, "projectMilestone": None}
    for target, value in fixture["readback"].items():
        key, field = target.split(".")
        rows[key][field] = value
    counts = dict(snapshot["readback"]["statusCounts"])
    for row in rows.values():
        counts[row["status"]] = counts.get(row["status"], 0) - 1
    # Only closed issues are padded, so a status moved by a fixture shows up as a count mismatch, not as a synthetic open issue.
    filler = [{"id": f"SYN-{status[:2].upper()}-{n}", "status": status, "parentId": None, "projectMilestone": None}
              for status, missing in counts.items() if status in {"Done", "Canceled", "Duplicate"} for n in range(max(missing, 0))]
    live = list(rows.values()) + filler
    graph = {row["id"]: {"description": row["description"], "status": row["status"],
                         "relations": {"blockedBy": [{"id": b} for b in row["blockedBy"]]}}
             for row in live if row["status"] not in {"Done", "Canceled", "Duplicate"}}
    issues = [{"linear": {"id": items[key]["linear"]["identifier"]}} for key in snapshot["hostedDeliveryOwners"]
              if key not in fixture.get("readbackDropOwners", [])]
    readback = {"synthetic": True, "issues": issues, "liveIssues": live, "liveGraph": graph}
    (dest / "readback.json").write_text(json.dumps(readback, indent=2) + "\n")
