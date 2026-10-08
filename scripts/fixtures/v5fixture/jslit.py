"""Parse a strict subset of JavaScript literal syntax as data. Nothing is evaluated.

Accepted: objects (identifier, quoted or numeric keys), arrays, single- or double-quoted strings,
decimal numbers, true/false/null, // and /* */ comments, trailing commas. Anything else, such as
identifiers used as values, calls, template literals, spreads, operators or a member access after
the literal, raises JsLiteralError.
"""
from __future__ import annotations

import re

_ID = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_NUM = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_ESC = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "\\": "\\", "'": "'", '"': '"', "/": "/"}


class JsLiteralError(ValueError):
    pass


class _Parser:
    def __init__(self, src: str, pos: int):
        self.s = src
        self.i = pos

    def fail(self, msg: str):
        raise JsLiteralError(f"{msg} at offset {self.i}")

    def peek(self) -> str:
        return self.s[self.i:self.i + 1]

    def ws(self):
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c in " \t\r\n﻿ ":
                self.i += 1
            elif s.startswith("//", self.i):
                j = s.find("\n", self.i)
                self.i = len(s) if j < 0 else j + 1
            elif s.startswith("/*", self.i):
                j = s.find("*/", self.i + 2)
                if j < 0:
                    self.fail("unterminated comment")
                self.i = j + 2
            else:
                return

    def value(self):
        self.ws()
        c = self.peek()
        if c == "{":
            return self.obj()
        if c == "[":
            return self.arr()
        if c in ("'", '"'):
            return self.string()
        m = _NUM.match(self.s, self.i)
        if m:
            self.i = m.end()
            text = m.group(0)
            return float(text) if any(ch in text for ch in ".eE") else int(text)
        m = _ID.match(self.s, self.i)
        if m and m.group(0) in ("true", "false", "null"):
            self.i = m.end()
            return {"true": True, "false": False, "null": None}[m.group(0)]
        self.fail("not a literal value")

    def string(self) -> str:
        quote = self.s[self.i]
        self.i += 1
        out = []
        s = self.s
        while True:
            if self.i >= len(s):
                self.fail("unterminated string")
            c = s[self.i]
            if c == quote:
                self.i += 1
                return "".join(out)
            if c in "\r\n":
                self.fail("line break in string")
            if c != "\\":
                out.append(c)
                self.i += 1
                continue
            n = s[self.i + 1:self.i + 2]
            if n == "u" and s[self.i + 2:self.i + 3] == "{":
                j = s.find("}", self.i)
                out.append(chr(int(s[self.i + 3:j], 16)))
                self.i = j + 1
            elif n == "u":
                hexd = s[self.i + 2:self.i + 6]
                if not re.fullmatch(r"[0-9A-Fa-f]{4}", hexd):
                    self.fail("bad \\u escape")
                out.append(chr(int(hexd, 16)))
                self.i += 6
            elif n == "x":
                hexd = s[self.i + 2:self.i + 4]
                if not re.fullmatch(r"[0-9A-Fa-f]{2}", hexd):
                    self.fail("bad \\x escape")
                out.append(chr(int(hexd, 16)))
                self.i += 4
            elif n == "\n":
                self.i += 2
            elif n == "0" and not s[self.i + 2:self.i + 3].isdigit():
                out.append("\0")
                self.i += 2
            elif n in _ESC:
                out.append(_ESC[n])
                self.i += 2
            elif n.isdigit():
                self.fail("octal escape")
            else:
                out.append(n)
                self.i += 2

    def key(self) -> str:
        self.ws()
        if self.peek() in ("'", '"'):
            return self.string()
        m = _ID.match(self.s, self.i) or _NUM.match(self.s, self.i)
        if not m:
            self.fail("bad object key")
        self.i = m.end()
        return m.group(0)

    def obj(self) -> dict:
        self.i += 1
        out: dict = {}
        while True:
            self.ws()
            if self.peek() == "}":
                self.i += 1
                return out
            k = self.key()
            if k in out:
                self.fail(f"duplicate key {k!r}")
            self.ws()
            if self.peek() != ":":
                self.fail("expected ':'")
            self.i += 1
            out[k] = self.value()
            self.ws()
            if self.peek() == ",":
                self.i += 1
            elif self.peek() != "}":
                self.fail("expected ',' or '}'")

    def arr(self) -> list:
        self.i += 1
        out = []
        while True:
            self.ws()
            if self.peek() == "]":
                self.i += 1
                return out
            out.append(self.value())
            self.ws()
            if self.peek() == ",":
                self.i += 1
            elif self.peek() != "]":
                self.fail("expected ',' or ']'")


def parse_at(src: str, pos: int):
    """Parse the literal starting at `pos`; it must end the statement (';', a line break or end of input).
    Returns (value, end offset)."""
    p = _Parser(src, pos)
    value = p.value()
    end = p.i
    while p.i < len(src) and src[p.i] in " \t":
        p.i += 1
    if p.i < len(src) and src[p.i] not in ";\r\n":
        p.fail("literal is followed by more code")
    return value, end


def parse(text: str):
    value, end = parse_at(text, 0)
    p = _Parser(text, end)
    p.ws()
    if p.peek() == ";":
        p.i += 1
        p.ws()
    if p.i != len(text):
        p.fail("trailing content")
    return value
