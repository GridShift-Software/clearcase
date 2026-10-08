"""Build a disposable planning tree from the committed plan plus one graph fixture.

Usage: python3 make_tree.py REPO DEST FIXTURE.json
Copies the planning scripts and inputs into DEST, applies the fixture's edits,
regenerates the plan and writes DEST/readback.json when the fixture asks for one.
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


if fixture.get("patchAfterGenerate"):
    generate()
    patch()
else:
    patch()
    generate()

if "readback" in fixture:
    plan = json.loads(plan_path.read_text())
    items = {item["key"]: item for item in plan["items"]}
    milestones = {m["key"]: m["linear"] for m in plan["milestones"]}
    rows = {
        key: {
            "key": key,
            "id": item["linear"]["identifier"],
            "uuid": item["linear"]["id"],
            "milestone": {"id": milestones[item["milestone"]]["id"]},
            "blockedBy": [items[dep]["linear"]["identifier"] for dep in item["depends"]],
        }
        for key, item in items.items()
    }
    for target, value in fixture["readback"].items():
        key, field = target.split(".")
        rows[key][field] = value
    readback = {"readAt": "2026-01-01T00:00:00Z", "synthetic": True, "issues": list(rows.values())}
    (dest / "readback.json").write_text(json.dumps(readback, indent=2) + "\n")
