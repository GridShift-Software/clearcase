"""Create synthetic t3-pstack installs under a throwaway HOME, with no reads from the real HOME.

Usage: python3 make_plugin.py HOME [--codex] VERSION...
Without --codex: Claude installs, each cache version with its installed_plugins.json record.
With --codex: Codex installs in HOME/.codex, as Codex 0.163 lays them out: config.toml enables t3-pstack@t3-pstack from
the t3-pstack marketplace, the marketplace clone records its exact revision in .codex-marketplace-install.json and lists
the last VERSION in .claude-plugin/marketplace.json, and each VERSION has a cache directory with .codex-plugin/plugin.json.
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
SOURCE = "https://github.com/chhoumann/t3-pstack.git"

home = Path(sys.argv[1])
codex = sys.argv[2:3] == ["--codex"]
versions = sys.argv[3:] if codex else sys.argv[2:]
here = Path(__file__).resolve().parent
checker = here / "fixtures/pstack/check-plan.mjs"
if hashlib.sha256(checker.read_bytes()).hexdigest() != CHECKER_SHA256:
    raise SystemExit(f"{checker} is not the unchanged canonical checker (sha256 {CHECKER_SHA256})")
spec = importlib.util.spec_from_file_location("agent_tools", here.parents[1] / "scripts/agent-tools/agent_tools.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
plugins = home / (".codex/plugins" if codex else ".claude/plugins")
plugins.mkdir(parents=True, exist_ok=True)
records = []
for version in versions:
    root = plugins / "cache/t3-pstack/t3-pstack" / version
    for rel in module.REQUIRED_PSTACK_FILES:
        target = root / "skills" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if rel == CHECKER:
            shutil.copy2(checker, target)
        else:
            target.write_text(f"# synthetic {rel} for t3-pstack {version}\n")
    manifest = root / (".codex-plugin" if codex else ".claude-plugin") / "plugin.json"
    manifest.parent.mkdir()
    manifest.write_text(json.dumps({"name": "t3-pstack", "version": version}))
    records.append({"installPath": str(root), "version": version, "gitCommitSha": "a" * 40})
if codex:
    (home / ".codex/config.toml").write_text(
        f'[marketplaces.t3-pstack]\nsource_type = "git"\nsource = "{SOURCE}"\n\n[plugins."t3-pstack@t3-pstack"]\nenabled = true\n')
    clone = home / ".codex/.tmp/marketplaces/t3-pstack"
    (clone / ".claude-plugin").mkdir(parents=True)
    (clone / ".codex-marketplace-install.json").write_text(json.dumps(
        {"source_type": "git", "source": SOURCE, "ref_name": None, "sparse_paths": [], "revision": "b" * 40}))
    (clone / ".claude-plugin/marketplace.json").write_text(json.dumps(
        {"name": "t3-pstack", "plugins": [{"name": "t3-pstack", "source": "./plugins/pstack", "version": versions[-1]}]}))
else:
    (plugins / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {"t3-pstack@t3-pstack": records}}))
