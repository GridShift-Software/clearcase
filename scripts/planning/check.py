"""Validate the planning snapshot in docs/plan against itself, a Linear readback and the generated documents."""
import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from functools import lru_cache
from itertools import combinations
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# The v5 baseline and its independent gates are fixed history; bump only with a reconciled readback.
VIEW_COUNT, DOCUMENT_COUNT = 42, 1689
GATES = ["CC-23", "CC-24", "CC-11", "CC-25", "CC-26", "CC-20"]
ROLES = {"writer", "map", "decision", "aggregate"}
CLOSED = {"Done", "Canceled", "Duplicate"}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PATH = re.compile(r"^([\w.\-\[\]{},*/+@]+)(?:\s+(.*))?$")
TEST_FILE = re.compile(r"\.(?:test|spec)\.[cm]?[jt]sx?$")


def scope_path(entry):
    """Return (glob, note) for a reserved path, or None for a prose reservation."""
    match = PATH.match(entry)
    if not match or not re.search(r"/|\.\w+$|\.\*$", match.group(1)):
        return None
    return match.group(1), match.group(2) or ""


def is_test_path(glob):
    """A reserved test: anything under tests/, or one named colocated *.test.* / *.spec.* JS or TS file.

    A wildcard stem (src/**/*.test.ts) would claim every test beside it, so it is not a test reservation. The
    reservation names a place for the test; it does not prove that a runner collects it.
    """
    def named(path):
        stem = TEST_FILE.sub("", path.rsplit("/", 1)[-1]) if TEST_FILE.search(path) else ""
        return bool(stem.strip("*"))
    return glob.startswith("tests/") or all(named(path) for path in expand(glob))


def expand(glob):
    match = re.search(r"\{([^}]*)\}", glob)
    if not match:
        return [glob]
    return [path for alt in match.group(1).split(",")
            for path in expand(glob[:match.start()] + alt + glob[match.end():])]


def segments_meet(a, b):
    """Segments are literal except '*', so SvelteKit's [vid] stays literal (fnmatch would read a class)."""
    def literal(pattern, text):
        return re.fullmatch("[^/]*".join(map(re.escape, pattern.split("*"))), text) is not None
    if "*" in a and "*" in b:
        (ap, *_, asuf), (bp, *_, bsuf) = a.split("*"), b.split("*")
        return (ap.startswith(bp) or bp.startswith(ap)) and (asuf.endswith(bsuf) or bsuf.endswith(asuf))
    if "*" in a:
        return literal(a, b)
    if "*" in b:
        return literal(b, a)
    return a == b


def globs_meet(left, right):
    a, b = left.split("/"), right.split("/")

    @lru_cache(maxsize=None)
    def go(i, j):
        if i == len(a) and j == len(b):
            return True
        if i < len(a) and a[i] == "**":
            return go(i + 1, j) or (j < len(b) and go(i, j + 1))
        if j < len(b) and b[j] == "**":
            return go(i, j + 1) or (i < len(a) and go(i + 1, j))
        return i < len(a) and j < len(b) and segments_meet(a[i], b[j]) and go(i + 1, j + 1)
    return go(0, 0)


def excluded(glob, note, other):
    """'dir/** except name' leaves dir/name/** to another owner."""
    match = re.match(r"except (\S+)", note)
    if not match or not glob.endswith("/**"):
        return False
    carved = f"{glob[:-3]}/{match.group(1)}"
    return other == carved or other.startswith(carved + "/")


def scopes_overlap(left, right):
    (lg, ln), (rg, rn) = left, right
    return any(globs_meet(x, y) and not excluded(lg, ln, y) and not excluded(rg, rn, x)
               for x in expand(lg) for y in expand(rg))


def load(root):
    plan = json.loads((root / "docs/plan/work-items.json").read_text())
    coverage = json.loads((root / "docs/plan/view-coverage.json").read_text())
    return plan, coverage


def validate(plan, coverage):
    """Return the list of errors for an offline plan; no live data is read."""
    errors = []
    err = errors.append
    items = {item["key"]: item for item in plan["items"]}
    if len(items) != len(plan["items"]):
        err("Duplicate planning keys")
    snapshot = plan["snapshot"]
    milestones = {m["key"]: m for m in plan["milestones"]}
    by_id = {item.get("linear", {}).get("identifier"): key for key, item in items.items()}
    is_open = {key: item["status"] not in CLOSED for key, item in items.items()}
    gate_key = by_id.get(snapshot["planningGate"])

    # Identity: every item and milestone maps to exactly one Linear object.
    identifiers = [item.get("linear", {}).get("identifier") for item in items.values()]
    uuids = [item.get("linear", {}).get("id") for item in items.values()]
    for key, item in items.items():
        link = item.get("linear") or {}
        if not UUID.fullmatch(link.get("id") or "") or not re.fullmatch(r"GRS-\d+", link.get("identifier") or ""):
            err(f"{key}: missing Linear issue mapping")
        elif f"/issue/{link['identifier']}/" not in link.get("url", ""):
            err(f"{key}: Linear URL does not name {link['identifier']}")
    if len(set(uuids)) != len(uuids) or len(set(identifiers)) != len(identifiers):
        err("A Linear issue maps to multiple planning keys")
    for milestone in milestones.values():
        if not UUID.fullmatch((milestone.get("linear") or {}).get("id") or ""):
            err(f"{milestone['key']}: missing Linear milestone mapping")

    # Graph: known dependencies, no cycles, phases follow their milestone.
    for key, item in items.items():
        milestone = milestones.get(item["milestone"])
        if not milestone:
            err(f"{key}: unknown milestone")
        elif item["phase"] != milestone["phase"]:
            err(f"{key}: phase {item['phase']} does not match {item['milestone']} ({milestone['phase']})")
        if item.get("role") not in ROLES:
            err(f"{key}: role must be one of {', '.join(sorted(ROLES))}")
        for dep in item["depends"]:
            if dep not in items:
                err(f"{key}: missing dependency {dep}")
            elif item["phase"] == "V1" and items[dep]["phase"] != "V1":
                err(f"{key}: V1 depends on later work {dep}")
            elif not is_open[key] and is_open[dep]:
                err(f"{key}: closed but its dependency {dep} is open")
    state, broken = {}, any(dep not in items for item in items.values() for dep in item["depends"])

    def visit(key):
        nonlocal broken
        if state.get(key) == "active":
            err(f"Dependency cycle at {key}")
            broken = True
        if key in state or key not in items:
            return
        state[key] = "active"
        for dep in items[key]["depends"]:
            visit(dep)
        state[key] = "done"
    for key in items:
        visit(key)
    if broken:
        return errors

    @lru_cache(maxsize=None)
    def ancestors(key):
        return frozenset(items[key]["depends"]).union(*(ancestors(dep) for dep in items[key]["depends"]))

    # Native blockers: in-plan blockers are dependencies; everything else is a recorded external source.
    sources = snapshot.get("externalSources", {})
    outside = {row["identifier"]: row for row in snapshot["readback"]["openOutsidePlan"]}
    for key, item in items.items():
        if not is_open[key]:
            continue
        external = item.get("externalPrerequisites", [])
        expected = {items[dep]["linear"]["identifier"] for dep in item["depends"]} | set(external)
        if "nativeBlockedBy" not in item or set(item["nativeBlockedBy"]) != expected:
            err(f"{key}: native blockers differ from dependencies plus external prerequisites")
        for source in external:
            if source in by_id:
                err(f"{key}: external prerequisite {source} is a plan item; record it as a dependency")
            elif source not in sources:
                err(f"{key}: external prerequisite {source} has no recorded status")
            elif sources[source] not in CLOSED and source not in outside:
                err(f"{key}: open external prerequisite {source} is not listed as open outside the plan")
        if not item.get("linearDescription"):
            err(f"{key}: open item has no Linear description snapshot")

    # Roles: non-writing records, aggregates and writers each carry what their role needs.
    for key, item in items.items():
        role = item.get("role")
        paths = [p for p in map(scope_path, item["scope"]) if p]
        for child in item.get("children", []):
            if child not in items:
                err(f"{key}: unknown child {child}")
            elif key in items[child]["depends"]:
                err(f"{key}: child {child} depends on its parent")
            elif role == "aggregate" and child not in item["depends"]:
                err(f"{key}: aggregate does not depend on its child {child}")
        if role in {"map", "decision"}:
            if item["scope"] or not is_open[key]:
                err(f"{key}: a {role} record is open and writes nothing")
        elif role == "aggregate":
            if not item.get("children") or not item["acceptance"] or not item["outcome"]:
                err(f"{key}: aggregate needs children, outcome and acceptance")
            if any(not glob.startswith("docs/") and not is_test_path(glob) for glob, _ in paths):
                err(f"{key}: aggregate reserves implementation paths")
        elif role == "writer" and is_open[key]:
            if len(item["acceptance"]) < 3 or not item["outcome"]:
                err(f"{key}: incomplete brief")
            if item["kind"] == "future":
                if not item["scope"]:
                    err(f"{key}: future work names no scope owner")
            elif not paths:
                err(f"{key}: no concrete write path")
            code = [g for g, _ in paths if not g.startswith("docs/") and not is_test_path(g)]
            if code and item["phase"] != "Later" and not any(is_test_path(g) for g, _ in paths):
                err(f"{key}: no test path in write scope")
        if item["liveScenarios"] and len(item["liveScenarios"]) != 10:
            err(f"{key}: expected ten explicit live scenarios")
        if item["liveScenarios"] and key != "CC-01":
            test_path = item.get("testPath")
            if not test_path or not any(globs_meet(test_path + "/example.test.ts", glob)
                                        for glob, _ in paths if glob.startswith("tests/")):
                err(f"{key}: verification testPath is outside the write scope")

    # Concurrent writers: an overlap needs a native edge ordering the two owners.
    active = [k for k in items if is_open[k] and items[k].get("role") in {"writer", "aggregate"}]
    for a, b in combinations(active, 2):
        if a in ancestors(b) or b in ancestors(a):
            continue
        for left in filter(None, map(scope_path, items[a]["scope"])):
            for right in filter(None, map(scope_path, items[b]["scope"])):
                if scopes_overlap(left, right):
                    err(f"Concurrent scopes overlap: {a} {left[0]}; {b} {right[0]}")

    # Gates and their wiring.
    for key in GATES:
        if key not in items or items[key]["kind"] != "gate":
            err(f"{key}: missing independent gate")
    wiring = [
        (items["CC-01"]["depends"] == ["CC-27"], "The v5 baseline must wait for the agent tooling setup"),
        (items["CC-03"]["depends"] == ["CC-23"], "Pilot must wait for the package gate"),
        (all("CC-24" in items[k]["depends"] for k in ["CC-04", "CC-05", "CC-06", "CC-07", "CC-08", "CC-09", "CC-10"]),
         "Feature fan-out must wait for the pilot gate"),
        ("CC-26" in items["CC-28"]["depends"] and "CC-28" in items["CC-16"]["depends"],
         "Hosted intake must wait for the hosted foundation, which waits for the design gate"),
        ("CC-15" in items["CC-26"]["depends"], "The design gate must wait for the architecture proofs"),
        (all("CC-25" in ancestors(child) for child in items["CC-15"].get("children", [])),
         "Hosted proofs must wait for the export compatibility gate"),
    ]
    errors += [message for ok, message in wiring if not ok]
    if not gate_key or items[gate_key].get("role") != "map" or not is_open[gate_key]:
        err(f"Planning gate {snapshot['planningGate']} must be an open map item")
    release = ancestors("CC-20")
    for key, item in items.items():
        if not is_open[key] or item["phase"] != "V2" or item.get("role") not in {"writer", "aggregate"}:
            continue
        if gate_key not in item["depends"]:
            err(f"{key}: hosted work is not natively blocked by the planning gate")
        if item["milestone"] == "M5" and key != "CC-20" and key not in release:
            err(f"CC-20: release gate does not reach {key}")

    # The 32 hosted delivery owners stay bounded Backlog briefs behind the planning gate.
    owners = snapshot["hostedDeliveryOwners"]
    if len(set(owners)) != len(owners):
        err("Duplicate hosted delivery owners")
    for key in owners:
        item = items.get(key)
        if not item:
            err(f"{key}: unknown hosted delivery owner")
        elif (item.get("role") != "writer" or item["status"] != "Backlog" or item["phase"] != "V2"
              or not item.get("verification") or gate_key not in item["depends"]):
            err(f"{key}: hosted delivery owner must be a gated Backlog writer with verification")

    # Views: the frozen v5 baseline keeps its historical owner and gains one hosted owner.
    views = coverage["views"]
    if len(views) != VIEW_COUNT or len({v["id"] for v in views}) != VIEW_COUNT or coverage["documentCount"] != DOCUMENT_COUNT:
        err(f"The v5 baseline must own exactly {VIEW_COUNT} unique views and {DOCUMENT_COUNT:,} documents")
    hosted = coverage.get("hostedOwnership", {})
    acceptance = hosted.get("acceptanceOwner")
    if hosted.get("planningGate") != snapshot["planningGate"] or acceptance not in items:
        err("Hosted view ownership must name the planning gate and an acceptance owner")
    for view in views:
        owner, hosted_owner = items.get(view["owner"]), view.get("hostedOwner")
        if not owner or owner["phase"] != "V1" or is_open[view["owner"]]:
            err(f"{view['id']}: missing accepted V1 owner")
        if hosted_owner not in owners or hosted_owner not in items:
            err(f"{view['id']}: unknown hosted owner {hosted_owner}")
        elif items[hosted_owner]["milestone"] != "M5" or (acceptance in items and hosted_owner not in ancestors(acceptance)):
            err(f"{view['id']}: hosted owner {hosted_owner} is not an M5 owner accepted by {acceptance}")
    for store, owner in coverage.get("storeOwners", {}).items():
        if owner not in items:
            err(f"{store}: unknown store owner {owner}")

    # Counts recorded from the readback must agree with the plan.
    readback = snapshot["readback"]
    statuses = readback["statusCounts"]
    plan_status = Counter(item["status"] for item in items.values())
    if sum(statuses.values()) != readback["projectIssues"]:
        err("Readback status counts do not sum to the project issue count")
    for status, count in plan_status.items():
        if count > statuses.get(status, 0):
            err(f"Plan has {count} {status} items; the readback has {statuses.get(status, 0)}")
    open_plan = sum(is_open.values())
    if open_plan + len(outside) != readback["openIssues"]:
        err(f"{open_plan} open plan items and {len(outside)} open outside the plan do not make {readback['openIssues']} open issues")
    if set(outside) & set(by_id):
        err("An issue is listed both in the plan and outside it")
    return errors


def compare_readback(plan, readback_path):
    """Compare the plan with a coordinator readback: liveIssues (all project issues) and liveGraph (open issues)."""
    errors = []
    err = errors.append
    data = json.loads(Path(readback_path).read_text())
    if "liveIssues" not in data or "liveGraph" not in data:
        return [f"{readback_path}: readback lacks liveIssues and liveGraph; this check needs the full project readback"]
    live, graph = {row["id"]: row for row in data["liveIssues"]}, data["liveGraph"]
    items = {item["key"]: item for item in plan["items"]}
    by_id = {item["linear"]["identifier"]: item for item in plan["items"]}
    snapshot = plan["snapshot"]
    recorded = snapshot["readback"]
    milestone_ids = {m["linear"]["id"]: m["key"] for m in plan["milestones"]}
    open_ids = {i for i, row in live.items() if row["status"] not in CLOSED}
    if len(live) != recorded["projectIssues"] or dict(Counter(r["status"] for r in live.values())) != recorded["statusCounts"]:
        err("Recorded project issue and status counts differ from the readback")
    if set(graph) != open_ids:
        err("liveGraph does not hold exactly the open project issues")
    outside = {row["identifier"]: row for row in recorded["openOutsidePlan"]}
    if open_ids - set(by_id) != set(outside):
        err(f"Open issues outside the plan differ: readback {sorted(open_ids - set(by_id))}, recorded {sorted(outside)}")
    for identifier, row in outside.items():
        if identifier in live and live[identifier]["status"] != row["status"]:
            err(f"{identifier}: recorded status {row['status']} differs from {live[identifier]['status']}")
    for identifier, item in by_id.items():
        key, row = item["key"], live.get(identifier)
        if not row:
            err(f"{key}: {identifier} is not in the readback")
            continue
        if row["uuid"] != item["linear"]["id"] or row["url"] != item["linear"]["url"]:
            err(f"{key}: live issue identity differs")
        if row["title"] != item["title"]:
            err(f"{key}: live title differs")
        if row["status"] != item["status"]:
            err(f"{key}: live status {row['status']} differs from {item['status']}")
        if milestone_ids.get((row.get("projectMilestone") or {}).get("id")) != item["milestone"]:
            err(f"{key}: live milestone differs")
        parent = by_id.get(row.get("parentId"))
        if parent and key not in parent.get("children", []):
            err(f"{key}: live parent {row['parentId']} does not list it as a child")
        for child in item.get("children", []):
            if live.get(items[child]["linear"]["identifier"], {}).get("parentId") != identifier:
                err(f"{key}: {child} is not a live child of {identifier}")
        if identifier in graph:
            native = sorted(r["id"] for r in graph[identifier]["relations"]["blockedBy"])
            if native != sorted(item.get("nativeBlockedBy", [])):
                err(f"{key}: live blocking relations differ")
            if graph[identifier]["description"].rstrip() != (item.get("linearDescription") or "").rstrip():
                err(f"{key}: live description differs from the snapshot")
    for identifier in open_ids - set(by_id):
        if live[identifier].get("parentId") in by_id:
            err(f"{identifier}: open child of {live[identifier]['parentId']} is outside the plan")
    for identifier, status in snapshot.get("externalSources", {}).items():
        if live.get(identifier, {}).get("status") != status:
            err(f"{identifier}: recorded external status {status} differs from the readback")
    created = {row["linear"]["id"] for row in data.get("issues", [])}
    owners = {items[key]["linear"]["identifier"] for key in snapshot["hostedDeliveryOwners"] if key in items}
    if created and created != owners:
        err("Hosted delivery owners differ from the issues created by the readback")
    return errors


def generated_findings(root):
    """Run the generator's own check and return what it reports. It runs beside validation, never behind it."""
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("generate.py")), "--check", "--root", str(root)],
                            capture_output=True, text=True)
    if result.returncode == 0:
        return []
    lines = (result.stderr or result.stdout).strip().splitlines()
    return [lines[-1] if lines else "generate.py --check failed without output"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO, help="checkout holding docs/plan (default: this repository)")
    parser.add_argument("--require-linear-ids", action="store_true", help="kept for scripts/agent-tools; mappings are always required")
    parser.add_argument("--linear-relations", type=Path, metavar="READBACK", help="coordinator readback with liveIssues and liveGraph")
    args = parser.parse_args()
    root = args.root.resolve()
    plan, coverage = load(root)
    findings = validate(plan, coverage)
    if args.linear_relations:
        findings += compare_readback(plan, args.linear_relations)
        print(f"Compared the Linear readback {args.linear_relations.name}; this command does not fetch live data.")
    # The plan file is the thing under test, so it cannot waive a finding about itself: a recorded coordinator
    # change is one more finding, and the check holds until the coordinator resolves it and the row is removed.
    findings += [f"Pending coordinator change {row.get('issue')}: {row.get('change')}" for row in plan["snapshot"].get("pendingCoordinatorChanges", [])]
    findings += generated_findings(root)
    if findings:
        raise SystemExit("\n".join(findings) + f"\nHOLD: {len(findings)} planning finding{'s' * (len(findings) != 1)}; the plan is not accepted.")
    items = plan["items"]
    roles = Counter(i["role"] for i in items if i["status"] not in CLOSED)
    print(f"PASS: {len(items)} planning issues ({sum(i['status'] in CLOSED for i in items)} accepted historical, "
          f"{roles['writer']} open writers, {roles['aggregate']} aggregates, {roles['map']} map, {roles['decision']} decision), "
          f"{len(plan['milestones'])} milestones, {VIEW_COUNT} unique views with historical and hosted owners, "
          f"{len(plan['snapshot']['hostedDeliveryOwners'])} gated hosted owners, acyclic native blockers, "
          f"{len(GATES)} independent gates, concurrent scopes and test paths, {len(items)} Linear mappings, "
          f"generated documents current, 0 pending coordinator changes.")


if __name__ == "__main__":
    main()
