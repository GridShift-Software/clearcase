// The readback: what the deployed system answered, reduced to the facts the journey promises, in one canonical,
// digest-sealed JSON document. Phase 2 writes one, phase 3 reads the same facts after a restart, and `compareReadbacks`
// requires them equal. The parser is exact: an unknown key, a wrong type, a non-canonical byte, a bad digest or any
// secret-looking text refuses the whole document. Nothing here is a mock of the deployed system.
import { PART, SHA, SHA1, canon, exactKeys, isPlain, secretLike, sha256Hex } from './common.ts';

export const READBACK_SCHEMA = 'clearcase.native-journey-readback/1';
const KEYS = ['schema', 'deployedSha', 'caseId', 'resultsVersion', 'publication', 'originals', 'chronology', 'notes', 'exportSha256', 'digest'] as const;
const RV = /^sha256:[0-9a-f]{64}$/;

export interface ReadbackOriginal { assetId: string; sha256: string; size: number }
export interface ReadbackChronologyRow { ref: string; subject: string; originalAssetId: string | null }
export interface ReadbackNote { body: string; annotation: string | null }
export interface Readback {
  schema: typeof READBACK_SCHEMA; deployedSha: string; caseId: string; resultsVersion: string;
  publication: { kind: 'published'; resultsVersion: string } | { kind: 'none' } | { kind: 'withdrawn'; resultsVersion: string };
  originals: ReadbackOriginal[]; chronology: ReadbackChronologyRow[]; notes: ReadbackNote[]; exportSha256: string | null; digest: string;
}

/** The readback body (everything but its digest), with arrays in a fixed order, sealed with its digest. */
export function sealReadback(body: Omit<Readback, 'digest' | 'schema'>): Readback {
  const sorted = {
    ...body, schema: READBACK_SCHEMA,
    originals: [...body.originals].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0)),
    chronology: [...body.chronology].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    notes: [...body.notes].sort((a, b) => (a.body < b.body ? -1 : a.body > b.body ? 1 : 0)),
  };
  return { ...sorted, digest: sha256Hex(canon(sorted)) };
}
export const serializeReadback = (r: Readback): string => `${canon(r)}\n`;

export type Parsed = { ok: true; readback: Readback } | { ok: false; problems: string[] };

export function parseReadback(text: string): Parsed {
  if (secretLike(text)) return { ok: false, problems: ['the document contains secret-like text'] };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, problems: ['not JSON'] }; }
  const p: string[] = [];
  if (!isPlain(v) || !exactKeys(v, KEYS)) return { ok: false, problems: ['the document must have exactly the readback keys'] };
  if (v.schema !== READBACK_SCHEMA) p.push('schema');
  if (typeof v.deployedSha !== 'string' || !SHA1.test(v.deployedSha)) p.push('deployedSha');
  if (typeof v.caseId !== 'string' || !PART.test(v.caseId)) p.push('caseId');
  if (typeof v.resultsVersion !== 'string' || !RV.test(v.resultsVersion)) p.push('resultsVersion');
  const pub = v.publication;
  if (!isPlain(pub) || !((pub.kind === 'none' && exactKeys(pub, ['kind'])) || ((pub.kind === 'published' || pub.kind === 'withdrawn') && exactKeys(pub, ['kind', 'resultsVersion']) && typeof pub.resultsVersion === 'string' && RV.test(pub.resultsVersion)))) p.push('publication');
  const rows = <T>(name: string, value: unknown, keys: readonly string[], ok: (o: Record<string, unknown>) => boolean): T[] => {
    if (!Array.isArray(value) || !value.every((o) => isPlain(o) && exactKeys(o, keys) && ok(o))) { p.push(name); return []; }
    return value as T[];
  };
  const str = (x: unknown, max = 4096): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;
  rows<ReadbackOriginal>('originals', v.originals, ['assetId', 'sha256', 'size'], (o) => typeof o.assetId === 'string' && PART.test(o.assetId) && typeof o.sha256 === 'string' && SHA.test(o.sha256) && Number.isSafeInteger(o.size) && (o.size as number) > 0);
  rows<ReadbackChronologyRow>('chronology', v.chronology, ['ref', 'subject', 'originalAssetId'], (o) => typeof o.ref === 'string' && PART.test(o.ref) && str(o.subject) && (o.originalAssetId === null || (typeof o.originalAssetId === 'string' && PART.test(o.originalAssetId))));
  rows<ReadbackNote>('notes', v.notes, ['body', 'annotation'], (o) => str(o.body, 20_000) && (o.annotation === null || (typeof o.annotation === 'string' && PART.test(o.annotation))));
  if (v.exportSha256 !== null && !(typeof v.exportSha256 === 'string' && SHA.test(v.exportSha256))) p.push('exportSha256');
  if (typeof v.digest !== 'string' || !SHA.test(v.digest)) p.push('digest');
  if (p.length) return { ok: false, problems: p.map((x) => `invalid ${x}`) };
  const { digest, ...body } = v as Record<string, unknown>;
  if (sha256Hex(canon(body)) !== digest) return { ok: false, problems: ['the digest does not seal the body'] };
  if (text.trimEnd() !== canon(v) || !text.endsWith('\n') || text.endsWith('\n\n')) return { ok: false, problems: ['the document is not in canonical form (sorted keys, no whitespace, one final newline)'] };
  const r = v as unknown as Readback;
  // arrays must be in sealed order: a reordered list is a different document
  const { digest: _digest, schema: _schema, ...rest } = r;
  if (sealReadback(rest).digest !== r.digest) return { ok: false, problems: ['the lists are not in sealed order'] };
  return { ok: true, readback: r };
}

/** Differences that matter after a restart: every field but the digest and the export (re-exported bytes may differ in order). */
export function compareReadbacks(before: Readback, after: Readback, opts: { exportMustMatch: boolean }): string[] {
  const out: string[] = [];
  const same = (name: string, a: unknown, b: unknown) => { if (canon(a) !== canon(b)) out.push(name); };
  same('deployedSha', before.deployedSha, after.deployedSha); same('caseId', before.caseId, after.caseId); same('resultsVersion', before.resultsVersion, after.resultsVersion);
  same('publication', before.publication, after.publication); same('originals', before.originals, after.originals); same('chronology', before.chronology, after.chronology);
  same('notes', before.notes, after.notes);
  if (opts.exportMustMatch) same('exportSha256', before.exportSha256, after.exportSha256);
  return out;
}
