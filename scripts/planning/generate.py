"""Generate docs/plan/tickets/*.md and docs/delivery-plan.md from docs/plan/work-items.json."""
import argparse
import difflib
import json
import re
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLOSED = {"Done", "Canceled", "Duplicate"}


def issue_ref(item):
    link = item.get("linear")
    return f"[{link['identifier']}]({link['url']})" if link else item["key"]


def historical_body(item, by_key):
    """The 8 October brief format. Items without a Linear description snapshot keep it unchanged as history."""
    dependencies = ", ".join(issue_ref(by_key[key]) if key in by_key else f"`{key}`" for key in item["depends"]) or "None"
    rows = [
        f"Planning key `{item['key']}`. Phase {item['phase']}. Milestone `{item['milestone']}`. Type {item['kind']}.",
        "## Outcome", item["outcome"],
        "## Dependencies", dependencies,
        "## Write scope", *[f"- `{path}`" for path in item["scope"]], *[f"- {note}" for note in item.get("scopeNotes", [])],
        "## Acceptance", *[f"- [ ] {text}" for text in item["acceptance"]],
        "## Verification",
    ]
    if item.get("verification"):
        rows.extend(f"- [ ] {text}" for text in item["verification"])
    else:
        rows.append("Report PASS, HOLD or FAIL at the exact reviewed revision. Include commands, exit codes and artifact paths. A skipped check is not a pass. Read the local delivery plan and orchestration protocol before dispatch.")
        if item["liveScenarios"]:
            rows.extend(f"- [ ] {n}. {scenario}." for n, scenario in enumerate(item["liveScenarios"], 1))
        else:
            rows.append("Use an independent reviewer for a gate. For discovery or design, verify the cited source or probe and record unresolved choices. Later-phase implementation requires a concrete test recipe before dispatch.")
    if item.get("performanceMetric"):
        rows.append(f"Metric: {item['performanceMetric']}. Budget: {item['performanceBudget']}")
    if item.get("handoff"):
        rows.extend(["## Boundaries and handoff", item["handoff"]])
        return "\n\n".join(rows) + "\n"
    rows.extend([
        "## Boundaries",
        "Keep RAWS and current production read-only. Do not commit case documents, extracted text or secrets. No Cursor agents; every Opus agent uses high effort. Only the coordinator updates Linear. No deployment, production publication or external messages under this issue without the appropriate execution authority.",
        "## Handoff",
        "Return the branch/worktree, base and head revision, changed paths, accepted criteria, failed or skipped checks, evidence paths and proposed follow-ups. Do not mark the issue Done yourself.",
    ])
    return "\n\n".join(rows) + "\n"


def description(item, by_key):
    """The issue body: the authoritative Linear snapshot when one exists, otherwise the historical brief."""
    if item.get("linearDescription"):
        return item["linearDescription"].rstrip() + "\n"
    return historical_body(item, by_key)


def ticket(item, plan, by_key):
    head = f"# {item['title']}\n\n"
    if item.get("linearDescription"):
        head += f"Planning snapshot, {plan['snapshot']['date']}. [Live issue]({item['linear']['url']}) is the execution authority.\n\n"
    return head + description(item, by_key)


def audit_appendix(items):
    cited = {n: [] for n in range(1, 22)}
    for item in items:
        # The full BA-01 to BA-21 range is the register owners' job, so only narrower citations count here.
        text = re.sub(r"BA-01(?: to |–)BA-21", "", " ".join(item["acceptance"]))
        numbers = {int(n) for n in re.findall(r"BA-(\d\d)", text)}
        for first, last in re.findall(r"BA-(\d\d)(?: to |–)BA-(\d\d)", text):
            numbers.update(range(int(first), int(last) + 1))
        for n in numbers:
            cited[n].append(item["key"])
    rows = [
        "## Appendix A. Audit dispositions by issue",
        "The browser audit findings BA-01 to BA-21 and their full dispositions live in the [Linear delivery plan](https://linear.app/vaper/document/clearcase-delivery-plan-and-acceptance-gates-518b0c44b87a). CC-01 owns the repository register `docs/reference/audit-dispositions.md`, CC-23 verifies it and CC-11 reviews every finding against its owner. Each line below lists the issues whose acceptance text names that finding.",
    ]
    rows.append("\n".join(f"- BA-{n:02}. {', '.join(keys) if keys else 'No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it'}."
                           for n, keys in cited.items()))
    return rows


def graph_line(item, by_key, by_id, sources):
    ids = lambda keys: ", ".join(issue_ref(by_key[k]) if k in by_key else f"`{k}`" for k in keys)
    role = {"map": "Wayfinder map", "decision": "Decision record", "aggregate": "Integration aggregate"}.get(item["role"])
    if not role:
        role = f"Accepted {item['kind']} (historical)" if item["status"] in CLOSED else f"Writer, {item['kind']}"
    parts = [f"- {issue_ref(item)} `{item['key']}`. {item['title']}. {item['status']}. {role}."]
    if item.get("children"):
        parts.append(f"Children {ids(item['children'])}.")
    if item["depends"]:
        parts.append(f"Blocked by {ids(item['depends'])}.")
    if item.get("externalPrerequisites"):
        parts.append("Outside the plan, blocked by " + ", ".join(f"{e} ({sources.get(e, 'unknown')})" for e in item["externalPrerequisites"]) + ".")
    parts.append(f"[Brief](plan/tickets/{item['key']}.md).")
    return " ".join(parts)


def snapshot_line(snapshot):
    return f"Snapshot of {snapshot['date']} at `{snapshot['sourceRevision'][:12]}`. {snapshot['authority']} Hosted runtime evidence is {snapshot['runtimeEvidence']}."


def outside_lines(readback):
    return [f"- {row['identifier']}. {row['title']}. {row['status']}. Milestone {row['milestone'] or 'none'}." for row in readback["openOutsidePlan"]]


def pending_lines(snapshot):
    return [f"- {row['issue']}. {row['change']}" for row in snapshot.get("pendingCoordinatorChanges", [])]


def plan_sections(plan, coverage):
    items, snapshot = plan["items"], plan["snapshot"]
    by_key = {item["key"]: item for item in items}
    by_id = {item["linear"]["identifier"]: item for item in items if item.get("linear")}
    gate, readback = by_id[snapshot["planningGate"]], snapshot["readback"]
    open_items = [item for item in items if item["status"] not in CLOSED]
    count = lambda role: sum(item["role"] == role for item in open_items)
    gate_done = gate["status"] == "Done"
    if gate_done:
        approval = snapshot["planningGateApproval"]
        records = f". The wayfinder map {issue_ref(gate)} is Done: the user approved the complete written plan on {approval['date']} (comment `{approval['comment']}`)."
    else:
        records = f", {count('map')} is the wayfinder map {issue_ref(gate)} and {count('decision')} is a decision record."
    rows = [
        "## Delivery controls",
        f"Accepted under {issue_ref(by_id[snapshot['operatingDecision']])}. The [operating plan](plan/agent-delivery-operating-plan.md) and the [hosted-alpha acceptance baseline](plan/hosted-alpha-acceptance.md) hold the full text. These controls replace the 8 October brief boilerplate kept in historical tickets.",
        "\n".join(f"- {line}" for line in plan["controls"]),
        "## Current issue graph",
        snapshot_line(snapshot),
        f"The plan holds {len(items)} issues. {len(items) - len(open_items)} are accepted historical work. Of the {len(open_items)} open issues, {count('writer')} are writers, {count('aggregate')} are integration aggregates{records} {len(snapshot['hostedDeliveryOwners'])} writers are the hosted delivery owners, {'each natively blocked by' if gate_done else 'each Backlog and natively blocked by'} {issue_ref(gate)}. The readback holds {readback['projectIssues']} project issues, {readback['openIssues']} of them open.",
        "Follow the native blockers listed here, not the summary order in the checklist. An aggregate closes only when its children are accepted; a child never waits on its parent.",
    ]
    for milestone in plan["milestones"]:
        rows += [f"### {milestone['name']}", f"Phase {milestone['phase']}. {milestone['exit']}"]
        rows.append("\n".join(graph_line(item, by_key, by_id, snapshot["externalSources"])
                               for item in items if item["milestone"] == milestone["key"]))
    rows += ["## Open issues outside the plan",
             "These open project issues have no planning key. A plan item names one as an external prerequisite where Linear lists it as a native blocker. The checker fails when an open project issue is missing from this list."]
    rows.append("\n".join(outside_lines(readback)))
    owners = defaultdict(list)
    for view in coverage["views"]:
        owners[view["hostedOwner"]].append(view["id"])
    acceptance = by_key[coverage["hostedOwnership"]["acceptanceOwner"]]
    rows += ["## Hosted view ownership",
             f"Each of the {len(coverage['views'])} v5 views keeps its historical owner and has one hosted migration owner. {issue_ref(acceptance)} accepts every hosted owner. Shared storage, identity and viewer contracts have their own owners."]
    rows.append("\n".join(f"- {issue_ref(by_key[key]) if key in by_key else 'Unknown owner'} `{key}`. {len(views)} views: {', '.join(views)}." for key, views in owners.items()))
    pending = snapshot.get("pendingCoordinatorChanges", [])
    rows += ["## Pending coordinator changes",
             "The checker holds, with a non-zero exit, while any of these is listed. It waives nothing: the coordinator changes Linear, refreshes the snapshot and removes the row." if pending else "None."]
    rows += ["\n".join(pending_lines(snapshot))] if pending else []
    rows += ["## Close the program", "\n".join([
        "- [ ] Reconcile delegated task IDs, receipts and attempt counts with Linear before closing a milestone.",
        "- [ ] Read back every project issue's status, parent, native blockers and description. Refresh `docs/plan/work-items.json`, regenerate, and run `scripts/agent-tools/check-plan --linear-relations READBACK`.",
        f"- [ ] Close {issue_ref(gate)} only on the user's approval of the complete written plan. Dispatch no hosted work before then." if not gate_done else f"- [x] {issue_ref(gate)} is closed on the user's approval of the complete written plan.",
        f"- [ ] Accept the hosted alpha only through {issue_ref(by_key['CC-20'])} at the exact integrated SHA with independent review. The user decides `main` merges and deployment.",
        "- [ ] Leave M6 and M7 behind the proven hosted alpha.",
    ])]
    rows += audit_appendix(items)
    rows += [
        "## Appendix B. Sources",
        "Read the [product brief](product-brief.md), the [route map](reference/route-map.md), the [ADRs](adr/README.md), the [operating plan](plan/agent-delivery-operating-plan.md), the [hosted-alpha acceptance baseline](plan/hosted-alpha-acceptance.md) and the [view ownership](plan/view-coverage.json). Historical V1 briefs keep their 8 October format under `docs/plan/tickets/`.",
    ]
    return rows


def render(plan, coverage, root):
    by_key = {item["key"]: item for item in plan["items"]}
    outputs = {root / f"docs/plan/tickets/{item['key']}.md": ticket(item, plan, by_key) for item in plan["items"]}
    intro = (root / "docs/plan/program-intro.md").read_text()
    outputs[root / "docs/delivery-plan.md"] = intro + "\n" + "\n\n".join(plan_sections(plan, coverage)) + "\n"
    return outputs


def comparable(text):
    """Apply the readback normalization: blank lines, list markers, Markdown escapes and Linear link forms."""
    text = re.sub(r'<issue id="[^"]*" href="([^"]*)">([^<]*)</issue>', r"[\2](\1)", text)
    text = re.sub(r"\]\(<([^>]*)>\)", r"](\1)", text)
    text = re.sub(r"(https://linear\.app/[^/]+/issue/[A-Z]+-\d+)/[^)\s]*", r"\1", text)
    text = text.replace("\\*", "*").replace("\\.", ".")
    return [re.sub(r"^(\s*)\* ", r"\1- ", line.rstrip()) for line in text.splitlines() if line.strip()]


def compare_linear(plan, export_path):
    """Diff issue bodies against a readback's liveGraph descriptions (open issues only)."""
    by_id = {item["linear"]["identifier"]: item for item in plan["items"]}
    by_key = {item["key"]: item for item in plan["items"]}
    graph = json.loads(Path(export_path).read_text())["liveGraph"]
    drift = 0
    for identifier in sorted(set(by_id) & set(graph), key=lambda i: int(i.split("-")[1])):
        item = by_id[identifier]
        diff = list(difflib.unified_diff(comparable(description(item, by_key)), comparable(graph[identifier]["description"]),
                                         "generated", "linear", n=0, lineterm=""))
        drift += bool(diff)
        print(f"{item['key']} {identifier}: {'description differs' if diff else 'match'}")
        print("\n".join(f"  {line}" for line in diff[2:]))
    print(f"{drift} of {len(set(by_id) & set(graph))} open issue descriptions differ from the readback.")
    return drift


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO, help="checkout holding docs/plan (default: this repository)")
    parser.add_argument("--check", action="store_true", help="fail when a generated file differs instead of writing it")
    parser.add_argument("--linear-payloads", action="store_true")
    parser.add_argument("--compare-linear", metavar="READBACK", help="diff issue bodies against a readback's liveGraph descriptions")
    args = parser.parse_args()
    root = args.root.resolve()
    plan = json.loads((root / "docs/plan/work-items.json").read_text())
    coverage = json.loads((root / "docs/plan/view-coverage.json").read_text())
    if args.compare_linear:
        raise SystemExit(1 if compare_linear(plan, args.compare_linear) else 0)
    if args.linear_payloads:
        by_key = {item["key"]: item for item in plan["items"]}
        print(json.dumps({"project": plan["project"], "milestones": plan["milestones"],
                          "items": [{**item, "description": description(item, by_key)} for item in plan["items"]]}))
        return
    outputs = render(plan, coverage, root)
    expected = set(outputs)
    stale = [path for path, content in outputs.items() if not path.exists() or path.read_text() != content]
    orphans = sorted(set((root / "docs/plan/tickets").glob("*.md")) - expected)
    if args.check:
        problems = [str(p.relative_to(root)) for p in stale] + [f"{p.relative_to(root)} (no planning key)" for p in orphans]
        if problems:
            raise SystemExit("Stale generated plans: " + ", ".join(problems))
    else:
        for path in stale:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(outputs[path])
        for path in orphans:
            path.unlink()
    print(f"{'Verified' if args.check else 'Generated'} {len(outputs)} planning documents.")


if __name__ == "__main__":
    main()
