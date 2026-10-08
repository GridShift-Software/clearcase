"""Static, text-only analysis of the v5 app code per navigation view. Nothing is executed.

For each NAV id the analyser finds the live `RENDER.<id>` definition (the last assignment in source order),
follows the functions it calls by name, and counts in that reachable code:

- handler sites: inline `on<event>=` attributes and `addEventListener('<event>'` calls for user events;
- navigation sites: `data-tab=` attributes, which the shell's global click and key listeners route to go();
- exports: `dl('<file>', ...)` downloads, `.download=` anchors and `window.print()`;
- user-work stores: `ess_dcs_*` keys, directly or through constants such as RKEY or CBK.<name>;
- datasets: DATA.<key>, META.<key>, window.__SCHED__ and window.__CASELINES_IDX__.

The counts are a reproducible static measure, not a claim about every runtime behavior; the reviewed
per-view checklist lives in docs/reference/view-checklist.md.
"""
from __future__ import annotations

import re

USER_EVENTS = ("click", "dblclick", "change", "input", "keydown", "keyup", "keypress", "submit",
               "dragstart", "dragover", "drop", "paste")
_DEF_PATTERNS = [
    re.compile(r"\bRENDER\.([A-Za-z_$][\w$]*)\s*=\s*function\s*\([^)]*\)\s*\{"),
    re.compile(r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{"),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\s*\([^)]*\)|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)\s*\{"),
]
_FACTORY = re.compile(r"\bRENDER\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(")
_CALL = re.compile(r"\b([A-Za-z_$][\w$]*)\s*\(")
_LISTENER_FN = re.compile(r"addEventListener\(\s*['\"]\w+['\"]\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]")
_HANDLER_ATTR = re.compile(r"\bon(" + "|".join(USER_EVENTS) + r")\s*=\s*\\?['\"]")
_HANDLER_PROP = re.compile(r"\.on(" + "|".join(USER_EVENTS) + r")\s*=(?!=)")
_LISTENER = re.compile(r"addEventListener\(\s*['\"](" + "|".join(USER_EVENTS) + r")['\"]")
_DATA_TAB = re.compile(r"\bdata-tab\s*=")
_DL = re.compile(r"\bdl\(\s*(['\"])((?:\\.|(?!\1).)*)\1")
_DL_EXPR = re.compile(r"\bdl\(\s*(?!['\"])")
_DOWNLOAD = re.compile(r"\.download\s*=(?!=)")
_PRINT = re.compile(r"\bwindow\.print\(\)")
_STORE = re.compile(r"ess_dcs_[A-Za-z0-9_]+?_v[0-9]+\b")
_STRING_CONST = re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['\"](ess_dcs_[A-Za-z0-9_]+?_v[0-9]+)['\"]")
_DATA_ALIAS = re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*(DATA\.[A-Za-z_$][\w$]*|window\.__[A-Z_]+__)")
_DATA = re.compile(r"\b(DATA|META)\.([A-Za-z_$][\w$]*)")
_GLOBAL_DATA = re.compile(r"__SCHED__|__CASELINES_IDX__")
_REGEX_PRECEDERS = set("(,=:[!&|?{};+-*%<>~^")


def _skip_string(code: str, i: int) -> int:
    quote = code[i]
    i += 1
    while i < len(code):
        c = code[i]
        if c == "\\":
            i += 2
            continue
        if c == quote:
            return i + 1
        if quote == "`" and code.startswith("${", i):
            i = match_brace(code, i + 1) + 1
            continue
        if c == "\n" and quote != "`":
            return i
        i += 1
    return i


def _skip_regex(code: str, i: int) -> int:
    i += 1
    in_class = False
    while i < len(code):
        c = code[i]
        if c == "\\":
            i += 2
            continue
        if c == "[":
            in_class = True
        elif c == "]":
            in_class = False
        elif c == "/" and not in_class:
            i += 1
            while i < len(code) and (code[i].isalnum() or code[i] == "_"):
                i += 1
            return i
        elif c == "\n":
            return i
        i += 1
    return i


def match_brace(code: str, open_at: int) -> int:
    """Return the offset of the bracket closing the one at `open_at`, skipping strings, comments,
    template literals and regex literals."""
    pairs = {"{": "}", "(": ")", "[": "]"}
    stack = [pairs[code[open_at]]]
    i = open_at + 1
    prev = code[open_at]
    while i < len(code):
        c = code[i]
        if c in "'\"`":
            i = _skip_string(code, i)
            prev = "a"
            continue
        if code.startswith("//", i):
            j = code.find("\n", i)
            i = len(code) if j < 0 else j
            continue
        if code.startswith("/*", i):
            j = code.find("*/", i + 2)
            i = len(code) if j < 0 else j + 2
            continue
        if c == "/" and (prev in _REGEX_PRECEDERS or re.search(r"\b(?:return|typeof|case)\s*$", code[max(0, i - 8):i])):
            i = _skip_regex(code, i)
            prev = "a"
            continue
        if c in pairs:
            stack.append(pairs[c])
        elif c in ")}]":
            if not stack or stack.pop() != c:
                raise ValueError(f"unbalanced {c!r} at offset {i}")
            if not stack:
                return i
        if not c.isspace():
            prev = c
        i += 1
    raise ValueError(f"no closing bracket for offset {open_at}")


def definitions(code: str) -> list[dict]:
    out = []
    for pat in _DEF_PATTERNS:
        for m in pat.finditer(code):
            is_render = pat is _DEF_PATTERNS[0]
            start = m.end() - 1
            try:
                end = match_brace(code, start)
            except ValueError:
                continue
            out.append({"name": ("RENDER." if is_render else "") + m.group(1), "start": m.start(), "end": end + 1})
    for m in _FACTORY.finditer(code):
        if code[m.end() - 1:m.end()] != "(" or m.group(2) == "function":
            continue
        try:
            end = match_brace(code, m.end() - 1)
        except ValueError:
            continue
        out.append({"name": "RENDER." + m.group(1), "start": m.start(), "end": end + 1, "factory": m.group(2)})
    out.sort(key=lambda d: d["start"])
    return out


def _line(code: str, offset: int) -> int:
    return code.count("\n", 0, offset) + 1


def analyse(ws) -> dict:
    code = ws.code
    defs = definitions(code)
    by_name: dict[str, list[dict]] = {}
    for d in defs:
        by_name.setdefault(d["name"], []).append(d)
    consts = dict(_STRING_CONST.findall(code))
    aliases = {}
    for name, target in _DATA_ALIAS.findall(code):
        aliases.setdefault(name, set()).add(target)
    # Only upper-case module constants (SCHED, CBB, IDX) count as aliases; local short names such as B or S
    # appear in many unrelated functions.
    aliases = {k: v.pop() for k, v in aliases.items() if len(v) == 1 and k.isupper() and len(k) >= 3}
    cbk = ws.literals.get("CBK") or {}
    store_keys = set(ws.literals.get("STORE_KEYS") or [])
    views = []
    all_live_keys = set()
    for item in ws.nav():
        vid = item["id"]
        render_defs = by_name.get("RENDER." + vid, [])
        if not render_defs:
            views.append({"id": vid, "defined": False})
            continue
        live = render_defs[-1]
        seen, queue, bodies = set(), [live], []
        while queue:
            d = queue.pop()
            key = (d["name"], d["start"])
            if key in seen:
                continue
            seen.add(key)
            body = code[d["start"]:d["end"]]
            bodies.append((d, body))
            called = set(_CALL.findall(body)) | set(_LISTENER_FN.findall(body))
            if d.get("factory"):
                called.add(d["factory"])
            for name in called:
                for target in by_name.get(name, []):
                    if (target["name"], target["start"]) not in seen:
                        queue.append(target)
        text = "\n".join(b for _d, b in bodies)
        handlers = len(_HANDLER_ATTR.findall(text)) + len(_HANDLER_PROP.findall(text)) + len(_LISTENER.findall(text))
        exports = sorted(set(m[1] for m in _DL.findall(text)))
        stores = set(_STORE.findall(text))
        for name, key in consts.items():
            if re.search(r"\b" + re.escape(name) + r"\b", text):
                stores.add(key)
        if re.search(r"\bSTORE_KEYS\b", text):
            stores |= store_keys
        for name, key in cbk.items():
            if re.search(r"\bCBK\." + re.escape(name) + r"\b", text):
                stores.add(key)
        datasets = {f"{a}.{b}" for a, b in _DATA.findall(text)}
        datasets |= {"window." + g for g in _GLOBAL_DATA.findall(text)}
        for alias, target in aliases.items():
            if re.search(r"(?<![.\w$])" + re.escape(alias) + r"\b", text):
                datasets.add(target)
        all_live_keys |= stores
        views.append({
            "id": vid,
            "defined": True,
            "definitions": [_line(code, d["start"]) for d in render_defs],
            "liveLine": _line(code, live["start"]),
            "factory": live.get("factory"),
            "reachableFunctions": len(bodies),
            "handlerSites": handlers,
            "navigationSites": len(_DATA_TAB.findall(text)),
            "exportCalls": len(_DL.findall(text)) + len(_DL_EXPR.findall(text)),
            "exportFiles": exports,
            "downloadAnchors": len(_DOWNLOAD.findall(text)),
            "printCalls": len(_PRINT.findall(text)),
            "stores": sorted(stores),
            "storesNotBackedUp": sorted(s for s in stores if store_keys and s not in store_keys),
            "datasets": sorted(datasets),
        })
    code_keys = set(_STORE.findall(code))
    return {
        "views": views,
        "redefinedViews": sorted(v["id"] for v in views if len(v.get("definitions", [])) > 1),
        "storeKeysInCode": sorted(code_keys),
        "storeKeysNotInBackup": sorted(code_keys - store_keys) if store_keys else [],
        "backupKeysUnusedElsewhere": sorted(k for k in store_keys if code.count(k) <= 1),
    }


def summarise(info: dict) -> dict:
    views = info["views"]
    return {
        "count": len(views),
        "defined": sum(1 for v in views if v.get("defined")),
        "handlerSitesTotal": sum(v.get("handlerSites", 0) for v in views),
        "navigationSitesTotal": sum(v.get("navigationSites", 0) for v in views),
        "perView": {v["id"]: {k: v.get(k) for k in ("liveLine", "definitions", "handlerSites", "navigationSites",
                                                    "exportCalls", "downloadAnchors", "exportFiles", "printCalls",
                                                    "stores", "datasets")}
                    for v in views},
        "redefinedViews": info["redefinedViews"],
        "storeKeysInCode": info["storeKeysInCode"],
        "storeKeysNotInBackup": info["storeKeysNotInBackup"],
        "backupKeysUnusedElsewhere": info["backupKeysUnusedElsewhere"],
    }
