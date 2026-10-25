// Input and stored-row validation for hosted user work. The rules match the runtime memory double's (the contract's
// reference semantics) so callers see the same refusals; they are restated here because no production module may
// import the memory double.
import type * as C from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { Type, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';

export const invalid = (): never => { throw contractError('invalid'); };

const Text = Type.String({ minLength: 1 }), Iso = Type.String({ pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?Z$' });
const Results = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }), Digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const strict = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const AnchorSchema = strict({ caseId: Text, resultsVersion: Results, refAtCreation: Text, sha256: Type.Union([Digest, Type.Null()]) });
const TargetSchema = Type.Union([strict({ kind: Type.Literal('case') }), strict({ kind: Type.Literal('document'), anchor: AnchorSchema }), strict({ kind: Type.Literal('analysis'), resultsVersion: Results, section: Text })]);
const OverlaySchema = strict({ caseId: Text, datasetKey: Text, seedId: Text, baseSeedSha256: Type.String(), fields: Type.Record(Type.String(), Type.Unknown()) });
export const AnchorCheck = Compile(AnchorSchema), TargetCheck = Compile(TargetSchema), OverlayCheck = Compile(OverlaySchema);
export const NoteRowCheck = Compile(strict({
  id: Text, body: Type.String(), createdAt: Iso, intact: Type.Boolean(), candidates: Type.Array(Type.String()),
  status: Type.Union(['here', 'exact', 'ambiguous', 'missing', 'unanchored'].map((s) => Type.Literal(s))), target: TargetSchema,
}));
export const RegisterRowCheck = Compile(strict({ rowId: Text, store: Text, anchor: Type.Union([AnchorSchema, Type.Null()]), fields: Type.Record(Type.String(), Type.Unknown()), createdAt: Iso, updatedAt: Iso, intact: Type.Boolean() }));

/** Parses one snapshot payload whole: every field present, typed and no other. */
export function parsed<T>(validator: { Check(value: unknown): boolean }, text: unknown): T {
  let value: unknown;
  try { value = JSON.parse(String(text)); } catch { invalid(); }
  if (!validator.Check(value)) invalid();
  return value as T;
}

export const OPERATION = /^[A-Za-z0-9._:-]{1,128}$/;
export function operationId(value: unknown): string { if (typeof value !== 'string' || !OPERATION.test(value)) invalid(); return value as string; }
export function storeName(value: unknown) { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) invalid(); }
export function rowIdOf(value: unknown) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid(); return value as string; }
export function fields(value: Record<string, unknown>): C.Fields {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  for (const [k, v] of Object.entries(value)) if (['__proto__', 'constructor', 'prototype'].includes(k) || !(v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v))) invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024) invalid();
  return structuredClone(value) as C.Fields;
}
export function body(value: unknown) { if (typeof value !== 'string') invalid(); const out = (value as string).replace(/\r\n?/g, '\n').trim(); if (!out || out.length > 20_000) invalid(); return out; }

export const BUILTINS = ['note', 'seed_overlay', 'register_row'] as const;
const RESERVED = new Set<string>([...BUILTINS, 'trusted_warning', 'active', 'activation_log', 'version', 'package_file', 'document', 'asset', 'seed', 'import_attempt', 'case_assignment', 'membership']);
export const isBuiltin = (name: string) => (BUILTINS as readonly string[]).includes(name);
export const isReserved = (name: string) => RESERVED.has(name);

export function definition(d: C.TableDefinition): C.UserWorkTable {
  if (!d || typeof d !== 'object') invalid();
  if (RESERVED.has(d.name)) throw contractError('table-built-in');
  if (typeof d.name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(d.name) || d.name.startsWith('sqlite') || d.name.startsWith('userwork_catalog') || d.name.startsWith('uw_') || typeof d.owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(d.owner) || typeof d.description !== 'string' || d.description.length > 1000 || d.scope !== 'case' || !Array.isArray(d.columns) || !d.columns.length || d.columns.length > 64 || !Array.isArray(d.primaryKey) || !d.primaryKey.length) invalid();
  const seen = new Set<string>();
  for (const c of d.columns) {
    if (!c || typeof c.name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(c.name) || seen.has(c.name) || !['TEXT', 'INTEGER', 'REAL', 'BLOB'].includes(c.type)) invalid();
    seen.add(c.name);
  }
  const caseColumn = d.columns.find((c) => c.name === 'case_id');
  if (!caseColumn || caseColumn.type !== 'TEXT' || !(caseColumn.notNull || d.primaryKey.includes('case_id')) || new Set(d.primaryKey).size !== d.primaryKey.length || d.primaryKey.some((n) => !seen.has(n))) invalid();
  return { name: d.name, owner: d.owner, description: d.description, kind: 'user-work', scope: 'case', columns: d.columns.map((c) => ({ name: c.name, type: c.type, notNull: !!c.notNull || d.primaryKey.includes(c.name), pk: d.primaryKey.indexOf(c.name) + 1 })) };
}
export function builtin(name: string): C.UserWorkTable {
  return { name, owner: 'runtime', description: 'Hosted user-work encoding', kind: 'user-work', scope: 'case', columns: [{ name: 'case_id', type: 'TEXT', notNull: true, pk: 1 }, { name: 'id', type: 'TEXT', notNull: true, pk: 2 }, { name: 'payload', type: 'TEXT', notNull: true, pk: 0 }] };
}
export function tableKey(t: C.UserWorkTable, row: Record<string, C.TableCell>) {
  const keys = t.columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk);
  if (keys.some((c) => row[c.name] === null || row[c.name] === undefined)) throw contractError('restore-key');
  return JSON.stringify(keys.map((c) => row[c.name]));
}
export function cells(t: C.UserWorkTable, row: Record<string, C.TableCell>, caseId: C.CaseId, partial = false) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((name) => !t.columns.some((c) => c.name === name))) invalid();
  if (row.case_id !== caseId) throw contractError('restore-key-collision');
  const out: Record<string, C.TableCell> = {};
  for (const c of t.columns) {
    if (partial && !c.pk && c.name !== 'case_id') continue;
    let v = row[c.name] ?? null;
    if (v === null && c.notNull) invalid();
    if (typeof v === 'number' && !Number.isFinite(v)) invalid();
    if (c.type === 'TEXT' && v !== null && typeof v !== 'string') invalid();
    if (typeof v === 'object' && v !== null) {
      if ('$int' in v) { if (!/^-?\d+$/.test(v.$int) || BigInt(v.$int) < -(2n ** 63n) || BigInt(v.$int) >= 2n ** 63n) invalid(); }
      else if ('$b64' in v) { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.$b64)) invalid(); }
      else invalid();
    }
    if ((c.type === 'INTEGER' || c.type === 'REAL') && typeof v === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v)) { const n = Number(v); if (!Number.isFinite(n)) invalid(); v = n; }
    if (c.type === 'INTEGER' && c.pk && !(typeof v === 'number' && Number.isSafeInteger(v) || typeof v === 'object' && v !== null && '$int' in v)) throw contractError('restore-key');
    out[c.name] = structuredClone(v);
  }
  tableKey(t, out);
  return out;
}

/** Canonical JSON (keys sorted at every depth): the request digest and stored payloads do not depend on key order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
