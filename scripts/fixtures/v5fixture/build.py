"""Build the deterministic inventory of a v5 case archive from a ZipSource or TreeSource.

`build()` returns two payloads. `inventory` is case-bearing (paths, refs and META values) and stays in
the local fixture root. `summary` holds only counts, fingerprints, key and field names, nav ids and
opaque ref IDs, so it can be committed. Neither contains timestamps or anything that depends on
whether the input was the zip or the extracted tree.
"""
from __future__ import annotations

import collections
import posixpath
import re
import unicodedata
import urllib.parse

from . import html as htmlmod
from . import views as viewsmod

SCHEMA = "clearcase-v5-inventory/1"
SUMMARY_SCHEMA = "clearcase-v5-summary/1"
LINK_KEYS = {"url", "headline_url", "sliceUrl"}
# Keys of court-bundle items: discovery-schedule item numbers such as OD-10, a different namespace from
# chronology refs such as OD-010. Reported separately, never resolved as citations.
BUNDLE_KEY_FIELDS = {"DATA.bundles.list[].items[]", "DATA.bundles.list[].rows[].key", "DATA.bundles.catalogue{*}.key"}
# Free text that may start with "./" by accident, such as CaseLines page text.
TEXT_FIELDS = ("window.__CASELINES_IDX__.index",)
CODE_LINK = re.compile(r"['\"](\.{1,2}/[^'\"\s]+)['\"]")
REF_RE = re.compile(r"^[A-Z]{2,4}-[0-9]{1,5}[A-Za-z]?$")
SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
# A Windows drive letter: WHATWG URL parsing treats 'C|' like 'C:' (file:///C:/...), outside the case folder.
DRIVE_RE = re.compile(r"^[A-Za-z][:|]")
OK_STATUSES = ("ok", "directory")
# WHATWG URL parsing: strip leading/trailing C0 control or space, then remove ASCII tab or newline anywhere.
C0_OR_SPACE = "".join(map(chr, range(0x21)))
URL_TAB_NEWLINE = re.compile("[\t\n\r]")


def field_path(parent: str, key) -> str:
    if isinstance(key, int):
        return parent + "[]"
    if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", key):
        return f"{parent}.{key}"
    return parent + "{*}"


def walk(value, path: str, parent=None, key=None):
    """Yield (path, key, value, parent object) for every scalar in a JSON value, in document order."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield from walk(v, field_path(path, k), value, k)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from walk(v, field_path(path, i), parent if isinstance(v, (str, int, float)) else value, key)
    else:
        yield path, key, value, parent


class FileIndex:
    def __init__(self, entries, unsafe):
        self.by_path = {e.path: e for e in entries}
        self.unsafe = {u["path"] for u in unsafe}
        self.dirs = set()
        for p in self.by_path:
            parts = p.split("/")
            for i in range(1, len(parts)):
                self.dirs.add("/".join(parts[:i]))
        self.folded = collections.defaultdict(list)
        for p in self.by_path:
            self.folded[unicodedata.normalize("NFC", p).casefold()].append(p)

    def resolve(self, value: str) -> dict:
        """Resolve a link value the way a browser resolves a relative href against the HTML's folder.

        Like the WHATWG URL parser, first strip leading and trailing C0 controls and spaces and remove every
        tab, LF and CR, so ' /etc/x.pdf' or '\t/etc/x.pdf' is judged as the absolute path a browser opens. A
        leading drive letter, including the 'C|/x' form a browser reads as 'C:/x', escapes the folder."""
        out = {"value": value, "path": None, "status": None}
        value = URL_TAB_NEWLINE.sub("", value.strip(C0_OR_SPACE))
        if SCHEME_RE.match(value):
            out["status"] = "external-scheme"
            return out
        raw = value.split("#", 1)[0].split("?", 1)[0]
        if raw.startswith("/") or raw.startswith("\\") or DRIVE_RE.match(raw):
            out["status"] = "escapes"
            return out
        try:
            decoded = urllib.parse.unquote(raw, errors="strict")
        except UnicodeDecodeError:
            out["status"] = "bad-encoding"
            return out
        if "\\" in decoded or "\x00" in decoded:
            out["status"] = "unsafe"
            return out
        parts = [p for p in decoded.split("/") if p not in ("", ".")]
        if ".." in parts:
            out["status"] = "escapes"
            return out
        path = "/".join(parts)
        out["path"] = path
        if not path:
            out["status"] = "directory"
        elif path in self.by_path:
            out["status"] = "ok"
        elif path in self.unsafe:
            out["status"] = "unsafe-target"
        elif path in self.dirs:
            out["status"] = "directory"
        elif self.folded.get(unicodedata.normalize("NFC", path).casefold()):
            out["status"] = "case-or-normalization-mismatch"
        else:
            out["status"] = "missing"
        return out


def _count_kinds(value):
    if isinstance(value, list):
        return {"kind": "array", "count": len(value)}
    if isinstance(value, dict):
        return {"kind": "object", "count": len(value)}
    return {"kind": type(value).__name__}


def field_names(value, root: str) -> dict:
    """Map each dataset's field paths to how many scalar values they hold (names only, no values)."""
    counts = collections.Counter(path for path, _k, _v, _p in walk(value, root))
    return dict(sorted(counts.items()))


def analyse_html(raw: bytes, path: str) -> tuple[htmlmod.Workspace, dict]:
    ws = htmlmod.parse(raw)
    chron = ws.data.get("chronology", [])
    info = {
        "path": path,
        "sha256": ws.sha256,
        "size": ws.size,
        "lines": ws.lines,
        "codeSha256": ws.code_sha256,
        "builtAt": ws.meta.get("builtAt"),
        "docCount": ws.meta.get("docCount"),
        "chronologyRows": len(chron),
        "navEntries": len(ws.nav()),
        "metaBundles": sorted((ws.meta.get("bundles") or {}).keys()),
        "datasetLines": ws.dataset_lines,
        "datasetSha256": {k: htmlmod.canonical_sha256(v) for k, v in sorted(ws.datasets.items())},
        "dataKeySha256": {k: htmlmod.canonical_sha256(v) for k, v in sorted(ws.data.items())},
    }
    return ws, info


class MainHtmlError(ValueError):
    """The main HTML cannot be chosen: it is absent, unreadable or not unique by content."""


def choose_main(cands: list[tuple[htmlmod.Workspace, dict]], errors=(), pinned=None):
    """Return the index of the main HTML in `cands`.

    With a pinned profile (`{"main": sha256, "variants": [sha256, ...]}`) the candidate with the pinned sha256
    is main; if the archive holds a pinned variant but not the pinned main, the main is absent and no variant
    is promoted. Otherwise the main is chosen by content: the one candidate whose chronology refs include every
    other candidate's refs and which has the most rows. Build dates and file names never decide. A root HTML
    that cannot be parsed, a tie or two candidates with unrelated refs is ambiguous and raises MainHtmlError."""
    if not cands:
        raise MainHtmlError("no readable workspace HTML at the archive root"
                            + (f" ({len(errors)} could not be parsed)" if errors else ""))
    shas = [info["sha256"] for _ws, info in cands]
    if pinned:
        if pinned.get("main") in shas:
            return shas.index(pinned["main"]), "pinned"
        if any(v in shas for v in pinned.get("variants", [])):
            raise MainHtmlError("the pinned main HTML is absent; refusing to promote the pinned variant")
    if errors:
        raise MainHtmlError(f"{len(errors)} root HTML file(s) could not be parsed, so the main HTML is ambiguous")
    refsets = [{r.get("ref") for r in ws.data.get("chronology", []) if r.get("ref")} for ws, _info in cands]
    rows = [info["chronologyRows"] for _ws, info in cands]
    best = [i for i in range(len(cands)) if all(refsets[j] <= refsets[i] for j in range(len(cands)))
            and rows[i] == max(rows)]
    if len(best) != 1:
        raise MainHtmlError(f"{len(best) or 'no'} candidates have the largest complete chronology; main HTML is ambiguous: "
                            + ", ".join(f"{info['sha256'][:12]} ({info['chronologyRows']} rows)" for _ws, info in cands))
    return best[0], "content"


def classify_variants(cands: list[tuple[htmlmod.Workspace, dict]], errors=(), pinned=None):
    """Pick the main HTML (see choose_main) and describe how every other candidate differs from it."""
    i, rule = choose_main(cands, errors, pinned)
    main_ws, main = cands[i]
    ordered = [c for j, c in enumerate(cands) if j != i] + [cands[i]]
    main["selection"] = rule
    main["role"] = "main"
    main_refs = [r.get("ref") for r in main_ws.data.get("chronology", []) if r.get("ref")]
    diffs = []
    for ws, info in ordered[:-1]:
        info["role"] = "variant"
        refs = [r.get("ref") for r in ws.data.get("chronology", []) if r.get("ref")]
        only_main = sorted(set(main_refs) - set(refs))
        diffs.append({
            "variant": info["path"],
            "sameAppCode": info["codeSha256"] == main["codeSha256"],
            "builtAtEarlier": str(info["builtAt"]) < str(main["builtAt"]) if info["builtAt"] and main["builtAt"] else None,
            "docCount": [main["docCount"], info["docCount"]],
            "chronologyRows": [main["chronologyRows"], info["chronologyRows"]],
            "refsOnlyInMain": len(only_main),
            "refsOnlyInVariant": len(set(refs) - set(main_refs)),
            "refPrefixesOnlyInMain": dict(sorted(collections.Counter(r.split("-")[0] for r in only_main).items())),
            "commonRefOrderPreserved": [r for r in main_refs if r in set(refs)] == [r for r in refs if r in set(main_refs)],
            "metaBundlesOnlyInMain": sorted(set(main["metaBundles"]) - set(info["metaBundles"])),
            "differingDatasets": sorted(k for k in main["datasetSha256"] if info["datasetSha256"].get(k) != main["datasetSha256"][k]),
            "differingDataKeys": sorted(k for k in main["dataKeySha256"] if info["dataKeySha256"].get(k) != main["dataKeySha256"][k]),
            "arrayLengths": {k: [len(main_ws.data[k]) if isinstance(main_ws.data[k], list) else None,
                                 len(ws.data[k]) if isinstance(ws.data.get(k), list) else None]
                             for k in sorted(main_ws.data) if main["dataKeySha256"][k] != info["dataKeySha256"].get(k)},
        })
    return main_ws, [c[1] for c in sorted(cands, key=lambda c: c[1]["path"])], diffs


def build(source, pinned=None) -> tuple[dict, dict]:
    """`pinned` is {"main": sha256, "variants": [sha256, ...]} from a fixture profile, or None."""
    files = FileIndex(source.entries, source.unsafe)
    root_html = [e.path for e in source.entries if "/" not in e.path and e.path.lower().endswith((".html", ".htm"))]
    cands = []
    errors = []
    for p in root_html:
        try:
            cands.append(analyse_html(source.read(p), p))
        except htmlmod.HtmlDataError as exc:
            errors.append({"path": p, "error": str(exc)})
    ws, html_infos, variant_diffs = classify_variants(cands, errors, pinned)
    data, meta = ws.data, ws.meta
    chron = data.get("chronology", [])
    nav = ws.nav()

    # chronology refs -> originals; rows without a ref are reported, never grouped as one duplicate ref
    ref_rows = collections.defaultdict(list)
    refless_rows = []
    for row in chron:
        if row.get("ref"):
            ref_rows[row["ref"]].append(row)
        else:
            refless_rows.append(row.get("n"))
    chron_url = {r["ref"]: r.get("url") for r in chron if r.get("ref")}
    ref_inventory = []
    for row in chron:
        res = files.resolve(row.get("url") or "")
        entry = files.by_path.get(res["path"] or "")
        ref_inventory.append({
            "n": row.get("n"), "ref": row.get("ref"), "bundle": row.get("bundle"), "docType": row.get("doc_type"),
            "textStatus": row.get("text_status"), "url": row.get("url"), "path": res["path"], "status": res["status"],
            "size": entry.size if entry else None, "crc32": f"{entry.crc32:08x}" if entry else None,
            "attachmentNames": len(row.get("attachments") or []),
        })

    # every link field in every dataset
    links = collections.OrderedDict()
    missing = []
    url_mismatch = []
    referenced = set()
    citations = collections.OrderedDict()
    bundle_keys = collections.OrderedDict()
    for name in sorted(ws.datasets):
        for path, key, value, parent in walk(ws.datasets[name], name):
            if not isinstance(value, str) or not value:
                continue
            if key in LINK_KEYS or (value.startswith(("./", "../")) and not path.startswith(TEXT_FIELDS)):
                res = files.resolve(value)
                stat = links.setdefault(path, collections.Counter())
                stat["total"] += 1
                stat[res["status"]] += 1
                if res["status"] == "ok":
                    referenced.add(res["path"])
                elif res["status"] != "directory":
                    missing.append({"field": path, "ref": (parent or {}).get("ref") if isinstance(parent, dict) else None,
                                    "value": value, "path": res["path"], "status": res["status"]})
                parent_ref = parent.get("ref") if isinstance(parent, dict) else None
                if key == "url" and parent_ref and parent_ref in chron_url \
                        and not path.startswith("DATA.chronology") and chron_url[parent_ref] != value:
                    url_mismatch.append({"field": path, "ref": parent_ref})
            elif REF_RE.match(value) and path in BUNDLE_KEY_FIELDS:
                stat = bundle_keys.setdefault(path, collections.Counter())
                stat["total"] += 1
                stat["equalsChronologyRef" if value in ref_rows else "otherNamespace"] += 1
            elif REF_RE.match(value) and path != "DATA.chronology[].ref":
                stat = citations.setdefault(path, collections.Counter())
                stat["total"] += 1
                stat["resolved" if value in ref_rows else "unresolved"] += 1
    unresolved_refs = collections.Counter()
    for name in sorted(ws.datasets):
        for path, key, value, parent in walk(ws.datasets[name], name):
            if isinstance(value, str) and REF_RE.match(value) and path != "DATA.chronology[].ref" \
                    and path not in BUNDLE_KEY_FIELDS and value not in ref_rows:
                unresolved_refs[(path, value)] += 1

    # links hard-coded in app code (outside the data lines)
    code_links = []
    for m in CODE_LINK.finditer(ws.code):
        res = files.resolve(m.group(1))
        code_links.append({"line": ws.code.count("\n", 0, m.start()) + 1, "value": m.group(1), "path": res["path"],
                           "status": res["status"]})
        if res["status"] == "ok":
            referenced.add(res["path"])
        elif res["status"] != "directory":
            missing.append({"field": "code", "ref": None, "value": m.group(1), "path": res["path"], "status": res["status"]})

    # duplicates; a row without a ref is only reported in chronologyRowsWithoutRef, never as a ref sharing a target
    dup_refs = sorted((ref, [r.get("n") for r in rows]) for ref, rows in ref_rows.items() if len(rows) > 1)
    by_target = collections.defaultdict(list)
    for item in ref_inventory:
        if item["status"] == "ok" and item["ref"]:
            by_target[item["path"]].append(item["ref"])
    shared_targets = sorted((p, refs) for p, refs in by_target.items() if len(refs) > 1)
    by_content = collections.defaultdict(list)
    for e in source.entries:
        if e.size > 0:
            by_content[(e.size, e.crc32)].append(e.path)
    content_dups = sorted(sorted(paths) for paths in by_content.values() if len(paths) > 1)
    by_base = collections.defaultdict(list)
    for e in source.entries:
        by_base[posixpath.basename(e.path)].append(e.path)
    basename_dups = sorted((b, sorted(ps)) for b, ps in by_base.items() if len(ps) > 1)
    fold_collisions = sorted(sorted(ps) for ps in files.folded.values() if len(ps) > 1)
    non_nfc = sorted(e.path for e in source.entries if not unicodedata.is_normalized("NFC", e.path))
    non_ascii = sorted(e.path for e in source.entries if not e.path.isascii())
    with_space = sum(1 for e in source.entries if " " in e.path)
    unreferenced = sorted(p for p in files.by_path if p not in referenced and p not in root_html)

    view_info = viewsmod.analyse(ws)

    link_stats = {k: dict(sorted(v.items())) for k, v in links.items()}
    citation_stats = {k: dict(sorted(v.items())) for k, v in citations.items()}
    status_totals = collections.Counter()
    for v in links.values():
        for k, n in v.items():
            if k != "total":
                status_totals[k] += n
    top_folders = collections.Counter(e.path.split("/", 1)[0] if "/" in e.path else "(root)" for e in source.entries)

    inventory = {
        "schema": SCHEMA,
        "files": {"count": len(source.entries), "bytes": sum(e.size for e in source.entries),
                  "entries": [{"path": e.path, "size": e.size, "crc32": f"{e.crc32:08x}"} for e in source.entries]},
        "unsafeEntries": source.unsafe,
        "html": {"candidates": html_infos, "variantDiffs": variant_diffs, "errors": errors},
        "meta": meta,
        "nav": nav,
        "refs": ref_inventory,
        "links": link_stats,
        "missing": missing,
        "urlMismatches": url_mismatch,
        "citations": citation_stats,
        "bundleItemKeys": {k: dict(sorted(v.items())) for k, v in bundle_keys.items()},
        "codeLinks": code_links,
        "unresolvedRefs": [{"field": f, "ref": r, "count": n} for (f, r), n in sorted(unresolved_refs.items())],
        "duplicates": {
            "chronologyRefs": [{"ref": r, "rows": ns} for r, ns in dup_refs],
            "chronologyRowsWithoutRef": refless_rows,
            "targetsSharedByRefs": [{"path": p, "refs": rs} for p, rs in shared_targets],
            "sameSizeAndCrc32": content_dups,
            "sameBasename": [{"name": b, "paths": ps} for b, ps in basename_dups],
            "caseFoldCollisions": fold_collisions,
        },
        "names": {"nonAscii": non_ascii, "nonNfc": non_nfc},
        "unreferencedFiles": unreferenced,
        "views": view_info,
    }

    main = next(c for c in html_infos if c.get("role") == "main")
    summary = {
        "schema": SUMMARY_SCHEMA,
        "files": {"count": len(source.entries), "bytes": sum(e.size for e in source.entries),
                  "topLevelFolders": len(top_folders) - (1 if "(root)" in top_folders else 0),
                  "rootFiles": top_folders.get("(root)", 0),
                  "unsafeEntries": len(source.unsafe), "nonAsciiNames": len(non_ascii), "nonNfcNames": len(non_nfc),
                  "namesWithSpaces": with_space, "unreferencedFiles": len(unreferenced)},
        "mainHtml": {k: main[k] for k in ("sha256", "size", "lines", "codeSha256", "builtAt", "docCount",
                                         "chronologyRows", "navEntries", "datasetLines")},
        "htmlCandidates": [{k: c[k] for k in ("sha256", "size", "role", "docCount", "chronologyRows", "codeSha256")}
                           for c in html_infos],
        "variantDiffs": [{k: v for k, v in d.items() if k != "variant"} for d in variant_diffs],
        "meta": {"keys": list(meta), "docCount": meta.get("docCount"), "builtAt": meta.get("builtAt"),
                 "bundles": meta.get("bundles"), "docTypeCount": len(meta.get("docTypes") or {}),
                 "textNone": meta.get("textNone"), "textPending": meta.get("textPending"), "emails": meta.get("emails"),
                 "people": meta.get("people")},
        "derivedCounts": {
            "chronologyByBundle": dict(sorted(collections.Counter(r.get("bundle") for r in chron).items())),
            "chronologyByRefPrefix": dict(sorted(collections.Counter((r.get("ref") or "").split("-")[0] for r in chron).items())),
            "chronologyByTextStatus": dict(sorted(collections.Counter(r.get("text_status") for r in chron).items())),
            "chronologyEmailRows": sum(1 for r in chron if r.get("doc_type") == "email"),
            "chronologyWithDate": sum(1 for r in chron if r.get("date")),
            "attachmentNames": sum(len(r.get("attachments") or []) for r in chron),
        },
        "nav": {"entries": len(nav), "groups": len(ws.literals["NAV"]),
                "items": [{"group": n["group"], "id": n["id"], "label": n["label"]} for n in nav]},
        "codeLiterals": {k: len(v) for k, v in sorted(ws.literals.items())},
        "storeKeys": ws.literals.get("STORE_KEYS", []),
        "datasets": {name: _count_kinds(v) for name, v in sorted(ws.datasets.items())},
        "dataKeys": {k: _count_kinds(v) for k, v in data.items()},
        "fields": {name: field_names(v, name) for name, v in sorted(ws.datasets.items()) if name != "window.__CASELINES_IDX__"},
        "links": link_stats,
        "linkStatusTotals": dict(sorted(status_totals.items())),
        "citations": citation_stats,
        "bundleItemKeys": {k: dict(sorted(v.items())) for k, v in bundle_keys.items()},
        "codeLinks": dict(sorted(collections.Counter(c["status"] for c in code_links).items())),
        "unresolvedRefPrefixes": dict(sorted(collections.Counter(r.split("-")[0] for (_f, r) in unresolved_refs).items())),
        "urlMismatches": len(url_mismatch),
        "missing": {"total": len(missing),
                    "byField": dict(sorted(collections.Counter(m["field"] for m in missing).items())),
                    "byStatus": dict(sorted(collections.Counter(m["status"] for m in missing).items()))},
        "duplicates": {
            "chronologyRefs": [d["ref"] for d in inventory["duplicates"]["chronologyRefs"]],
            "chronologyRowsWithoutRef": len(refless_rows),
            "targetsSharedByRefs": len(shared_targets),
            "sameSizeAndCrc32Groups": len(content_dups),
            "sameSizeAndCrc32Files": sum(len(g) for g in content_dups),
            "sameBasenameGroups": len(basename_dups),
            "caseFoldCollisions": len(fold_collisions),
        },
        "views": viewsmod.summarise(view_info),
    }
    return inventory, summary
