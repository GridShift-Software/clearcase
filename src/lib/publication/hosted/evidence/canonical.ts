// The canonical forms the evidence digests are computed over. Everything here is a pure function of its inputs.
//
// Item JSON  : canonicalJson of {"input": <exact input binding>, "observation": <producer value>}.
//              Keys sorted by UTF-16 code unit, no whitespace, strings as JSON.stringify writes them. Only plain objects, arrays,
//              strings (well-formed Unicode), booleans, null and safe integers have an encoding; anything else (floats, undefined,
//              -0, Date, Map, functions, lone surrogates, depth over 32) is refused with a RangeError, never coerced.
// Row        : JSON.stringify(item_key) + " " + item_json + "\n". item_key is ASCII (KEY_PATTERN) and strictly ascending in
//              production order, so row order equals ORDER BY item_key in D1 for both SQLite and JavaScript comparison.
// Page       : PAGE_TAG + the rows in order, 500 rows per page (the last page may hold fewer, never zero). Digest = sha256 hex.
// Root       : ROOT_TAG + one page digest per line in page order. Root = sha256 hex. No pages gives the digest of ROOT_TAG alone.
export const PAGE_SIZE = 500;
export const PAGE_TAG = 'clearcase.evidence.page/1\n';
export const ROOT_TAG = 'clearcase.evidence.root/1\n';
export const KEY_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;
const MAX_DEPTH = 32;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const encoder = new TextEncoder();
export const utf8 = (text: string): Uint8Array => encoder.encode(text);

const refuse = (why: string): never => { throw new RangeError(`not canonical: ${why}`); };
function text(value: string): string { return LONE_SURROGATE.test(value) ? refuse('lone surrogate') : JSON.stringify(value); }

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return refuse('too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return text(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number': return Number.isSafeInteger(value) && !Object.is(value, -0) ? String(value) : refuse('number');
    case 'object': break;
    default: return refuse(typeof value);
  }
  if (Array.isArray(value)) return `[${Array.from({ length: value.length }, (_, i) => canonicalJson(value[i], depth + 1)).join(',')}]`;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return refuse('not a plain object');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => {
    if (Object.getOwnPropertyDescriptor(record, key)?.get) refuse('accessor');
    return `${text(key)}:${canonicalJson(record[key], depth + 1)}`;
  }).join(',')}}`;
}

export const rowText = (key: string, json: string): string => `${JSON.stringify(key)} ${json}\n`;
export interface EvidenceRow { readonly key: string; readonly json: string }
export const pageBytes = (rows: readonly EvidenceRow[]): Uint8Array => utf8(PAGE_TAG + rows.map(r => rowText(r.key, r.json)).join(''));
export const rootBytes = (pageDigests: readonly string[]): Uint8Array => utf8(ROOT_TAG + pageDigests.map(d => `${d}\n`).join(''));
