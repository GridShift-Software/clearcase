#!/usr/bin/env python3
"""Measure `inventory.py --verify` elapsed time and peak memory over repeated runs.

  python3 scripts/fixtures/perf.py [--runs 7] [--baseline-median SECONDS] [-- extra inventory.py args]

Each run is a fresh process. Elapsed is wall time of the whole process; peak RSS is the child's maximum
resident set (resource.getrusage of the waited child). Prints a JSON summary with median and p95 (nearest
rank). With --baseline-median it exits 1 when the median exceeds 1.25 times that baseline. Exit 1 also when
any run fails.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def p95(values):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=7)
    ap.add_argument("--baseline-median", type=float)
    ap.add_argument("rest", nargs="*")
    args = ap.parse_args(argv)
    cmd = [sys.executable, os.path.join(HERE, "inventory.py"), "--verify", *args.rest]
    runs = []
    for i in range(args.runs):
        t0 = time.perf_counter()
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _pid, status, usage = os.wait4(proc.pid, 0)
        elapsed = time.perf_counter() - t0
        code = os.waitstatus_to_exitcode(status)
        runs.append({"run": i + 1, "exit": code, "seconds": round(elapsed, 3), "peakRssKiB": usage.ru_maxrss})
        print(json.dumps(runs[-1]), flush=True)
    secs = [r["seconds"] for r in runs]
    rss = [r["peakRssKiB"] for r in runs]
    out = {
        "command": cmd[1:], "runs": len(runs), "failedRuns": sum(1 for r in runs if r["exit"] != 0),
        "seconds": {"median": round(statistics.median(secs), 3), "p95": p95(secs), "min": min(secs), "max": max(secs)},
        "peakRssKiB": {"median": int(statistics.median(rss)), "p95": p95(rss), "max": max(rss)},
        "machine": {"host": platform.node(), "kernel": platform.release(), "python": platform.python_version(),
                    "cpus": os.cpu_count()},
    }
    if args.baseline_median:
        limit = round(1.25 * args.baseline_median, 3)
        out["rule"] = {"baselineMedian": args.baseline_median, "limit": limit, "pass": out["seconds"]["median"] <= limit}
    print(json.dumps(out, indent=1))
    if out["failedRuns"] or (args.baseline_median and not out["rule"]["pass"]):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
