"""Check a delivery plan against the document contract of the one scripts/planning/generate.py writes.

Usage: python3 scripts/planning/plan_format.py [--root ROOT] [PLAN]   (PLAN defaults to ROOT/docs/delivery-plan.md)
The plan begins with docs/plan/program-intro.md, whose reading guide states the project's box and evidence rules and
whose checklist holds only boxes. The generated sections follow in order. Every planning item has one graph line under
its milestone, with its Linear link, status, role, in-plan blockers and an existing brief; every v5 view has one hosted
owner; and the snapshot, statuses, controls and pending rows agree with docs/plan/work-items.json, so a plan rendered
from older inputs fails. check.py separately proves every generated file byte-for-byte current.
"""
import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SECTIONS = ["Delivery controls", "Current issue graph", "Open issues outside the plan", "Hosted view ownership",
            "Pending coordinator changes", "Close the program", "Appendix A. Audit dispositions by issue",
            "Appendix B. Sources"]
READING_RULES = ["One box is one unit of work.", "Check a box only when its evidence exists.",
                 "A required skipped, mocked, stale or weakened check never counts as a pass."]
BOX = re.compile(r"- \[[ x]\] \S.*")
LINK = re.compile(r"\[(GRS-\d+)\]\(https://linear\.app/[^)\s]+\)")
GRAPH_LINE = re.compile(r"- \[(?P<id>GRS-\d+)\]\((?P<url>https://linear\.app/[^)\s]+)\) `(?P<key>[^`]+)`\. (?P<rest>.+) "
                        r"\[Brief\]\(plan/tickets/(?P<brief>[^)]+)\.md\)\.")
ROLE = re.compile(r"\. (?:Writer, \w+|Accepted \w+ \(historical\)|Wayfinder map|Decision record|Integration aggregate)\.")
OWNER_LINE = re.compile(r"- \[GRS-\d+\]\(https://linear\.app/[^)\s]+\) `(?P<key>[^`]+)`\. (?P<count>\d+) views: (?P<views>.+)\.")
OUTSIDE_LINE = re.compile(r"- GRS-\d+\. .+\. Milestone .+\.")


def split(lines, marker):
    """[(title, line number, [(number, line)])] for each heading that starts with marker."""
    parts = []
    for number, line in lines:
        if line.startswith(marker):
            parts.append((line[len(marker):], number, []))
        elif parts:
            parts[-1][2].append((number, line))
    return parts


def bullets(lines):
    return [(number, line) for number, line in lines if line.startswith("- ")]


def check(root, plan_path):
    """Return (findings, summary). Raises OSError, ValueError, KeyError or TypeError on unreadable or malformed inputs."""
    work = json.loads((root / "docs/plan/work-items.json").read_text())
    coverage = json.loads((root / "docs/plan/view-coverage.json").read_text())
    intro = (root / "docs/plan/program-intro.md").read_text()
    text = plan_path.read_text()
    items, snapshot = {item["key"]: item for item in work["items"]}, work["snapshot"]
    findings = []

    def find(number, message):
        findings.append(f"{plan_path}:{number}: {message}")

    if not text.startswith(intro + "\n"):
        pairs = zip(intro.splitlines(), text.splitlines())
        first = next((n for n, (want, got) in enumerate(pairs, 1) if want != got), len(intro.splitlines()) + 1)
        find(first, "the plan does not begin with docs/plan/program-intro.md; regenerate it with scripts/planning/generate.py")
    numbered = list(enumerate(text.splitlines(), 1))
    sections = split(numbered, "## ")
    titles = [title for title, _, _ in sections]
    generated = titles[sum(line.startswith("## ") for line in intro.splitlines()):]
    if generated != SECTIONS:
        find(sections[-1][1] if sections else 1, f"sections after the intro are {generated}, expected {SECTIONS}")
    body = {}
    for title, number, lines in sections:
        if title in body:
            find(number, f'"## {title}" appears twice')
        body.setdefault(title, (number, lines))
    empty = (1, [])

    number, lines = body.get("How to read this", empty)
    prose = " ".join(line for _, line in lines)
    for rule in READING_RULES:
        if rule not in prose:
            find(number, f'How to read this lacks "{rule}"')
    for title in ("Program checklist", "Close the program"):
        number, lines = body.get(title, empty)
        if not bullets(lines):
            find(number, f"{title} holds no boxes")
        for n, line in bullets(lines):
            if not BOX.fullmatch(line):
                find(n, f"{title} item is not a box: {line[:60]}")

    number, lines = body.get("Delivery controls", empty)
    present = {line for _, line in bullets(lines)}
    for control in work["controls"]:
        if f"- {control}" not in present:
            find(number, f"Delivery controls lacks the work-items.json control beginning {control[:40]!r}; the plan is stale")
    if len(present) != len(work["controls"]):
        find(number, f"Delivery controls lists {len(present)} controls, work-items.json {len(work['controls'])}")

    number, graph = body.get("Current issue graph", empty)
    stamp = f"Snapshot of {snapshot['date']} at `{snapshot['sourceRevision'][:12]}`."
    if not any(line.startswith(stamp) for _, line in graph):
        find(number, f'Current issue graph lacks "{stamp}" from work-items.json; the plan is stale')
    milestones = split(graph, "### ")
    names = [milestone["name"] for milestone in work["milestones"]]
    if [title for title, _, _ in milestones] != names:
        find(number, f"milestones are {[title for title, _, _ in milestones]}, expected {names} from work-items.json")
    milestone_key = {milestone["name"]: milestone["key"] for milestone in work["milestones"]}
    listed, references = {}, []
    for title, _, lines in milestones:
        for n, line in bullets(lines):
            match = GRAPH_LINE.fullmatch(line)
            if not match:
                find(n, "graph line is not `- [GRS-n](url) `KEY`. Title. Status. Role. ... [Brief](plan/tickets/KEY.md).`")
                continue
            key, rest = match["key"], match["rest"]
            if key in listed:
                find(n, f"{key} is listed twice (first at line {listed[key][0]})")
                continue
            listed[key] = (n, match["id"])
            references.append((n, key, rest))
            if match["brief"] != key:
                find(n, f"{key} links the brief of {match['brief']}")
            elif not (plan_path.parent / f"plan/tickets/{key}.md").is_file():
                find(n, f"{key}: its brief plan/tickets/{key}.md does not exist")
            if f"/issue/{match['id']}/" not in match["url"] + "/":
                find(n, f"{key}: link text {match['id']} does not match its URL")
            if not ROLE.search(f". {rest}"):
                find(n, f"{key}: no role (Writer, Accepted ... (historical), Wayfinder map, Decision record or Integration aggregate)")
            item = items.get(key)
            if not item:
                find(n, f"{key} is not a planning key in work-items.json; the plan is stale or hand-edited")
                continue
            if milestone_key.get(title) != item["milestone"]:
                find(n, f"{key} is under {title}, but work-items.json puts it in {item['milestone']}")
            if (item.get("linear") or {}).get("identifier") != match["id"]:
                find(n, f"{key} is linked as {match['id']}, but work-items.json maps it to {(item.get('linear') or {}).get('identifier')}")
            if not rest.startswith(f"{item['title']}. {item['status']}. "):
                find(n, f"{key}: title or status differs from work-items.json ({item['status']}); the plan is stale")
    in_plan = {identifier for _, identifier in listed.values()}
    for n, key, rest in references:
        for identifier in LINK.findall(rest):
            if identifier not in in_plan:
                find(n, f"{key} names {identifier}, which has no graph line in the plan")
        for name in re.findall(r"`([^`]+)`", rest):
            find(n, f"{key} names `{name}`, which has no Linear issue in the plan")
    for key in items:
        if key not in listed:
            find(number, f"{key} from work-items.json has no graph line")

    number, lines = body.get("Open issues outside the plan", empty)
    outside = bullets(lines)
    for n, line in outside:
        if not OUTSIDE_LINE.fullmatch(line):
            find(n, "open-issue line is not `- GRS-n. Title. Status. Milestone M.`")
    if len(outside) != len(snapshot["readback"]["openOutsidePlan"]):
        find(number, f"{len(outside)} open issues outside the plan, work-items.json records "
                     f"{len(snapshot['readback']['openOutsidePlan'])}; the plan is stale")

    number, lines = body.get("Hosted view ownership", empty)
    owner_of = {}
    for n, line in bullets(lines):
        match = OWNER_LINE.fullmatch(line)
        if not match:
            find(n, "hosted owner line is not `- [GRS-n](url) `KEY`. N views: a, b.`")
            continue
        named = match["views"].split(", ")
        if int(match["count"]) != len(named):
            find(n, f"{match['key']} claims {match['count']} views but names {len(named)}")
        if match["key"] not in items:
            find(n, f"hosted owner {match['key']} is not a planning key")
        for view in named:
            if view in owner_of:
                find(n, f"view {view} has a second hosted owner (first at line {owner_of[view]})")
            owner_of.setdefault(view, n)
    views = [view["id"] for view in coverage["views"]]
    for view in sorted(set(views) - set(owner_of)):
        find(number, f"view {view} has no hosted owner")
    for view in sorted(set(owner_of) - set(views)):
        find(owner_of[view], f"view {view} is not in view-coverage.json")

    number, lines = body.get("Pending coordinator changes", empty)
    pending = snapshot.get("pendingCoordinatorChanges", [])
    rows = bullets(lines)
    if len(rows) != len(pending):
        find(number, f"Pending coordinator changes lists {len(rows)} rows, work-items.json {len(pending)}; the plan is stale")
    elif not pending and [line for _, line in lines if line.strip()] != ["None."]:
        find(number, 'Pending coordinator changes must read "None." while work-items.json lists none')

    number, lines = body.get("Appendix A. Audit dispositions by issue", empty)
    if [line[2:8] for _, line in bullets(lines)] != [f"BA-{n:02}." for n in range(1, 22)]:
        find(number, "Appendix A does not list BA-01 to BA-21 once each, in order")

    summary = (f"intro, {len(SECTIONS)} generated sections, {len(listed)} graph lines under {len(milestones)} milestones, "
               f"{len(owner_of)} views with one hosted owner each, snapshot {snapshot['date']}")
    return findings, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=REPO, help="checkout holding docs/plan (default: this repository)")
    parser.add_argument("plan", nargs="?", type=Path, help="plan to check (default: ROOT/docs/delivery-plan.md)")
    args = parser.parse_args()
    root = args.root.resolve()
    plan = (args.plan or root / "docs/delivery-plan.md").resolve()
    try:
        findings, summary = check(root, plan)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"plan-format: FAIL. cannot read the plan or its inputs under {root}: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    if findings:
        print("\n".join(findings), file=sys.stderr)
        print(f"plan-format: FAIL. {len(findings)} finding{'s' * (len(findings) != 1)} in {plan}.", file=sys.stderr)
        return 1
    print(f"plan-format: PASS. {plan} follows the generated delivery-plan contract: {summary}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
