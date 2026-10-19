import { isObject, type JsonObject, type JsonValue } from '../strict-json.ts';

/** Sets an own property, as the strict parser does: a source key such as "__proto__" never swaps a prototype. */
export const own = <T extends object>(o: T, k: string, v: unknown): T => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

const AMOUNT = /^-?\d{1,15}(?:\.\d{1,4})?$/;
export function amountText(v: JsonValue | undefined): string {
  if (typeof v === 'string') return AMOUNT.test(v) ? v : '';
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const plain = String(v);
  if (AMOUNT.test(plain)) return plain;
  const fixed = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return AMOUNT.test(fixed) ? fixed : '';
}

/**
 * What a mapper can read a source value as; a value it cannot read stays on the record (keepRest).
 * `str` is text, number or boolean (written as text); `text` is a string only; `pos` a row position (text or number);
 * `level` a risk score (number) or word; `pairs` a list of [heading, text].
 */
export type Kind = 'str' | 'text' | 'num' | 'pos' | 'amount' | 'bool' | 'level' | 'strs' | 'objs' | 'object' | 'pairs';
export type Kinds = Readonly<Record<string, Kind>>;

const absent = (v: JsonValue | undefined) => v === undefined || v === null;
const FITS: Record<Kind, (v: JsonValue | undefined) => boolean> = {
  str: (v) => absent(v) || ['string', 'number', 'boolean'].includes(typeof v),
  text: (v) => absent(v) || typeof v === 'string',
  num: (v) => absent(v) || (typeof v === 'number' && Number.isFinite(v)),
  pos: (v) => absent(v) || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)),
  amount: (v) => absent(v) || v === '' || amountText(v) !== '',
  bool: (v) => absent(v) || typeof v === 'boolean',
  level: (v) => absent(v) || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)),
  strs: (v) => absent(v) || (Array.isArray(v) && v.every((x) => typeof x === 'string')),
  objs: (v) => absent(v) || (Array.isArray(v) && v.every(isObject)),
  object: (v) => absent(v) || isObject(v),
  pairs: (v) => absent(v) || (Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string')),
};
export const fits = (kind: Kind, v: JsonValue | undefined): boolean => FITS[kind](v);

/** Where a source field that cannot keep its own name goes: the record already has that name, or the schema types it differently. */
export const sourceName = (k: string): string => `source_${k}`;

/**
 * Every source field the mapping did not read, and every read field it could not read as the kind it needs (a null
 * where text belongs, an object where a list does), stays on the record, so nothing is lost silently (DS_UNSUPPORTED_FIELD).
 * A field whose name the record already uses is kept as `source_<name>`. A `handled` key was written by the caller already.
 */
export const keepRest = <T extends JsonObject>(into: T, from: JsonObject, read: readonly string[], kinds: Kinds = {}, handled: readonly string[] = []): T => {
  for (const [k, v] of Object.entries(from)) if (!handled.includes(k) && (!read.includes(k) || !FITS[kinds[k] ?? 'str'](v))) own(into, Object.hasOwn(into, k) ? sourceName(k) : k, v);
  return into;
};

/** An optional schema field of a given kind: written only when the source value has that type, else kept as `source_<key>`. Returns whether the key was present. */
export function carryTyped(out: JsonObject, from: JsonObject, key: string, kind: 'text' | 'strs', field = key): boolean {
  if (!Object.hasOwn(from, key)) return false;
  const v = from[key];
  if (v !== null && v !== undefined && FITS[kind](v)) own(out, field, v);
  else own(out, sourceName(key), v);
  return true;
}
