"""Find and redact dates and case strings in text that may be committed.

Committed docs may hold only the v5 build date, the fixed test clock and synthetic dates that collide with
no case date. The doc generators call `redact()` on every free-text value, so a date or case string copied
from a review draft becomes a placeholder by construction; `leak_check.py` uses `iso_dates()` to compare
every date in a tracked file with every date in the local fixture.

Recognised forms: 2001-02-03, 2001/02/03, 2001.02.03, 20010203 (also before a `T`), 3/2/2001, 3.2.2001,
3-2-2001 (read both day-first and month-first), 3 February 2001, 3rd of Feb. 2001 and February 3, 2001.
"""
from __future__ import annotations

import datetime as dt
import re

# The v5 build date and the fixed test clock: chosen dates, not taken from any case document.
ALLOWED_DATES = frozenset({"2026-08-12", "2026-10-08"})
CASE_DATE = "<case-date>"
CASE_NAME = "<case-name>"

_MONTHS = {m: i for i, names in enumerate(
    [("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"), ("may",), ("jun", "june"),
     ("jul", "july"), ("aug", "august"), ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"),
     ("dec", "december")], 1) for m in names}
_MON = "(" + "|".join(sorted(_MONTHS, key=len, reverse=True)) + r")\.?"
_Y = r"((?:19|20)\d\d)"
_D = r"(\d{1,2})(?:st|nd|rd|th)?"
_END = r"(?![0-9A-SU-Za-z_]|\.\d)"  # a time may follow as 'T09:00'
_PATTERNS = [
    ("ymd", re.compile(r"(?<![\w.])" + _Y + r"([-/.])(\d{1,2})\2(\d{1,2})" + _END)),
    ("compact", re.compile(r"(?<![0-9A-Za-z])((?:19|20)\d\d)(\d\d)(\d\d)(?![0-9A-SU-Za-z])")),
    ("dmy", re.compile(r"(?<![\w.])(\d{1,2})([-/.])(\d{1,2})\2" + _Y + _END)),
    ("d-mon-y", re.compile(r"(?<![\w])" + _D + r"(?:\s+of)?[\s-]+" + _MON + r",?[\s-]+" + _Y + r"(?!\w)", re.I)),
    ("mon-d-y", re.compile(r"(?<![\w])" + _MON + r"\s+" + _D + r",?\s+" + _Y + r"(?!\w)", re.I)),
]


def _iso(year, month, day):
    try:
        return dt.date(int(year), int(month), int(day)).isoformat()
    except ValueError:
        return None


def find_dates(text: str) -> list:
    """Return (start, end, {iso dates}) for every date-like span in text order; a numeric day/month pair gives
    both readings."""
    taken, found = [], []
    for kind, pat in _PATTERNS:
        for m in pat.finditer(text):
            if any(s < m.end() and m.start() < e for s, e in taken):
                continue
            if kind == "ymd":
                isos = {_iso(m.group(1), m.group(3), m.group(4))}
            elif kind == "compact":
                isos = {_iso(m.group(1), m.group(2), m.group(3))}
            elif kind == "dmy":
                isos = {_iso(m.group(4), m.group(3), m.group(1)), _iso(m.group(4), m.group(1), m.group(3))}
            elif kind == "d-mon-y":
                isos = {_iso(m.group(3), _MONTHS[m.group(2).lower()], m.group(1))}
            else:
                isos = {_iso(m.group(3), _MONTHS[m.group(1).lower()], m.group(2))}
            isos.discard(None)
            if isos:
                taken.append((m.start(), m.end()))
                found.append((m.start(), m.end(), isos))
    return sorted(found, key=lambda f: f[0])


def iso_dates(text: str) -> set[str]:
    return {d for _s, _e, isos in find_dates(text) for d in isos}


def redact_dates(text: str, allowed=ALLOWED_DATES) -> str:
    """Replace every date whose readings are not all allowed with `<case-date>`."""
    out, last = [], 0
    for start, end, isos in find_dates(text):
        if isos <= set(allowed):
            continue
        out.append(text[last:start])
        out.append(CASE_DATE)
        last = end
    out.append(text[last:])
    return "".join(out)


def redact(text: str, needles=(), allowed=ALLOWED_DATES) -> str:
    """Redact case strings (case-insensitive, longest first) and then dates."""
    if needles:
        pattern = re.compile("|".join(re.escape(n) for n in sorted(set(needles), key=len, reverse=True)), re.I)
        text = pattern.sub(CASE_NAME, text)
    return redact_dates(text, allowed)
