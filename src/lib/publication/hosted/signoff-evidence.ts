// What sign-off and publish ask of a sealed evidence run (real-export design 2; ADR-0013). Hosted-safe: pure TypeScript over two ports.
//
//   checkSealed   U3's `verifyEvidence`, bound to the candidate the sign-off is about. It reads the run's metadata in one statement and
//                 hashes nothing: counts, greatest key and page digests. It is the check made at sign-off and again before publish.
//   checkRows     `checkSealed`, then the root recomputed from the item rows themselves, in pages of 500 read in key order. A row
//                 changed behind the application's back keeps every count and digest the metadata holds, so only this catches it.
//   checkOriginals  the originals the sealed rows record (U8), compared with what R2 holds now: etag and size per object, in bounded batches.
//   warningsOf    every warning of the run and whether the case's baseline already holds it, so a sign-off acknowledges what the rows
//                 say and never what the request claims.
//
// One request does the rows check, in reads of at most 500 rows: bounded in subrequests and memory, not in CPU. U1 measured Workers
// Paid; Workers Free's 10 ms could not hold it. A step-resumable version would need a persisted cursor and could not sit inside the
// recheck that guards the pointer write, so none is built.
import { PAGE_SIZE, pageBytes, rootBytes, sha256Hex, verifyEvidence, type EvidenceStore } from './evidence/index.ts';
import type { EvidenceReader } from './ports.ts';
import { checkEvidenceItem } from './rules.ts';
import { originalKey } from '../../storage/cloud/keys.ts';

/** What R2 holds for one object right now, as `head` reports it. */
export interface OriginalHead { readonly etag: string; readonly size: number }
/**
 * Where publish compares the originals the evidence recorded with the objects R2 holds now (U8). R2 is outside D1, so this is a read at a
 * point in time and not a lock; it runs inside the recheck, immediately before the guarded D1 transaction. It never reads a body.
 */
export interface OriginalsComparison {
  /** Most object keys one `heads` call is given. */
  readonly batch: number;
  /** Most distinct objects one publish recheck compares. A run with more answers 503 rather than skipping any (a subrequest budget, not a sample). */
  readonly limit: number;
  /** One entry per key, in order: the object's current etag and size, or null when it is not there. A fault rejects (503). */
  heads(keys: readonly string[]): Promise<readonly (OriginalHead | null)[]>;
}

/** What a composition supplies as `signoffEvidence`: `d1EvidenceReader(db)` and `d1EvidenceStore(db)` over the client's `DB`. */
export interface PublicationEvidence {
  readonly reader: EvidenceReader;
  readonly store: EvidenceStore;
  /** Required once a run holds `original` items (U8): without it publish of such a candidate answers 503, never passes unchecked. */
  readonly originals?: OriginalsComparison | null;
}

/** The run a sign-off is about: the candidate's own identity, the generation its snapshot names and the root it carries. */
export interface EvidenceClaim {
  readonly clientId: string;
  readonly caseId: string;
  readonly candidateId: string;
  readonly generation: string;
  readonly root: string;
  readonly resultsVersion: string;
  readonly manifestSha256: string;
}
export type EvidenceCheck =
  | { readonly ok: true; readonly items: number }
  /** No complete run for this candidate and generation. */
  | { readonly ok: false; readonly reason: 'missing' }
  /** A run exists and is not what the claim names or what its own metadata says: another binding, uncovered or added rows, another root. */
  | { readonly ok: false; readonly reason: 'binding-mismatch' | 'uncovered' | 'root' | 'rows' };

/** `checkRows` passed: the run's items and the exact `[key, json]` rows the root was recomputed from, in key order. */
export type RowsCheck = Exclude<EvidenceCheck, { readonly ok: true }> | { readonly ok: true; readonly items: number; readonly rows: readonly (readonly [string, string])[] };

export async function checkSealed(port: PublicationEvidence, x: EvidenceClaim): Promise<EvidenceCheck> {
  // `inspect` reads by candidate and generation; the run's own binding comes back and is compared with the claim below.
  const facts = await port.store.inspect({ ...x, validatorVersion: '', rendererVersion: '' });
  if (!facts) return { ok: false, reason: 'missing' };
  const { clientId, caseId, resultsVersion, manifestSha256 } = facts.binding;
  if (clientId !== x.clientId || caseId !== x.caseId || resultsVersion !== x.resultsVersion || manifestSha256 !== x.manifestSha256) return { ok: false, reason: 'binding-mismatch' };
  const verified = await verifyEvidence(port.store, { candidateId: x.candidateId, generation: x.generation, ...facts.binding });
  if (!verified.ok) return { ok: false, reason: verified.reason === 'not-complete' ? 'missing' : verified.reason };
  return verified.root === x.root ? { ok: true, items: verified.items } : { ok: false, reason: 'root' };
}

export async function checkRows(port: PublicationEvidence, x: EvidenceClaim): Promise<RowsCheck> {
  const sealed = await checkSealed(port, x);
  if (!sealed.ok) return sealed;
  const digests: string[] = [], kept: (readonly [string, string])[] = [];
  let after: string | null = null, total = 0;
  // One read per page, and one more that finds the end; the bound stops a reader that never ends.
  for (let reads = 0; reads <= Math.ceil(sealed.items / PAGE_SIZE) + 1; reads++) {
    const rows = await port.reader.page({ clientId: x.clientId as never, caseId: x.caseId as never, candidateId: x.candidateId, generation: x.generation, root: x.root, after, kind: null, limit: PAGE_SIZE });
    if (rows === null) return { ok: false, reason: 'root' };
    if (rows.length === 0) break;
    digests.push(sha256Hex(pageBytes(rows.map(row => ({ key: row.key, json: row.json })))));
    for (const row of rows) kept.push([row.key, row.json]);
    total += rows.length;
    after = rows[rows.length - 1]!.key;
    if (rows.length < PAGE_SIZE) break;
  }
  return total === sealed.items && sha256Hex(rootBytes(digests)) === x.root ? { ok: true, items: sealed.items, rows: kept } : { ok: false, reason: 'rows' };
}

/**
 * Every warning of the run in key order, and the ones the case's baseline does not hold. Null when a row is not one this candidate may
 * serve (`checkEvidenceItem`) or the run holds far more warnings than `expected`, the snapshot's count; the caller compares the counts.
 */
export async function warningsOf(port: PublicationEvidence, x: EvidenceClaim, expected: number): Promise<{ all: string[]; fresh: string[] } | null> {
  const all: string[] = [], fresh: string[] = [];
  let after: string | null = null;
  for (let reads = 0; reads <= Math.ceil(expected / PAGE_SIZE) + 1; reads++) {
    const rows = await port.reader.page({ clientId: x.clientId as never, caseId: x.caseId as never, candidateId: x.candidateId, generation: x.generation, root: x.root, after, kind: 'warning', limit: PAGE_SIZE });
    if (rows === null) return null;
    for (const row of rows) {
      const item = checkEvidenceItem(row, x);
      if (!item || item.observation.kind !== 'warning') return null;
      all.push(item.observation.fingerprint);
      if (item.acknowledgementRequired) fresh.push(item.observation.fingerprint);
    }
    if (rows.length < PAGE_SIZE) return { all, fresh };
    after = rows[rows.length - 1]!.key;
  }
  return null;
}

export type OriginalsCheck =
  | { readonly ok: true; readonly compared: number }
  /** An object is gone, or its etag or size is no longer the recorded one; or two rows record different facts for one object. */
  | { readonly ok: false; readonly reason: 'changed' | 'missing' | 'rows' }
  /** More distinct originals than the comparison may check in one recheck. Not a verdict on the originals. */
  | { readonly ok: false; readonly reason: 'over-limit' };

/**
 * Every `original` row of the sealed run (read in pages of 500, each row checked against the candidate it is served for), then the
 * current etag and size of each distinct object in batches. An original several assets share is one object (`orig/<sha256>`) and is
 * compared once. The first difference stops the check. `expected` is the snapshot's count of original rows; any other count is `rows`.
 */
export async function checkOriginals(port: PublicationEvidence, originals: OriginalsComparison, x: EvidenceClaim, expected: number): Promise<OriginalsCheck> {
  const objects = new Map<string, { sha256: string; etag: string; size: number }>();
  let after: string | null = null, rowsSeen = 0, ended = false;
  for (let reads = 0; reads <= Math.ceil(expected / PAGE_SIZE) + 1 && !ended; reads++) {
    const rows = await port.reader.page({ clientId: x.clientId as never, caseId: x.caseId as never, candidateId: x.candidateId, generation: x.generation, root: x.root, after, kind: 'original', limit: PAGE_SIZE });
    if (rows === null) return { ok: false, reason: 'rows' };
    for (const row of rows) {
      const item = checkEvidenceItem(row, x);
      if (!item || item.observation.kind !== 'original') return { ok: false, reason: 'rows' };
      const { sha256, etag, size } = item.observation, key = originalKey(sha256), known = objects.get(key);
      if (known && (known.etag !== etag || known.size !== size)) return { ok: false, reason: 'rows' };
      objects.set(key, { sha256, etag, size });
      rowsSeen++;
    }
    ended = rows.length < PAGE_SIZE;
    if (!ended) after = rows[rows.length - 1]!.key;
  }
  if (!ended || rowsSeen !== expected) return { ok: false, reason: 'rows' };
  if (objects.size > originals.limit) return { ok: false, reason: 'over-limit' };
  const keys = [...objects.keys()];
  for (let from = 0; from < keys.length; from += originals.batch) {
    const batch = keys.slice(from, from + originals.batch), found = await originals.heads(batch);
    if (found.length !== batch.length) throw new Error('the comparison answered for another number of objects than it was given');
    for (let i = 0; i < batch.length; i++) {
      const now = found[i], recorded = objects.get(batch[i]!)!;
      if (!now) return { ok: false, reason: 'missing' };
      if (now.etag !== recorded.etag || now.size !== recorded.size) return { ok: false, reason: 'changed' };
    }
  }
  return { ok: true, compared: keys.length };
}
