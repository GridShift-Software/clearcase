// Strict, bounded JSON parser. JSON.parse keeps the last duplicate key, accepts unbounded
// nesting and lone surrogates and rounds big integers; a results package must reject all
// of those with a location, so it is parsed here. A "__proto__" key becomes an inert own
// property. Nesting is bounded before recursion, so 200,000 "[" fail cleanly.
// Browser-safe: no Node built-ins.
import { LIMITS } from './limits.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export type StrictJsonCode = 'JSON_MALFORMED' | 'JSON_DUPLICATE_KEY' | 'JSON_LIMIT' | 'JSON_BAD_UTF8';

export class StrictJsonError extends Error {
  readonly code: StrictJsonCode;
  readonly offset: number;
  readonly pointer: string;
  constructor(code: StrictJsonCode, message: string, offset: number, pointer: string) {
    super(message);
    this.code = code;
    this.offset = offset;
    this.pointer = pointer;
  }
}

export interface StrictJsonLimits { depth: number; stringChars: number; objectKeys: number; arrayItems: number; values: number }

const DEFAULTS: StrictJsonLimits = {
  depth: LIMITS.jsonDepth, stringChars: LIMITS.stringChars, objectKeys: LIMITS.objectKeys,
  arrayItems: LIMITS.arrayItems, values: LIMITS.jsonValues,
};

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Strict UTF-8; a byte order mark is rejected. */
export function decodeUtf8Strict(buf: Uint8Array): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new StrictJsonError('JSON_BAD_UTF8', 'byte order mark is not allowed', 0, '');
  }
  try {
    return decoder.decode(buf);
  } catch {
    const at = firstInvalidUtf8(buf);
    throw new StrictJsonError('JSON_BAD_UTF8', `invalid UTF-8 at byte ${at}`, at, '');
  }
}

/** Byte offset of the first invalid UTF-8 sequence (overlong, surrogate, truncated, > U+10FFFF). */
export function firstInvalidUtf8(b: Uint8Array): number {
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    if (c < 0x80) { i++; continue; }
    const n = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : -1;
    if (n < 0 || i + n > b.length - 1) return i;
    const c1 = b[i + 1]!;
    if (c === 0xe0 && c1 < 0xa0) return i;
    if (c === 0xed && c1 > 0x9f) return i;
    if (c === 0xf0 && c1 < 0x90) return i;
    if (c === 0xf4 && c1 > 0x8f) return i;
    for (let k = 1; k <= n; k++) if ((b[i + k]! & 0xc0) !== 0x80) return i;
    i += n + 1;
  }
  return -1;
}

export const escapePointer = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

export function parseStrictJson(text: string, limits: Partial<StrictJsonLimits> = {}): JsonValue {
  const L = { ...DEFAULTS, ...limits };
  let i = 0;
  let values = 0;
  const path: string[] = [];
  const ptr = () => (path.length ? '/' + path.join('/') : '');
  const fail = (code: StrictJsonCode, msg: string): never => {
    const line = text.slice(0, i).split('\n').length;
    const col = i - text.lastIndexOf('\n', i - 1);
    throw new StrictJsonError(code, `${msg} at line ${line} column ${col}`, i, ptr());
  };
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };
  const hex4 = (): number => {
    const h = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('JSON_MALFORMED', 'bad \\u escape');
    i += 4;
    return parseInt(h, 16);
  };
  const str = (): string => {
    i++; // opening quote
    let out = '';
    let start = i;
    for (;;) {
      if (i >= text.length) fail('JSON_MALFORMED', 'unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) { out += text.slice(start, i); i++; break; }
      if (c < 0x20) fail('JSON_MALFORMED', 'raw control character in string');
      if (c >= 0xd800 && c <= 0xdfff) {
        const n = text.charCodeAt(i + 1);
        if (c > 0xdbff || !(n >= 0xdc00 && n <= 0xdfff)) fail('JSON_MALFORMED', 'lone surrogate in string');
        i += 2;
      } else if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const cu = hex4();
            if (cu >= 0xd800 && cu <= 0xdbff) {
              if (text[i] !== '\\' || text[i + 1] !== 'u') fail('JSON_MALFORMED', 'lone high surrogate escape');
              i += 2;
              const lo = hex4();
              if (!(lo >= 0xdc00 && lo <= 0xdfff)) fail('JSON_MALFORMED', 'invalid surrogate pair escape');
              out += String.fromCharCode(cu, lo);
            } else if (cu >= 0xdc00 && cu <= 0xdfff) fail('JSON_MALFORMED', 'lone low surrogate escape');
            else out += String.fromCharCode(cu);
            break;
          }
          default: fail('JSON_MALFORMED', 'invalid escape');
        }
        start = i;
      } else i++;
      if (out.length + (i - start) > L.stringChars) fail('JSON_LIMIT', `string longer than ${L.stringChars} characters`);
    }
    return out;
  };
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const num = (): number => {
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (!m) return fail('JSON_MALFORMED', 'bad number');
    const s = m[0];
    i += s.length;
    const v = Number(s);
    if (!Number.isFinite(v)) fail('JSON_LIMIT', 'number out of range');
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) fail('JSON_LIMIT', 'integer beyond 2^53-1 would lose precision');
    return v;
  };
  const lit = (word: string, v: JsonValue): JsonValue => {
    if (!text.startsWith(word, i)) fail('JSON_MALFORMED', 'unexpected token');
    i += word.length;
    return v;
  };
  const value = (depth: number): JsonValue => {
    if (++values > L.values) fail('JSON_LIMIT', `more than ${L.values} values`);
    ws();
    const c = text[i];
    if (c === '{') {
      if (depth >= L.depth) fail('JSON_LIMIT', `nesting deeper than ${L.depth}`);
      i++;
      const obj: JsonObject = {};
      let keys = 0;
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('JSON_MALFORMED', 'expected a key');
        const k = str();
        if (Object.hasOwn(obj, k)) fail('JSON_DUPLICATE_KEY', `duplicate key ${JSON.stringify(k.slice(0, 64))}`);
        if (++keys > L.objectKeys) fail('JSON_LIMIT', `more than ${L.objectKeys} keys in one object`);
        ws();
        if (text[i] !== ':') fail('JSON_MALFORMED', 'expected :');
        i++;
        path.push(escapePointer(k));
        // defineProperty: "__proto__" becomes an own data property, never a prototype swap
        Object.defineProperty(obj, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        path.pop();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('JSON_MALFORMED', 'expected , or }');
      }
    }
    if (c === '[') {
      if (depth >= L.depth) fail('JSON_LIMIT', `nesting deeper than ${L.depth}`);
      i++;
      const arr: JsonValue[] = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        if (arr.length >= L.arrayItems) fail('JSON_LIMIT', `more than ${L.arrayItems} array items`);
        path.push(String(arr.length));
        arr.push(value(depth + 1));
        path.pop();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail('JSON_MALFORMED', 'expected , or ]');
      }
    }
    if (c === '"') return str();
    if (c === 't') return lit('true', true);
    if (c === 'f') return lit('false', false);
    if (c === 'n') return lit('null', null);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return num();
    return fail('JSON_MALFORMED', c === undefined ? 'unexpected end of input' : 'unexpected token');
  };
  const v = value(0);
  ws();
  if (i !== text.length) fail('JSON_MALFORMED', 'trailing data after the JSON value');
  return v;
}

export const isObject = (v: unknown): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);
