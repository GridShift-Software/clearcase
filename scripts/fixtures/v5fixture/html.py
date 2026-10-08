"""Extract the embedded datasets of a v5 workspace HTML as data, without executing any of it.

`DATA`, `META`, `window.__SCHED__` and `window.__CASELINES_IDX__` are each one line of JSON assigned in a
script; they are parsed with a strict JSON parser (no NaN/Infinity, no duplicate keys). `NAV`, `STORE_KEYS`
and the other code constants are JS literals in app code, parsed with the strict literal parser in jslit.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field

from . import jslit

JSON_LINE = re.compile(r"^(?:const\s+(DATA|META)|window\.(__SCHED__|__CASELINES_IDX__))\s*=\s*(.*?);?\s*$")
CODE_LITERALS = ("NAV", "STORE_KEYS", "ENF_OPTS", "CBK", "CBPH", "CBHF")
REQUIRED = ("DATA", "META")


class HtmlDataError(ValueError):
    pass


def _reject_constant(name):
    raise HtmlDataError(f"non-JSON constant {name}")


def _no_duplicates(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise HtmlDataError(f"duplicate JSON key {k!r}")
        out[k] = v
    return out


def strict_json(text: str):
    return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_no_duplicates)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_sha256(value) -> str:
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


@dataclass
class Workspace:
    sha256: str
    size: int
    lines: int
    datasets: dict = field(default_factory=dict)       # name -> parsed JSON
    dataset_lines: dict = field(default_factory=dict)  # name -> 1-based line number
    literals: dict = field(default_factory=dict)       # name -> parsed JS literal
    literal_lines: dict = field(default_factory=dict)
    code: str = ""                                     # the HTML with the dataset lines blanked
    code_sha256: str = ""

    @property
    def data(self) -> dict:
        return self.datasets["DATA"]

    @property
    def meta(self) -> dict:
        return self.datasets["META"]

    def nav(self) -> list[dict]:
        out = []
        for group, items in self.literals.get("NAV", []):
            for item in items:
                out.append({"group": group, "id": item[0], "label": item[1]})
        return out


def parse(raw: bytes) -> Workspace:
    try:
        src = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HtmlDataError(f"HTML is not valid UTF-8: {exc}") from None
    lines = src.split("\n")
    ws = Workspace(sha256=sha256(raw), size=len(raw), lines=len(lines))
    code_lines = list(lines)
    for no, line in enumerate(lines, 1):
        if not (line.startswith("const ") or line.startswith("window.")):
            continue
        m = JSON_LINE.match(line)
        if not m or not m.group(3)[:1] in ("{", "["):
            continue
        name = m.group(1) or "window." + m.group(2)
        if name in ws.datasets:
            raise HtmlDataError(f"{name} is assigned twice (lines {ws.dataset_lines[name]} and {no})")
        try:
            ws.datasets[name] = strict_json(m.group(3))
        except (ValueError, HtmlDataError) as exc:
            raise HtmlDataError(f"{name} on line {no} is not strict JSON: {exc}") from None
        ws.dataset_lines[name] = no
        code_lines[no - 1] = f"/* {name} */"
    for name in REQUIRED:
        if name not in ws.datasets:
            raise HtmlDataError(f"no embedded {name} line found")
    ws.code = "\n".join(code_lines)
    ws.code_sha256 = sha256(ws.code.encode("utf-8"))
    for name in CODE_LITERALS:
        m = re.search(r"(?m)^[ \t]*(?:const|let|var)[ \t]+" + name + r"[ \t]*=[ \t]*", ws.code)
        if not m:
            continue
        try:
            ws.literals[name], _ = jslit.parse_at(ws.code, m.end())
        except jslit.JsLiteralError as exc:
            raise HtmlDataError(f"{name} is not a plain literal: {exc}") from None
        ws.literal_lines[name] = ws.code.count("\n", 0, m.start()) + 1
    if "NAV" not in ws.literals:
        raise HtmlDataError("no NAV literal found")
    return ws
