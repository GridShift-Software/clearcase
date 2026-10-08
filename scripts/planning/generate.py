import argparse
import difflib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLAN = ROOT / "docs/plan/work-items.json"
RULE = "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked."


def issue_ref(item):
    link = item.get("linear")
    return f"[{link['identifier']}]({link['url']})" if link else item["key"]


def ticket_body(item, by_key):
    dependencies = ", ".join(issue_ref(by_key[key]) for key in item["depends"]) or "None"
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


def unit_section(item, by_key):
    key = item["key"]
    deps = ", ".join(issue_ref(by_key[k]) for k in item["depends"]) or "None"
    proof = f".orchestration/reports/{key}"
    if key == "CC-01":
        perf_probe = "Run `python3 scripts/fixtures/inventory.py --verify` with elapsed-time and peak-memory reporting. Record the initial baseline and machine details; no interleaved comparison is required."
    else:
        perf_probe = f"Run `npm run measure -- --ticket {key} --baseline BASE --candidate HEAD` after the owner supplies the measured scenario. Alternate baseline and candidate with identical inputs and clock; retain at least 20 samples, warmup policy and machine details."
        if key == "CC-02":
            perf_probe += " Place this unit's measurement script under its owned scripts/case-package/ directory."
    lines = [f"## {item['title']} ({key})", f"**Depends on.** {deps}.", "**Files.**"]
    lines += [f"- [ ] Own `{path}` for this unit. Reserve shared files before dispatch." for path in item["scope"]]
    lines += ["**Build.**"] + [f"- [ ] {text}" for text in item["acceptance"]]
    lines += ["**You see.**", f"- [ ] {item['outcome']}", f"**Verify, unit.** {RULE}"]
    if key == "CC-01":
        lines += ["- [ ] Deliver and run `python3 scripts/fixtures/inventory.py --verify` against the designated local archive. Preserve its JSON inventory and literal fixture assertions in the unit report."]
    else:
        lines += [f"- [ ] Run `npm run check` and `npm run test -- --run {item['testPath']}` against the literal acceptance examples. Record stdout, stderr and exit codes in `{proof}/unit.txt`. The owner must provide these planned test paths and scripts before claiming completion."]
    lines += [f"**Verify, live.** {RULE} Ten lanes on `claude-opus-5-5 high or a different supported verifier family` at the PR head. Run in bounded batches, never ten simultaneous writers. Before a PR exists, use the exact local candidate revision."]
    for n, scenario in enumerate(item["liveScenarios"], 1):
        lead = "Regression lane against the last accepted integration revision. " if n == 1 else ""
        suffix = " Use dev at its accepted base revision. If that base lacks the feature, compare the designated v5 reference or record an absolute baseline without inventing a result." if n == 1 else ""
        lines.append(f"- [ ] Lane {n}. {lead}{scenario}. Save `{proof}/lane-{n:02}.png` for browser behavior or `{proof}/lane-{n:02}.txt` for a CLI transcript. Pass when the named scenario satisfies this unit's literal baseline and acceptance criteria.{suffix}")
    lines += [
        f"**Verify, perf.** {RULE}",
        f"- [ ] Metric. Measure {item['performanceMetric'].rstrip('.') } at the accepted base and candidate where comparable. Name the work newly added by this unit.",
        f"- [ ] Probe. {perf_probe}",
        "- [ ] Baseline. Record the accepted base's median and p95 first. If the base lacks the feature, record N/A and measure the reference or absolute new behavior without a fabricated ratio.",
        f"- [ ] Rule. {item['performanceBudget']} Any budget that depends on a baseline must be fixed numerically in the dispatch brief before implementation, then approved by the independent reviewer.",
    ]
    if key in {"CC-01", "CC-02"}:
        lines += [f"**Review gate.** None. {key} is not review-gated for product interaction. Its independent contract gate still applies."]
    else:
        lines += [
            "**Review gate.** The user reviews changed interactions before merge into main. ",
            f"- [ ] Save a screenshot and a 30 to 60 second video under `{proof}/review/`. Post the concrete result for the user's visual review, called operator review in pstack, before requesting a main-branch merge.",
        ]
    lines += [
        "**Merge.**",
        "- [ ] Obtain an independent clean verdict at the exact candidate revision and record all receipts.",
        "- [ ] Integrate serially into the local integration branch only when the kickoff grants that authority. Recheck behavior affected by integration.",
        "- [ ] Keep main unchanged. Open the PR into `dev`, register it with T3 and apply the same evidence gate to its actual head.",
    ]
    return "\n\n".join(lines) + "\n"


def audit_appendix(items):
    cited = {n: [] for n in range(1, 22)}
    for item in items:
        # The full BA-01 to BA-21 range is the register owners' job, so only narrower citations count here.
        text = re.sub(r"BA-01(?: to |\u2013)BA-21", "", " ".join(item["acceptance"]))
        numbers = {int(n) for n in re.findall(r"BA-(\d\d)", text)}
        for first, last in re.findall(r"BA-(\d\d)(?: to |\u2013)BA-(\d\d)", text):
            numbers.update(range(int(first), int(last) + 1))
        for n in numbers:
            cited[n].append(item["key"])
    rows = [
        "## Appendix F. Audit dispositions by issue",
        "The browser audit findings BA-01 to BA-21 and their full dispositions live in the [Linear delivery plan](https://linear.app/vaper/document/clearcase-delivery-plan-and-acceptance-gates-518b0c44b87a). CC-01 owns the repository register `docs/reference/audit-dispositions.md`, CC-23 verifies it and CC-11 reviews every finding against its owner. Each line below lists the issues whose acceptance text names that finding.",
    ]
    for n, keys in cited.items():
        owners = ", ".join(keys) if keys else "No issue names it directly. The CC-01 register assigns its owner and CC-11 reviews it"
        rows.append(f"- BA-{n:02}. {owners}.")
    return rows


def render(plan):
    items = plan["items"]
    by_key = {item["key"]: item for item in items}
    outputs = {}
    for item in items:
        outputs[ROOT / f"docs/plan/tickets/{item['key']}.md"] = f"# {item['title']}\n\n" + ticket_body(item, by_key)
    intro = (ROOT / "docs/plan/program-intro.md").read_text()
    sections = [unit_section(item, by_key) for item in items if item["liveScenarios"]]
    end = [
        "## Close the program",
        "- [ ] Reconcile all spawned tasks and receipts. Verify the V1 parity and compatibility gates at the integrated revision.",
        "- [ ] Read back Linear milestones, issues and blocking relations. Refresh the plan snapshot and report any drift.",
        "- [ ] Update the product brief, development/user docs, differences register and the next-agent checkpoint.",
        "- [ ] Hand back the local app and evidence. Leave V2 and Pi Durable behind their explicit phase gates.",
        "## Appendix A. Prototype evidence",
        "No new application prototype has been built. The existing v5 HTML is the behavioral reference. Baseline capture, local persistence/import design and the complete pilot are explicit gated work before broad implementation. The hosted compute and role choices remain decision work. No empirical question is claimed settled by this plan.",
        "## Appendix B. Alternatives rejected",
        "Reject a direct production rewrite as the initial acceptance target because the user selected v5 first. Reject a shared multi-tenant platform for the first hosted version because the user requested separate client instances. Reject bulk execution of archive scripts and silent reuse of legacy refs across independent builds. Keep Knap as data-to-Markdown templating with a separate parser for edited analysis.",
        "## Appendix C. Risks",
        "The original processing scripts and hosted import contract are missing. CC-01/02 preserve observed behavior and CC-14 investigates operator access without blocking V1. Legacy defects need explicit dispositions rather than blind parity. Large files and truncated text require honest states. CC-06 separates arithmetic checks from legal approval. Push feature branches early and preserve recoverable local state before risky Git operations. V2 deployment and product-role decisions are gated by CC-26, and CC-28 implements the hosted foundation before CC-16 starts client intake.",
        "## Appendix D. Links and reading list",
        "Read [scope](product-brief.md), [evidence](evidence.md), [orchestration](orchestration.md), [skill alignment](reviews/skill-alignment.md) and [view ownership](plan/view-coverage.json). The decision trail is `.audit/planning-decisions.tsv`. The installed skills live under `/home/vaper/.agents/skills/`. Use how for subsystem understanding and architect for interface decisions during implementation. Use interrogate if a design remains contested.",
        "## Appendix E. Milestones and full issue graph",
    ]
    for milestone in plan["milestones"]:
        end += [f"### {milestone['name']}", milestone["exit"]]
        for item in items:
            if item["milestone"] == milestone["key"]:
                blockers = ", ".join(item["depends"]) or "none"
                end.append(f"- {issue_ref(item)} `{item['key']}`. {item['title']}. Blockers {blockers}. [{item['kind']} brief](plan/tickets/{item['key']}.md).")
    end += ["CC-27 supplies the agent tooling and plan synchronization that CC-01 waits for; it implements no application behavior. CC-14 remains open until the old contract is verified. It is not a dependency of V1 or a reason to invent an operator route. CC-26 can explicitly accept the new contract while deferring legacy migration. M6 stays parked. No later-phase implementation starts without a concrete verification recipe and resolved product decisions."]
    end += audit_appendix(items)
    outputs[ROOT / "docs/delivery-plan.md"] = intro + "\n" + "\n".join(sections) + "\n" + "\n\n".join(end) + "\n"
    return outputs


def comparable(text):
    """Apply the readback normalization: blank lines, list markers, Markdown escapes and Linear link forms."""
    text = re.sub(r'<issue id="[^"]*" href="([^"]*)">([^<]*)</issue>', r"[\2](\1)", text)
    text = re.sub(r"\]\(<([^>]*)>\)", r"](\1)", text)
    text = re.sub(r"(https://linear\.app/[^/]+/issue/[A-Z]+-\d+)/[^)\s]*", r"\1", text)
    text = text.replace("\\*", "*").replace("\\.", ".")
    return [re.sub(r"^(\s*)\* ", r"\1- ", line.rstrip()) for line in text.splitlines() if line.strip()]


def compare_linear(plan, export_path):
    by_key = {item["key"]: item for item in plan["items"]}
    live = {row["key"]: row for row in json.loads(Path(export_path).read_text())["issues"]}
    drift = 0
    for key in sorted(set(by_key) | set(live), key=lambda k: (len(k), k)):
        if key not in by_key or key not in live:
            drift += 1
            print(f"{key}: {'missing from plan' if key not in by_key else 'missing from export'}")
            continue
        diff = list(difflib.unified_diff(comparable(ticket_body(by_key[key], by_key)), comparable(live[key]["description"]),
                                         "generated", "linear", n=0, lineterm=""))
        if diff:
            drift += 1
            print(f"{key} {live[key].get('id', '')}: description differs")
            print("\n".join(f"  {line}" for line in diff[2:]))
        else:
            print(f"{key} {live[key].get('id', '')}: match")
    print(f"{drift} of {len(set(by_key) | set(live))} issue descriptions differ from the export.")
    return drift


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--linear-payloads", action="store_true")
    parser.add_argument("--compare-linear", metavar="EXPORT", help="diff generated briefs against a Linear export's descriptions")
    args = parser.parse_args()
    plan = json.loads(PLAN.read_text())
    if args.compare_linear:
        raise SystemExit(1 if compare_linear(plan, args.compare_linear) else 0)
    if args.linear_payloads:
        by_key = {item["key"]: item for item in plan["items"]}
        print(json.dumps({"project": plan["project"], "milestones": plan["milestones"], "items": [{**item, "description": ticket_body(item, by_key)} for item in plan["items"]]}))
        return
    stale = []
    outputs = render(plan)
    for path, content in outputs.items():
        if args.check:
            if not path.exists() or path.read_text() != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    if stale:
        raise SystemExit("Stale generated plans: " + ", ".join(stale))
    print(f"{'Verified' if args.check else 'Generated'} {len(outputs)} planning documents.")


if __name__ == "__main__":
    main()
