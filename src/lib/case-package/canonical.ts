// Canonical JSON, written by hand. JSON.stringify is never called on objects: it emits
// integer-like keys ("9", "10") in numeric order, which breaks RFC 8785 (JCS) key order.
//
// - Identity encoding (canonicalJson): compact JCS. Keys sorted by UTF-16 code units,
//   no whitespace, ECMAScript number form, minimal string escaping.
// - File encoding (canonicalText): the same order and escaping with two-space indentation,
//   LF line ends and exactly one final newline.
//
// Accepted values: null, booleans, finite numbers (integers must be safe), well-formed
// strings, arrays and plain objects, nested at most LIMITS.jsonDepth containers deep.
// Browser-safe: no Node built-ins.
import { LIMITS } from './limits.ts';

export class CanonicalError extends TypeError {}

const HEX = '0123456789abcdef';

/** JSON string literal with the escaping RFC 8785 prescribes (same as ECMAScript). */
export function quoteString(s: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string | null = null;
    if (c < 0x20) {
      esc = c === 0x08 ? '\\b' : c === 0x09 ? '\\t' : c === 0x0a ? '\\n' : c === 0x0c ? '\\f' : c === 0x0d ? '\\r' : '\\u00' + HEX[c >> 4] + HEX[c & 15];
    } else if (c === 0x22) esc = '\\"';
    else if (c === 0x5c) esc = '\\\\';
    else if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      throw new CanonicalError('lone surrogate in string');
    }
    if (esc !== null) {
      out += s.slice(start, i) + esc;
      start = i + 1;
    }
  }
  return out + s.slice(start) + '"';
}

function numberText(n: number): string {
  if (!Number.isFinite(n)) throw new CanonicalError('non-finite number');
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) throw new CanonicalError('integer beyond 2^53-1');
  if (Object.is(n, -0)) return '0';
  return String(n); // ECMAScript Number::toString: shortest round-trip form
}

function sortedKeys(o: object): string[] {
  const proto = Object.getPrototypeOf(o);
  if (proto !== Object.prototype && proto !== null) throw new CanonicalError('not a plain object');
  // Default sort compares UTF-16 code units, which is the JCS order.
  return Object.keys(o).sort();
}

function write(v: unknown, depth: number, indent: string | null, out: string[]): void {
  if (v === null) { out.push('null'); return; }
  switch (typeof v) {
    case 'boolean': out.push(v ? 'true' : 'false'); return;
    case 'number': out.push(numberText(v)); return;
    case 'string': out.push(quoteString(v)); return;
    case 'object': break;
    default: throw new CanonicalError(`unsupported type ${typeof v}`);
  }
  if (depth >= LIMITS.jsonDepth) throw new CanonicalError(`nesting deeper than ${LIMITS.jsonDepth}`);
  const inner = indent === null ? null : indent + '  ';
  if (Array.isArray(v)) {
    if (v.length === 0) { out.push('[]'); return; }
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(',');
      if (inner !== null) out.push('\n', inner);
      if (!(i in v)) throw new CanonicalError('sparse array');
      write(v[i], depth + 1, inner, out);
    }
    if (indent !== null) out.push('\n', indent);
    out.push(']');
    return;
  }
  const keys = sortedKeys(v as object);
  if (keys.length === 0) { out.push('{}'); return; }
  out.push('{');
  keys.forEach((k, i) => {
    const val = (v as Record<string, unknown>)[k];
    if (val === undefined) throw new CanonicalError(`undefined value at key ${quoteString(k)}`);
    if (i > 0) out.push(',');
    if (inner !== null) out.push('\n', inner);
    out.push(quoteString(k), inner === null ? ':' : ': ');
    write(val, depth + 1, inner, out);
  });
  if (indent !== null) out.push('\n', indent);
  out.push('}');
}

/** Compact JCS text: the identity encoding hashed for inputRevision and resultsVersion. */
export function canonicalJson(v: unknown): string {
  const out: string[] = [];
  write(v, 0, null, out);
  return out.join('');
}

/** Two-space canonical text with LF and one final newline: the package file encoding. */
export function canonicalText(v: unknown): string {
  const out: string[] = [];
  write(v, 0, '', out);
  out.push('\n');
  return out.join('');
}

const encoder = new TextEncoder();
export const canonicalBytes = (v: unknown): Uint8Array => encoder.encode(canonicalText(v));
export const utf8 = (s: string): Uint8Array => encoder.encode(s);
