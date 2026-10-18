"""Create synthetic t3-pstack installs under a throwaway HOME, with no reads from the real HOME.

Usage: python3 make_plugin.py HOME VERSION...
Every required file is generated text, except poteto-mode/scripts/check-plan.mjs: that is the committed, unchanged
copy of the canonical checker in fixtures/pstack/ (see its README), so plan-format tests still run the real checker.
"""

import hashlib
import importlib.util
import json
import shutil
import sys
from pathlib import Path

CHECKER_SHA256 = "f4bb71a390d7a49fc7d6e7dd178d2c2c0d9575c13194dc94a7df324107b87882"
CHECKER = "poteto-mode/scripts/check-plan.mjs"

home = Path(sys.argv[1])
here = Path(__file__).resolve().parent
checker = here / "fixtures/pstack/check-plan.mjs"
if hashlib.sha256(checker.read_bytes()).hexdigest() != CHECKER_SHA256:
    raise SystemExit(f"{checker} is not the unchanged canonical checker (sha256 {CHECKER_SHA256})")
spec = importlib.util.spec_from_file_location("agent_tools", here.parents[1] / "scripts/agent-tools/agent_tools.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
(home / ".claude/plugins").mkdir(parents=True, exist_ok=True)
records = []
for version in sys.argv[2:]:
    root = home / ".claude/plugins/cache/t3-pstack/t3-pstack" / version
    for rel in module.REQUIRED_PSTACK_FILES:
        target = root / "skills" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if rel == CHECKER:
            shutil.copy2(checker, target)
        else:
            target.write_text(f"# synthetic {rel} for t3-pstack {version}\n")
    (root / ".claude-plugin").mkdir()
    (root / ".claude-plugin/plugin.json").write_text(json.dumps({"name": "t3-pstack", "version": version}))
    records.append({"installPath": str(root), "version": version, "gitCommitSha": "a" * 40})
(home / ".claude/plugins/installed_plugins.json").write_text(
    json.dumps({"version": 2, "plugins": {"t3-pstack@t3-pstack": records}}))
