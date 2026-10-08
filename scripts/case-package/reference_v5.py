#!/usr/bin/env python3
"""Independent reference extraction of a v5 workspace HTML for verification lane 1.

Uses GRS-9's reader (scripts/fixtures/v5fixture/html.py: regex line match + Python's json with
duplicate-key and constant rejection), not the TypeScript adapter, and writes each root in the
canonical file encoding (scripts/case-package/canonical.py). Nothing in the HTML is executed.

usage: python3 -I reference_v5.py WORKSPACE.html OUT_DIR
writes OUT_DIR/DATA.json, META.json, window.__SCHED__.json, window.__CASELINES_IDX__.json
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "fixtures"))
sys.path.insert(0, HERE)

from v5fixture import html as v5html  # noqa: E402
import canonical  # noqa: E402


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    with open(argv[0], "rb") as f:
        ws = v5html.parse(f.read())
    os.makedirs(argv[1], exist_ok=True)
    for name, value in ws.datasets.items():
        with open(os.path.join(argv[1], name + ".json"), "wb") as out:
            out.write(canonical.canonical(value, True).encode("utf-8"))
    print("reference roots: " + ", ".join(sorted(ws.datasets)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
