#!/usr/bin/env python3
"""Inventory the v5 case archive without modifying it. See tests/fixtures/README.md.

  python3 scripts/fixtures/inventory.py --extract         extract the archive into the fixture root (size + CRC checked)
  python3 scripts/fixtures/inventory.py                   build the inventory from the zip and write it locally
  python3 scripts/fixtures/inventory.py --source tree     build it from the extracted tree instead (same output)
  python3 scripts/fixtures/inventory.py --verify          build, then check the profile, committed summary and examples

Outputs go to <fixture root>/<name>/inventory/<source>/: inventory.json and examples.json (case-bearing, local),
summary.json (counts and fingerprints only, the committed docs/reference/v5-summary.json) and run.json (the
run envelope: timestamps, timings, source details). Everything except run.json is byte-identical between runs
and between the zip and tree sources.

The main HTML is the profile's pinned main when the archive holds a pinned file, else the one candidate whose
chronology contains every other candidate's refs and has the most rows. An absent pinned main, an unparsable
root HTML or a tie stops the build (exit 2); a variant is never promoted.

Exit codes: 0 success; 1 a verification check failed; 2 bad usage, a missing input or no unambiguous main HTML.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import resource
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from v5fixture import archive, build, examples  # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))
DEFAULT_ROOT = "/home/operator/Work/Active/MX-two/ClearCase/fixtures"
DEFAULT_ARCHIVE = "/home/operator/Work/Active/MX-two/ClearCase/RAWS/CASE_Lawyer_Pack_v5-002.zip"
DEFAULT_PROFILE = os.path.join(HERE, "profiles", "v5-002.json")
DEFAULT_SUMMARY = os.path.join(REPO, "docs", "reference", "v5-summary.json")


def dumps(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=1, sort_keys=False) + "\n").encode("utf-8")


def write(path: str, data: bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def sha256_file(path: str) -> str:
    return archive.file_sha256(path)


class Checks:
    def __init__(self):
        self.rows = []

    def check(self, name: str, ok: bool, detail: str = ""):
        self.rows.append((name, bool(ok), detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))

    @property
    def failed(self):
        return [r for r in self.rows if not r[1]]


def pinned_htmls(profile_path: str):
    """The main and variant HTML sha256 values pinned by the profile; None when the profile is unreadable.
    A pin only applies to an archive that contains one of the pinned files."""
    try:
        with open(profile_path, encoding="utf-8") as fh:
            prof = json.load(fh)
    except (OSError, ValueError):
        return None
    return {"main": prof["mainHtml"]["sha256"], "variants": [v["sha256"] for v in prof.get("variants", [])]}


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--archive", default=os.environ.get("CLEARCASE_FIXTURE_ARCHIVE", DEFAULT_ARCHIVE),
                   help="case archive zip (default $CLEARCASE_FIXTURE_ARCHIVE or the RAWS v5 archive)")
    p.add_argument("--fixture-root", default=os.environ.get("CLEARCASE_FIXTURE_ROOT", DEFAULT_ROOT),
                   help="local fixture root, outside Git (default $CLEARCASE_FIXTURE_ROOT or %(default)s)")
    p.add_argument("--name", default="v5-002", help="fixture name under the root (default %(default)s)")
    p.add_argument("--source", choices=("zip", "tree"), default="zip", help="read the zip or the extracted tree")
    p.add_argument("--tree", help="extracted tree (default <root>/<name>/tree)")
    p.add_argument("--out", help="output directory (default <root>/<name>/inventory/<source>)")
    p.add_argument("--profile", default=DEFAULT_PROFILE, help="expected fingerprints and counts for --verify")
    p.add_argument("--summary", default=DEFAULT_SUMMARY,
                   help="committed summary that --verify compares with; 'none' skips that check and fails --verify")
    p.add_argument("--examples", help="expected examples (default <root>/<name>/expected/expected-examples.json)")
    p.add_argument("--extract", action="store_true", help="extract the archive into the tree first")
    p.add_argument("--verify", action="store_true", help="check the build against the profile, summary and examples")
    p.add_argument("--write-summary", action="store_true", help="write the summary to --summary (maintainers only)")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    started = time.time()
    t0 = time.perf_counter()
    fixture = os.path.join(args.fixture_root, args.name)
    tree = args.tree or os.path.join(fixture, "tree")
    out = args.out or os.path.join(fixture, "inventory", args.source)
    examples_path = args.examples or os.path.join(fixture, "expected", "expected-examples.json")
    run = {"schema": "clearcase-v5-run/1", "argv": sys.argv[1:] if argv is None else argv, "source": args.source,
           "startedAt": dt.datetime.fromtimestamp(started, dt.timezone.utc).isoformat()}

    if args.source == "zip" or args.extract:
        if not os.path.isfile(args.archive):
            print(f"error: archive not found: {args.archive}", file=sys.stderr)
            return 2
    if args.extract:
        zsrc = archive.ZipSource(args.archive)
        if zsrc.unsafe:
            for u in zsrc.unsafe:
                print(f"unsafe entry skipped: {u['reason']}", file=sys.stderr)
        result = archive.extract(zsrc, tree)
        zsrc.close()
        run["extract"] = {"tree": tree, **result}
        print(f"extracted into {tree}: {json.dumps(result)}")
        if zsrc.unsafe:
            return 1

    if args.source == "zip":
        src = archive.ZipSource(args.archive)
        run["archive"] = {"path": args.archive, "size": os.path.getsize(args.archive)}
        run["zipNames"] = {"utf8WithoutFlag": sum(1 for e in src.entries if e.name_encoding == "utf8-unflagged"),
                           "cp437": sum(1 for e in src.entries if e.name_encoding == "cp437"),
                           "directories": src.directories}
    else:
        if not os.path.isdir(tree):
            print(f"error: extracted tree not found: {tree} (run with --extract first)", file=sys.stderr)
            return 2
        src = archive.TreeSource(tree)
        run["tree"] = {"path": tree, "directories": src.directories}
    t_read = time.perf_counter()
    try:
        inventory, summary = build.build(src, pinned_htmls(args.profile))
    except build.MainHtmlError as exc:
        print(f"error: cannot choose the main HTML: {exc}", file=sys.stderr)
        return 2
    t_build = time.perf_counter()

    checks = Checks()
    example_results = None
    if args.verify:
        verify(args, src, inventory, summary, checks, run, examples_path)
        example_results = run.pop("_exampleResults", None)
    t_verify = time.perf_counter()

    write(os.path.join(out, "inventory.json"), dumps(inventory))
    write(os.path.join(out, "summary.json"), dumps(summary))
    if example_results is not None:
        write(os.path.join(out, "examples.json"), dumps(example_results))
    if args.write_summary:
        write(args.summary, dumps(summary))
        print(f"wrote {args.summary}")
    src.close()

    usage = resource.getrusage(resource.RUSAGE_SELF)
    run.update({
        "finishedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "seconds": {"open": round(t_read - t0, 3), "build": round(t_build - t_read, 3),
                    "verify": round(t_verify - t_build, 3), "total": round(time.perf_counter() - t0, 3)},
        "peakRssKiB": usage.ru_maxrss,
        "machine": {"host": platform.node(), "system": platform.system(), "release": platform.release(),
                    "python": platform.python_version(), "cpus": os.cpu_count()},
        "outputs": {n: sha256_file(os.path.join(out, n))
                    for n in sorted(os.listdir(out)) if n.endswith(".json") and n != "run.json"},
        "checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in checks.rows],
    })
    write(os.path.join(out, "run.json"), dumps(run))
    s = summary
    print(f"inventory: {s['files']['count']} files, main HTML {s['mainHtml']['sha256'][:12]} built "
          f"{s['meta']['builtAt']}, {s['mainHtml']['chronologyRows']} chronology rows, {s['nav']['entries']} nav "
          f"entries, {s['missing']['total']} missing links, outputs in {out}")
    print(f"elapsed {run['seconds']['total']}s, peak RSS {usage.ru_maxrss} KiB")
    if args.verify:
        if checks.failed:
            print(f"verify: FAIL ({len(checks.failed)} of {len(checks.rows)} checks failed)")
            return 1
        print(f"verify: PASS ({len(checks.rows)} checks)")
    return 0


def verify(args, src, inventory, summary, checks, run, examples_path):
    try:
        with open(args.profile, encoding="utf-8") as fh:
            prof = json.load(fh)
    except OSError as exc:
        checks.check("profile readable", False, str(exc))
        return
    if args.source == "zip":
        a = prof["archive"]
        digest = sha256_file(args.archive)
        run["archive"]["sha256"] = digest
        checks.check("archive sha256", digest == a["sha256"], digest)
        checks.check("archive size", os.path.getsize(args.archive) == a["size"], str(os.path.getsize(args.archive)))
        entries = len(src.entries) + src.directories + len(src.unsafe)
        checks.check("archive entries", entries == a["entries"], str(entries))
    m, pm = summary["mainHtml"], prof["mainHtml"]
    main_path = next(c["path"] for c in inventory["html"]["candidates"] if c["role"] == "main")
    checks.check("main HTML is the pinned main", main_path == pm["path"], "role main")
    for key in ("sha256", "size", "builtAt", "docCount", "chronologyRows", "navEntries"):
        checks.check(f"main HTML {key}", m[key] == pm[key], str(m[key]))
    checks.check("META.docCount equals chronology rows", m["docCount"] == m["chronologyRows"], str(m["docCount"]))
    checks.check("nav groups", summary["nav"]["groups"] == pm["navGroups"], str(summary["nav"]["groups"]))
    for vp in prof.get("variants", []):
        cand = next((c for c in inventory["html"]["candidates"] if c["sha256"] == vp["sha256"]), None)
        checks.check(f"variant {vp['label']} present with role variant",
                     bool(cand and cand["role"] == "variant" and cand["docCount"] == vp["docCount"]),
                     f"docCount {cand and cand['docCount']}")
    checks.check("no unsafe archive entries", not inventory["unsafeEntries"], str(len(inventory["unsafeEntries"])))
    checks.check("every link resolves", summary["missing"]["total"] == prof["missingLinks"],
                 f"{summary['missing']['total']} missing")
    checks.check("no duplicate chronology refs", summary["duplicates"]["chronologyRefs"] == [],
                 str(len(summary["duplicates"]["chronologyRefs"])))
    checks.check("every chronology row has a ref", summary["duplicates"]["chronologyRowsWithoutRef"] == 0,
                 str(summary["duplicates"]["chronologyRowsWithoutRef"]))
    checks.check("42 views have a live renderer", summary["views"]["defined"] == pm["navEntries"],
                 f"{summary['views']['defined']} of {summary['views']['count']}")
    if args.summary == "none":
        checks.check("committed summary compared", False, "--summary none")
    elif os.path.isfile(args.summary) and not args.write_summary:
        with open(args.summary, "rb") as fh:
            committed = fh.read()
        checks.check("summary matches the committed summary", committed == dumps(summary), args.summary)
    elif not args.write_summary:
        checks.check("committed summary present", False, args.summary)
    # examples
    try:
        with open(examples_path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        checks.check("expected examples readable", False, str(exc))
        return
    digest = hashlib.sha256(raw).hexdigest()
    checks.check("expected examples sha256", digest == prof["expectedExamplesSha256"], digest)
    spec = json.loads(raw)
    files = build.FileIndex(src.entries, src.unsafe)
    ws, _info = build.analyse_html(src.read(main_path), main_path)
    results = []
    for ex in spec["examples"]:
        got, rewrite = examples.evaluate(ex, ws, files, src)
        ok = got == ex["expect"]["source"] and (rewrite is None or rewrite == ex["expect"].get("rewrite"))
        results.append({"key": ex["key"], "kind": ex["kind"], "ok": ok, "source": got, "rewrite": rewrite})
        checks.check(f"example {ex['key']}", ok)
    run["_exampleResults"] = {"schema": "clearcase-v5-example-results/1", "expectedSha256": digest, "results": results}


if __name__ == "__main__":
    sys.exit(main())
