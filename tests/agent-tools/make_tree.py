"""Build a disposable planning tree from the committed plan plus one graph fixture.

Usage: python3 make_tree.py REPO DEST FIXTURE.json
Copies the planning scripts and inputs into DEST, applies the fixture's edits,
regenerates the plan and writes DEST/readback.json when the fixture asks for one.
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
for rel in ["scripts/planning/check.py", "scripts/planning/generate.py", "docs/plan/work-items.json",
            "docs/plan/view-coverage.json", "docs/plan/program-intro.md"]:
    (dest / rel).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(repo / rel, dest / rel)
plan_path = dest / "docs/plan/work-items.json"
coverage_path = dest / "docs/plan/view-coverage.json"


def generate():
    subprocess.run([sys.executable, str(dest / "scripts/planning/generate.py")], check=True, stdout=subprocess.DEVNULL)


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
    plan_path.write_text(json.dumps(plan, indent=2) + "\n")
    coverage = json.loads(coverage_path.read_text())
    views = {view["id"]: view for view in coverage["views"]}
    for target, value in fixture.get("views", {}).items():
        view, field = target.split(".")
        views[view][field] = value
    coverage_path.write_text(json.dumps(coverage, indent=2) + "\n")


if fixture.get("patchAfterGenerate"):
    generate()
    patch()
else:
    patch()
    generate()

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
    filler = [{"id": f"SYN-{status[:2].upper()}-{n}", "status": status, "parentId": None, "projectMilestone": None}
              for status, missing in counts.items() for n in range(max(missing, 0))]
    live = list(rows.values()) + filler
    graph = {row["id"]: {"description": row["description"], "status": row["status"],
                         "relations": {"blockedBy": [{"id": b} for b in row["blockedBy"]]}}
             for row in live if row["status"] not in {"Done", "Canceled", "Duplicate"}}
    issues = [{"linear": {"id": items[key]["linear"]["identifier"]}} for key in snapshot["hostedDeliveryOwners"]]
    readback = {"synthetic": True, "issues": issues, "liveIssues": live, "liveGraph": graph}
    (dest / "readback.json").write_text(json.dumps(readback, indent=2) + "\n")
