// Synthetic fixtures for the hosted storage unit tests. Every byte is invented here; no case material is read.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildPackage } from '../../../src/lib/case-package/writer.ts';
import { importCandidate } from '../../../src/lib/case-package/import.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { project } from '../../../src/lib/local-case/project.server.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id, resultsVersion, type CaseId, type ClientId } from '../../../src/lib/server/runtime/ids.ts';
import type { CaseOperation, Identity, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import { SqliteD1, MemoryR2 } from './doubles.ts';
import { createOriginalIntake } from '../../../src/lib/storage/cloud/intake.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
export const pdf = (tag: string) => utf8(`%PDF-1.4\n% SYNTHETIC ONLY ${tag}\n%%EOF\n`);
export const shaOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export const BUDGETS = { maxPackageFiles: 64, maxPackageFileBytes: 1 << 20, maxPackageBytes: 4 << 20, maxDocuments: 1000, maxRowsPerBatch: 3, maxBufferedObjectBytes: 1 << 20, maxOriginalBytes: 1 << 20 };

/** Cumulative quotas (storage/cloud/quotas.ts), generous enough that no test of the original behaviour meets one. */
export const QUOTAS = {
  maxUploadsPerCase: 50, maxOriginalBytesPerCase: 64 << 20, maxOriginalBytesPerClient: 256 << 20, maxPutAttemptsPerUpload: 5,
  maxVersionsPerCase: 20, maxPackageBytesPerCase: 64 << 20, maxPackageBytesPerClient: 256 << 20, maxStagingAttemptsPerCase: 50,
};

/** A valid two-document results package for `caseId`, validated and projected through the case-package API. */
export async function syntheticPackage(caseId: string, tag: string) {
  const docs = [{ ref: 'OD-001', path: 'DISCOVERY/OD-001 agreement.pdf', bytes: pdf(`${tag}-1`) }, { ref: 'OD-002', path: 'DISCOVERY/OD-002 letter.pdf', bytes: pdf(`${tag}-2`) }];
  const rows = docs.map((d, i) => ({
    n: String(i + 1), ref: d.ref, date: `2001-01-0${i + 1}`, filename: d.path.split('/').pop()!, subject: `Synthetic ${tag} ${i + 1}`, sender: '', to: '', cc: '',
    excerpt: '', doc_type: 'other', bundle: '', amount: '', also_in: [], text_status: 'pending', url: '', refs: [], invoice_no: '', size: d.bytes.byteLength, seq: String(i + 1), attachments: [],
  }));
  const prov = (sourcePath: string) => ({ source: 'synthetic-storage', sourcePath, adapter: 'storage-fixture@0' });
  const assets: Record<string, unknown> = {};
  for (const d of docs) assets[d.ref] = { kind: 'file', path: d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength, mediaType: 'application/pdf', textStatus: 'pending' };
  const { files } = buildPackage({
    caseId, caseLabel: `Synthetic ${tag}`, inputKind: 'synthetic-storage',
    sources: [{ role: 'synthetic', name: 'storage fixture', sha256: sha256Hex(utf8(tag)), size: tag.length }],
    producer: { name: 'storage-fixture', version: '1' }, created: '2001-01-01T00:00',
    datasets: [{ key: 'chronology', kind: 'generated', schema: 'v5.chronology@1', required: true, provenance: prov('DATA.chronology'), data: rows }],
    assets: assets as never,
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'cc-storage-'));
  try {
    for (const d of docs) { await mkdir(path.join(dir, path.dirname(d.path)), { recursive: true }); await writeFile(path.join(dir, d.path), d.bytes); }
    const result = await importCandidate({ files }, dir);
    if (result.verdict === 'reject') throw new Error(`synthetic package rejected: ${result.diagnostics.map((x) => x.code).join(',')}`);
    const c = result.candidate;
    return {
      files, docs,
      identity: { resultsVersion: resultsVersion(c.resultsVersion), manifestSha256: c.manifestSha256 },
      validation: { verdict: result.verdict, validatorVersion: result.validatorVersion, diagnosticsSha256: result.diagnosticsSha256, warningFingerprints: result.warningFingerprints },
      projection: project(c, result.counts),
    };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** One client deployment's database and bucket, provisioned with its identity and cases. */
export function deployment(clientId: string, cases: string[]) {
  const db = new SqliteD1(), bucket = new MemoryR2();
  db.exec("INSERT INTO rs_storage_identity (singleton, client_id, layout) VALUES (1, ?, 'clearcase.rs/1')", clientId);
  bucket.setRaw('identity/client.json', utf8(JSON.stringify({ client_id: clientId })));
  for (const c of cases) db.exec('INSERT INTO rs_case (case_id, case_label) VALUES (?, ?)', c, `Case ${c}`);
  return { db, bucket };
}

/** Publication as the publication owner (GRS-31) would leave it; the storage adapters never write these rows. */
export function publish(db: SqliteD1, caseId: string, rv: string) {
  db.exec("INSERT INTO rs_publication (case_id, state, version_id) VALUES (?, 'published', ?) ON CONFLICT (case_id) DO UPDATE SET state = 'published', previous_version_id = rs_publication.version_id, version_id = excluded.version_id", caseId, rv);
}
export function withdraw(db: SqliteD1, caseId: string, rv: string) {
  db.exec("UPDATE rs_publication SET state = 'withdrawn' WHERE case_id = ? AND version_id = ?", caseId, rv);
  db.exec("INSERT INTO rs_version_withdrawal (version_id, case_id, withdrawn_at) VALUES (?, ?, '2001-01-02T00:00:00Z')", rv, caseId);
}

/** A verified identity with explicit case grants; revoking a grant takes effect on the next authorize. */
export function grantedIdentity(clientId: ClientId, cases: string[]) {
  const grants = new Set(cases);
  const calls: { caseId: string; operation: CaseOperation }[] = [];
  const identity: Identity = {
    kind: 'verified', principal: { issuer: 'synthetic', subject: 'user-a', kind: 'client' }, sessionId: 'session-a' as SessionId, clientId,
    async checkRevocation() {},
    async authorize(a) { calls.push(a); if (!grants.has(a.caseId)) throw contractError('forbidden'); },
  };
  return { identity, grants, calls };
}

export const ids = { clientA: id('client', 'client-a'), clientB: id('client', 'client-b'), caseA: id('case', 'case-a') as CaseId, caseB: id('case', 'case-b') as CaseId };
export const GET = { method: 'GET' as const, range: null, ifRange: null };

// ---- GRS-115 approved supplemental (original facts): honest verified facts, never a claimed status ----

const caseNow = () => new Date('2001-01-01T00:00:00Z');
type Dep = { db: SqliteD1; bucket: MemoryR2 };
export interface Upload { ref: string; filename: string; mediaType: string; bytes: Uint8Array }

/**
 * What a client really uploaded for a case: each original declared under its asset key with its real case-relative path,
 * put, and finalized, through the real intake. This is the per-case D1 association plus the R2 object that stage reads;
 * it uses its own allow-all writer so a world's authorize log and quotas are not touched. Fixture plumbing only.
 */
export async function provide(dep: Dep, caseId: string, uploads: readonly Upload[]) {
  const writer = { bindings: { db: dep.db, bucket: dep.bucket }, clientId: ids.clientA, budgets: BUDGETS, quotas: QUOTAS, authorize: async () => {}, now: caseNow };
  const intake = createOriginalIntake(writer as never);
  for (const u of uploads) {
    const base = { caseId: id('case', caseId), operationId: `facts-${caseId}-${u.ref}` };
    const declared = await intake.declare({ ...base, assetId: u.ref, filename: u.filename, mediaType: u.mediaType, size: u.bytes.byteLength, sha256: shaOf(u.bytes) });
    const put = await intake.put({ ...base, bytes: u.bytes });
    const done = await intake.finalize(base);
    if (declared.kind !== 'declared' || put.kind !== 'stored' || done.kind !== 'finalized') throw new Error(`fixture upload of ${u.ref} failed: ${JSON.stringify([declared, put, done])}`);
  }
}
/** Every original of a `syntheticPackage`, uploaded as the case folder holds it (the honest plumbing the old fixtures lacked). */
export const provideOriginals = (dep: Dep, caseId: string, pkg: { docs: { ref: string; path: string; bytes: Uint8Array }[] }) =>
  provide(dep, caseId, pkg.docs.map((d) => ({ ref: d.ref, filename: d.path, mediaType: 'application/pdf', bytes: d.bytes })));

export type Disk = 'ok' | 'missing' | 'case' | 'nfd' | 'html';
export const html = (tag: string) => utf8(`<!doctype html><html><body>SYNTHETIC ONLY ${tag}</body></html>`);
/**
 * A valid package whose originals sit in a real temporary case folder in the states the canonical local import knows:
 * present, missing, found only by a case-insensitive name, found only by a normalisation-insensitive name, and content
 * that is not the declared PDF (download-only). `projection` is `project()` of that import: the canonical answer.
 * `uploads` is what a hosted client would have finalized for the same folder (nothing for a missing original).
 */
export async function originalsPackage(caseId: string, tag: string, disks: readonly Disk[]) {
  const docs = disks.map((disk, i) => {
    const ref = `OD-${String(i + 1).padStart(3, '0')}`;
    const name = disk === 'nfd' ? 'caf\u00e9' : `letter ${i + 1}`;
    const path = `DISCOVERY/${ref} ${name}.pdf`;
    const onDisk = disk === 'case' ? `DISCOVERY/${ref} ${name.toUpperCase()}.pdf` : disk === 'nfd' ? path.normalize('NFD') : path;
    return { ref, disk, path, onDisk, bytes: disk === 'html' ? html(`${tag}-${i + 1}`) : pdf(`${tag}-${i + 1}`) };
  });
  const rows = docs.map((d, i) => ({
    n: String(i + 1), ref: d.ref, date: `2001-01-0${i + 1}`, filename: d.path.split('/').pop()!, subject: `Synthetic ${tag} ${i + 1}`, sender: '', to: '', cc: '',
    excerpt: '', doc_type: 'other', bundle: '', amount: '', also_in: [], text_status: 'pending', url: '', refs: [], invoice_no: '', size: d.bytes.byteLength, seq: String(i + 1), attachments: [],
  }));
  const prov = (sourcePath: string) => ({ source: 'synthetic-storage', sourcePath, adapter: 'storage-fixture@0' });
  const assets: Record<string, unknown> = {};
  for (const d of docs) assets[d.ref] = { kind: 'file', path: d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength, mediaType: 'application/pdf', textStatus: 'pending' };
  const { files } = buildPackage({
    caseId, caseLabel: `Synthetic ${tag}`, inputKind: 'synthetic-storage',
    sources: [{ role: 'synthetic', name: 'storage fixture', sha256: sha256Hex(utf8(tag)), size: tag.length }],
    producer: { name: 'storage-fixture', version: '1' }, created: '2001-01-01T00:00',
    datasets: [{ key: 'chronology', kind: 'generated', schema: 'v5.chronology@1', required: true, provenance: prov('DATA.chronology'), data: rows }],
    assets: assets as never,
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'cc-storage-'));
  try {
    for (const d of docs) {
      if (d.disk === 'missing') continue;
      await mkdir(path.join(dir, path.dirname(d.onDisk)), { recursive: true });
      await writeFile(path.join(dir, d.onDisk), d.bytes);
    }
    const result = await importCandidate({ files }, dir);
    if (result.verdict === 'reject') throw new Error(`synthetic package rejected: ${result.diagnostics.map((x) => x.code).join(',')}`);
    const c = result.candidate;
    return {
      files, docs,
      uploads: docs.filter((d) => d.disk !== 'missing').map((d): Upload => ({ ref: d.ref, filename: d.onDisk, mediaType: 'application/pdf', bytes: d.bytes })),
      identity: { resultsVersion: resultsVersion(c.resultsVersion), manifestSha256: c.manifestSha256 },
      validation: { verdict: result.verdict, validatorVersion: result.validatorVersion, diagnosticsSha256: result.diagnosticsSha256, warningFingerprints: result.warningFingerprints },
      projection: project(c, result.counts),
    };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
