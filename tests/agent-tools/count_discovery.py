"""Exit nonzero unless one capability run discovers the pstack plugin exactly once.

Usage: HOME=... python3 -I -B count_discovery.py RECEIPTS_DIR
The receipt's pstack identity must come from the discovery whose paths were fingerprinted, not from a second call.
"""

import argparse
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "agent_tools", Path(__file__).resolve().parents[2] / "scripts/agent-tools/agent_tools.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = []
real = module.pstack_source
module.pstack_source = lambda *a, **k: calls.append(1) or real(*a, **k)
args = argparse.Namespace(root=None, skills_dir=None, receipts=sys.argv[1], base=None, plan=None, readback=None,
                          actual_usd=None, actual_source=None, target_usd=None)
code = module.run_capability("pstack", args)
sys.exit(f"pstack discovered {len(calls)} times, expected 1 (exit {code})" if len(calls) != 1 else 0)
