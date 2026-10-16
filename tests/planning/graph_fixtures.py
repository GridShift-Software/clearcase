"""Run every planning graph fixture through scripts/planning/check.py, without the agent-tools receipt layer.

Usage: python3 tests/planning/graph_fixtures.py
Each fixture in tests/agent-tools/fixtures/graph/ edits a disposable copy of the committed plan (make_tree.py)
and names the exit code and the messages the checker must print (expect.output). A negative fixture passes only if
it fails for its own cause: every finding line must contain one of its messages, and no run that exits non-zero
may print PASS. expect.absent lists text that must not appear. tests/agent-tools/run.sh runs the same fixtures
through scripts/agent-tools/verify and applies the same rules.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests/agent-tools/fixtures/graph"
STATUS_LINES = ("Compared the Linear readback", "HOLD: ")
failures = 0
with tempfile.TemporaryDirectory(prefix="planning-graph-") as work:
    for fixture_path in sorted(FIXTURES.glob("*.json")):
        fixture, tree = json.loads(fixture_path.read_text()), Path(work) / fixture_path.stem
        built = subprocess.run([sys.executable, str(REPO / "tests/agent-tools/make_tree.py"), str(REPO), str(tree),
                                str(fixture_path)], capture_output=True, text=True)
        if built.returncode:
            failures += 1
            print(f"FAIL {fixture_path.stem}: the fixture tree did not build\n    {built.stderr.splitlines()[-1:]}")
            continue
        command = [sys.executable, str(tree / "scripts/planning/check.py"), "--require-linear-ids"]
        if fixture["capability"] == "linear-relations":
            command += ["--linear-relations", str(tree / "readback.json")]
        result = subprocess.run(command, capture_output=True, text=True)
        output = result.stdout + result.stderr
        expect = fixture["expect"]
        missing = [message for message in expect["output"] if message not in output]
        present = [text for text in expect.get("absent", []) + ([] if expect["exit"] == 0 else ["PASS"]) if text in output]
        # The checker's own status lines are not findings; everything else must be one the fixture expects.
        unexpected = [line for line in output.splitlines() if line.strip() and not line.startswith(STATUS_LINES)
                      and not any(message in line for message in expect["output"])]
        if result.returncode != expect["exit"] or missing or present or unexpected:
            failures += 1
            print(f"FAIL {fixture_path.stem}: exit {result.returncode}, expected {expect['exit']}; missing {missing}; "
                  f"must be absent {present}; unexpected {unexpected}")
            print("\n".join(f"    {line}" for line in output.splitlines()[-8:]))
        else:
            print(f"ok   {fixture_path.stem}: {fixture['description']}")
print(f"{'FAIL' if failures else 'PASS'}: {failures} of {len(list(FIXTURES.glob('*.json')))} planning graph fixtures failed.")
sys.exit(1 if failures else 0)
