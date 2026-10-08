"""Python ports of the v5 behaviors that the literal expected examples check, and the example evaluator.

Each port follows the v5 code it names (line numbers refer to the v5 main HTML). The evaluator recomputes
every example in the local expected-examples file and compares it with the frozen expectation. Example
kinds: chronology-filter, citation, interest, prescription, deadline, ledger, deadline-ledger.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import math
import zlib

CHUNK = 1 << 20


# --- formatting (v5 lines 182-185) -------------------------------------------------------------------------

def fmt_r(n: float) -> str:
    """fmtR: 'R ' + integer part grouped by spaces + '.' + 2 decimals; negative values get a leading '-'."""
    if not math.isfinite(n):
        return ""
    neg = n < 0
    i, d = f"{abs(n):.2f}".split(".")
    groups = []
    while len(i) > 3:
        groups.insert(0, i[-3:])
        i = i[:-3]
    groups.insert(0, i)
    return ("-" if neg else "") + "R " + " ".join(groups) + "." + d


# --- chronology filter (v5 chronFiltered, lines 419-426) -----------------------------------------------------

def chronology_filter(rows, bundle="", doc_type="", status="", q="", sort="date", direction=1):
    a = list(rows)
    if bundle:
        a = [r for r in a if r.get("bundle") == bundle]
    if doc_type:
        a = [r for r in a if r.get("doc_type") == doc_type]
    if status:
        a = [r for r in a if r.get("text_status") == status]
    if q:
        ql = q.lower()
        a = [r for r in a if " ".join([str(r.get("filename")), str(r.get("ref")), r.get("subject") or "",
                                       r.get("sender") or "", r.get("excerpt") or ""]).lower().find(ql) >= 0]

    def key(r):
        v = r.get(sort) or ""
        if sort == "amount":
            try:
                v = float(v) if v != "" else 0.0
            except ValueError:
                v = 0.0
        return v
    # JS Array.prototype.sort is stable, as is Python's sort; descending keeps ties in input order too.
    return sorted(a, key=key, reverse=False) if direction > 0 else _stable_desc(a, key)


def _stable_desc(a, key):
    indexed = list(enumerate(a))
    indexed.sort(key=lambda p: (_neg(key(p[1])), p[0]))
    return [r for _i, r in indexed]


class _neg:
    def __init__(self, v):
        self.v = v

    def __lt__(self, other):
        return self.v > other.v

    def __eq__(self, other):
        return self.v == other.v


CHRONOLOGY_BUNDLE_OPTIONS = ["", "Original", "Supplementary", "Correspondence", "Pleadings"]  # v5 line 413


# --- deadlines (v5 daysUntil line 186, drawDeadlines lines 643-648, delDeadline line 652) ---------------------

def days_until(date: str, today: dt.date):
    """daysUntil with a fixed local date: whole days from today's midnight to the date's midnight."""
    if not date:
        return None
    return (dt.date.fromisoformat(date) - today).days


def countdown(date: str, today: dt.date) -> dict:
    du = days_until(date, today)
    if du is None:
        return {"text": "—", "badge": "b-mut"}
    if du < 0:
        return {"text": f"{-du}d ago", "badge": "b-mut"}
    if du == 0:
        return {"text": "today", "badge": "b-dang"}
    if du <= 7:
        return {"text": f"in {du}d", "badge": "b-warn"}
    return {"text": f"in {du}d", "badge": "b-ok"}


def deadline_table(store: list, today: dt.date) -> list:
    rows = sorted(store, key=lambda d: d.get("date") or "")
    return [{"date": d.get("date") or "—", "title": d.get("title"), **countdown(d.get("date"), today)} for d in rows]


def deadline_delete_source(store: list, shown_index: int) -> list:
    """v5: the Delete button carries the index of the date-sorted row, but delDeadline splices the stored,
    unsorted array at that index."""
    out = list(store)
    del out[shown_index]
    return out


def deadline_delete_rewrite(store: list, shown_index: int) -> list:
    shown = sorted(range(len(store)), key=lambda i: store[i].get("date") or "")
    out = list(store)
    del out[shown[shown_index]]
    return out


# --- registers built by ledgerTab (lines 588-615) ------------------------------------------------------------

def ledger_apply(fields: list, ops: list) -> list:
    """ledgerAdd stores {field: input value} for every field when at least one is non-empty (all values are
    strings); ledgerDel splices the stored array at the shown index (the table is not sorted)."""
    store: list = []
    for op in ops:
        if op["op"] == "add":
            row = {k: str(op["values"].get(k, "")) for k in fields}
            if any(row.values()):
                store.append(row)
        elif op["op"] == "delete":
            del store[op["index"]]
        else:
            raise ValueError(f"unknown ledger op {op['op']!r}")
    return store


# --- interest calculator (calcInterest, lines 2946-2959) ------------------------------------------------------

def interest(capital: float, rate: float, method: str, date_from: str, date_to: str) -> dict:
    days = (dt.date.fromisoformat(date_to) - dt.date.fromisoformat(date_from)).days
    years = days / 365.25
    if "Compound" in method:
        total = capital * math.pow(1 + rate / 100 / 12, years * 12)
        value = total - capital
    else:
        value = capital * (rate / 100) * years
        total = capital + value
    return {"days": days, "years": f"{years:.2f}" if years > 0 else "0", "capital": fmt_r(capital),
            "interest": fmt_r(value), "total": fmt_r(total)}


# --- prescription (DATA.lit.prescription, lines 2909-2929) ----------------------------------------------------

def add_years(date: str, years: int) -> str:
    d = dt.date.fromisoformat(date)
    try:
        return d.replace(year=d.year + years).isoformat()
    except ValueError:  # 29 February
        return d.replace(year=d.year + years, day=28).isoformat()


def prescription_source(rows: list, rule_date: str) -> dict:
    """What v5 shows: precomputed prescDate and risk labels. The labels match 'prescDate < rule_date' where
    rule_date is DATA.lit.interestBasis.headline_date (inferred from the data; no v5 code applies a clock)."""
    return {
        "rows": len(rows),
        "prescDateIsDatePlus3y": sum(1 for r in rows if r.get("date") and add_years(r["date"], 3) == r.get("prescDate")),
        "reliesOnInterruption": sum(1 for r in rows if r.get("risk") == "Relies on interruption"),
        "labelsMatchPrescDateBeforeHeadlineDate": sum(1 for r in rows if (r.get("prescDate", "") < rule_date)
                                                      == (r.get("risk") == "Relies on interruption")),
    }


def prescription_rewrite(rows: list, as_of: str) -> dict:
    """Rewrite proposal (needs legal approval, BA-01/CC-06): classify against an explicit as-of date."""
    return {"asOf": as_of, "prescDateOnOrBeforeAsOf": sum(1 for r in rows if r.get("prescDate") and r["prescDate"] <= as_of)}


# --- citations ----------------------------------------------------------------------------------------------

def file_digest(source, path: str) -> dict:
    sha, crc, size = hashlib.sha256(), 0, 0
    with source.open(path) as fh:
        while chunk := fh.read(CHUNK):
            sha.update(chunk)
            crc = zlib.crc32(chunk, crc)
            size += len(chunk)
    return {"size": size, "crc32": f"{crc:08x}", "sha256": sha.hexdigest()}


def lookup(data: dict, dotted: str):
    """Follow 'a.b[3].c' through nested dicts/lists."""
    cur = data
    for part in dotted.replace("]", "").split("."):
        name, _, idx = part.partition("[")
        if name:
            cur = cur[name]
        if idx:
            for i in idx.split("["):
                cur = cur[int(i)]
    return cur


def citation(ws, files, source, field: str, ref: str | None = None) -> dict:
    item = lookup({"DATA": ws.data, **{k: v for k, v in ws.datasets.items() if k != "DATA"}}, field)
    ref = ref or item.get("ref")
    url = item.get("url") if isinstance(item, dict) else None
    row = next((r for r in ws.data["chronology"] if r.get("ref") == ref), None)
    out = {"ref": ref, "citedUrl": url, "chronologyUrl": row.get("url") if row else None}
    res = files.resolve(url or (row or {}).get("url") or "")
    out.update({"path": res["path"], "status": res["status"]})
    if res["status"] == "ok":
        out.update(file_digest(source, res["path"]))
    return out


# --- evaluator ----------------------------------------------------------------------------------------------

def evaluate(example: dict, ws, files, source) -> tuple[object, object]:
    """Return (source, rewrite) for an example; rewrite is None when the example has no rewrite expectation."""
    kind, inp = example["kind"], example["input"]
    if kind == "chronology-filter":
        rows = chronology_filter(ws.data["chronology"], **inp.get("filter", {}))
        got = {"count": len(rows), "firstRefs": [r["ref"] for r in rows[:inp.get("first", 3)]],
               "lastRef": rows[-1]["ref"] if rows else None}
        if "bundleOption" not in inp:
            return got, None
        return ({**got, "bundleOptionOffered": inp["bundleOption"] in CHRONOLOGY_BUNDLE_OPTIONS},
                {**got, "bundleOptionOffered": True})
    if kind == "citation":
        return citation(ws, files, source, inp["field"], inp.get("ref")), None
    if kind == "interest":
        return interest(inp["capital"], inp["rate"], inp["method"], inp["from"], inp["to"]), None
    if kind == "prescription":
        rows = ws.data["lit"]["prescription"]
        return (prescription_source(rows, ws.data["lit"]["interestBasis"]["headline_date"]),
                prescription_rewrite(rows, inp["asOf"]))
    if kind == "deadline":
        return {"table": deadline_table(inp["store"], dt.date.fromisoformat(inp["today"]))}, None
    if kind == "deadline-delete":
        return ({"persisted": deadline_delete_source(inp["store"], inp["shownIndex"])},
                {"persisted": deadline_delete_rewrite(inp["store"], inp["shownIndex"])})
    if kind == "ledger":
        return {"persisted": ledger_apply(inp["fields"], inp["ops"])}, None
    raise ValueError(f"unknown example kind {kind!r}")
