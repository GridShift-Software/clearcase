import argparse
import json
import subprocess
import sys
from collections import Counter
from fnmatch import fnmatchcase
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Bump only together with a reconciled Linear readback.
EXPECTED_ISSUES = 30
parser = argparse.ArgumentParser()
parser.add_argument("--require-linear-ids", action="store_true")
parser.add_argument("--linear-relations", type=Path)
args = parser.parse_args()
plan = json.loads((ROOT / "docs/plan/work-items.json").read_text())
coverage = json.loads((ROOT / "docs/plan/view-coverage.json").read_text())
items = {item["key"]: item for item in plan["items"]}
errors = []

if len(items) != len(plan["items"]):
    errors.append("Duplicate planning keys")
milestones = {m["key"] for m in plan["milestones"]}
for key, item in items.items():
    if item["milestone"] not in milestones:
        errors.append(f"{key}: unknown milestone")
    for dep in item["depends"]:
        if dep not in items:
            errors.append(f"{key}: missing dependency {dep}")
        elif item["phase"] == "V1" and items[dep]["phase"] != "V1":
            errors.append(f"{key}: V1 depends on later work {dep}")
    if len(item["acceptance"]) < 3 or not item["scope"] or not item["outcome"]:
        errors.append(f"{key}: incomplete brief")
    if item["liveScenarios"] and len(item["liveScenarios"]) != 10:
        errors.append(f"{key}: expected ten explicit live scenarios")

visited, active = set(), set()


def visit(key):
    if key in active:
        errors.append(f"Dependency cycle at {key}")
        return
    if key in visited or key not in items:
        return
    active.add(key)
    for dep in items[key]["depends"]:
        visit(dep)
    active.remove(key)
    visited.add(key)


for key in items:
    visit(key)


def ancestors(key, seen=None):
    seen = set() if seen is None else seen
    for dep in items[key]["depends"]:
        if dep in items and dep not in seen:
            seen.add(dep)
            ancestors(dep, seen)
    return seen


def scopes_overlap(left, right):
    if fnmatchcase(left, right) or fnmatchcase(right, left):
        return True
    # The plan uses exact paths, trailing .* patterns and directory /** scopes.
    a, b = left.split("*")[0], right.split("*")[0]
    return a.startswith(b) or b.startswith(a)


for a, b in combinations(items, 2):
    if a in ancestors(b) or b in ancestors(a):
        continue
    for left in items[a]["scope"]:
        for right in items[b]["scope"]:
            if scopes_overlap(left, right):
                errors.append(f"Concurrent scopes overlap: {a} {left}; {b} {right}")
for key, item in items.items():
    if item["liveScenarios"] and key != "CC-01":
        test_path = item.get("testPath")
        if not test_path or not any(
            fnmatchcase(test_path + "/example.test.ts", scope)
            for scope in item["scope"] if scope.startswith("tests/")
        ):
            errors.append(f"{key}: verification testPath is outside the write scope")
views = coverage["views"]
counts = Counter(v["id"] for v in views)
if len(views) != 42 or len(counts) != 42 or coverage["documentCount"] != 1689:
    errors.append("The v5 baseline must own exactly 42 unique views and 1,689 documents")
for view in views:
    if view["owner"] not in items or items[view["owner"]]["phase"] != "V1":
        errors.append(f"{view['id']}: missing V1 owner")
for key in ["CC-23", "CC-24", "CC-11", "CC-25", "CC-26", "CC-20"]:
    if items[key]["kind"] != "gate":
        errors.append(f"{key}: missing independent gate")
if items["CC-03"]["depends"] != ["CC-23"]:
    errors.append("Pilot must wait for the package gate")
if items["CC-28"]["depends"] != ["CC-26"] or items["CC-16"]["depends"] != ["CC-28"]:
    errors.append("Hosted intake must wait for the hosted foundation, which waits for the design gate")
if items["CC-01"]["depends"] != ["CC-27"]:
    errors.append("The v5 baseline must wait for the agent tooling setup")
if len(items) != EXPECTED_ISSUES:
    errors.append(f"Expected {EXPECTED_ISSUES} planning issues, found {len(items)}")
linked = [item["linear"]["id"] for item in items.values() if item.get("linear")]
if len(linked) != len(set(linked)):
    errors.append("A Linear issue maps to multiple planning keys")
if args.require_linear_ids or args.linear_relations:
    if len(linked) != len(items):
        errors.append("Missing Linear issue mappings")
    if any(not m.get("linear") for m in plan["milestones"]):
        errors.append("Missing Linear milestone mappings")
if args.linear_relations:
    snapshot = json.loads(args.linear_relations.read_text())
    live = {row["key"]: row for row in snapshot["issues"]}
    milestone_by_key = {m["key"]: m for m in plan["milestones"]}
    if set(live) != set(items) or len(live) != len(snapshot["issues"]):
        errors.append("Live snapshot keys do not match the plan")
    for key, item in items.items():
        row = live.get(key, {})
        expected = {items[dep]["linear"]["identifier"] for dep in item["depends"]}
        if set(row.get("blockedBy", [])) != expected:
            errors.append(f"{key}: live blocking relations differ")
        if row.get("uuid") != item.get("linear", {}).get("id"):
            errors.append(f"{key}: live issue identity differs")
        if row.get("milestone", {}).get("id") != milestone_by_key[item["milestone"]].get("linear", {}).get("id"):
            errors.append(f"{key}: live milestone differs")
    print(f"Compared Linear snapshot read at {snapshot.get('readAt', 'unknown time')}; this command does not fetch live data.")
if errors:
    raise SystemExit("\n".join(errors))
subprocess.run([sys.executable, str(ROOT / "scripts/planning/generate.py"), "--check"], check=True)
print(f"PASS: {len(items)} issues, {len(milestones)} milestones, 42 unique owned views, acyclic dependencies, six independent gates, disjoint concurrent scopes, owned test paths, {len(linked)} Linear mappings.")
