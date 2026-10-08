#!/usr/bin/env python3
"""Independent Python reproduction of the ClearCase canonical JSON encodings.

Plain json.dumps(sort_keys=True) is NOT equivalent: it orders keys by code point and writes
floats in Python form. This reproduction orders keys by UTF-16 code units (RFC 8785) and writes
numbers in ECMAScript Number::toString form.

usage: python3 -I canonical.py (--compact|--pretty) FILE   -> canonical bytes on stdout
       python3 -I canonical.py --check FILE...             -> exit 0 if every file is canonical (pretty)
"""
import json
import sys
from decimal import Decimal

MAX_SAFE = 2**53 - 1
DEPTH = 32


def reject_duplicates(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise ValueError("duplicate key")
        out[k] = v
    return out


def es_number(x):
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    if isinstance(x, int):
        if abs(x) > MAX_SAFE:
            raise ValueError("integer beyond 2^53-1")
        return str(x)
    if x != x or x in (float("inf"), float("-inf")):
        raise ValueError("non-finite number")
    if x == 0:
        return "0"
    if x.is_integer():
        if abs(x) > MAX_SAFE:
            raise ValueError("integer beyond 2^53-1")
        return str(int(x))
    sign = "-" if x < 0 else ""
    t = Decimal(repr(abs(x))).normalize().as_tuple()
    digits = "".join(map(str, t.digits))
    k = len(digits)
    n = t.exponent + k
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = ("+" if e > 0 else "-") + str(abs(e))
        s = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + es
    return sign + s


def es_string(s):
    out = ['"']
    for ch in s:
        c = ord(ch)
        if 0xD800 <= c <= 0xDFFF:
            raise ValueError("lone surrogate")
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif c < 0x20:
            out.append({8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r"}.get(c, "\\u%04x" % c))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def utf16_key(s):
    return s.encode("utf-16-be", "surrogatepass")


def write(v, depth, indent, out):
    if v is None:
        out.append("null")
    elif v is True:
        out.append("true")
    elif v is False:
        out.append("false")
    elif isinstance(v, (int, float)):
        out.append(es_number(v))
    elif isinstance(v, str):
        out.append(es_string(v))
    elif isinstance(v, (list, dict)):
        if depth >= DEPTH:
            raise ValueError("nesting deeper than %d" % DEPTH)
        inner = None if indent is None else indent + "  "
        items = v if isinstance(v, list) else sorted(v.keys(), key=utf16_key)
        if not items:
            out.append("[]" if isinstance(v, list) else "{}")
            return
        out.append("[" if isinstance(v, list) else "{")
        for i, item in enumerate(items):
            if i:
                out.append(",")
            if inner is not None:
                out.append("\n" + inner)
            if isinstance(v, dict):
                out.append(es_string(item) + (":" if inner is None else ": "))
                write(v[item], depth + 1, inner, out)
            else:
                write(item, depth + 1, inner, out)
        if indent is not None:
            out.append("\n" + indent)
        out.append("]" if isinstance(v, list) else "}")
    else:
        raise TypeError("unsupported value")


def canonical(v, pretty):
    out = []
    write(v, 0, "" if pretty else None, out)
    return "".join(out) + ("\n" if pretty else "")


def load(path):
    with open(path, "rb") as f:
        raw = f.read()
    return raw, json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicates)


def main(argv):
    if len(argv) >= 2 and argv[0] in ("--compact", "--pretty"):
        _, v = load(argv[1])
        sys.stdout.buffer.write(canonical(v, argv[0] == "--pretty").encode("utf-8"))
        return 0
    if len(argv) >= 2 and argv[0] == "--check":
        bad = 0
        for p in argv[1:]:
            raw, v = load(p)
            if canonical(v, True).encode("utf-8") != raw:
                print("not canonical: " + p, file=sys.stderr)
                bad += 1
        print("python canonical check: %d of %d files reproduced byte for byte" % (len(argv) - 1 - bad, len(argv) - 1))
        return 1 if bad else 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
