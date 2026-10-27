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
import { createIntakeController } from '../../../src/lib/submissions/controller.ts';
import { d1SubmissionRepository } from '../../../src/lib/submissions/repository.ts';
import { fileSetDigest } from '../../../src/lib/submissions/file-set.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
export const pdf = (tag: string) => utf8(`%PDF-1.4\n% SYNTHETIC ONLY ${tag}\n%%EOF\n`);
export const shaOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Verification work bounds (NATIVE24 M2), generous enough that no test of the original behaviour meets one. */
export const VERIFY_BUDGETS = { maxVerifyObjects: 256, maxVerifyBytes: 16 << 20, maxVerifyObjectsPerCaseWindow: 4096, maxVerifyBytesPerCaseWindow: 256 << 20, verifyWindowSeconds: 3600 };
export const BUDGETS = { maxPackageFiles: 64, maxPackageFileBytes: 1 << 20, maxPackageBytes: 4 << 20, maxDocuments: 1000, maxRowsPerBatch: 3, maxBufferedObjectBytes: 1 << 20, maxOriginalBytes: 1 << 20, ...VERIFY_BUDGETS };

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
  return packageOver(caseId, tag, docs);
}

/** The package and canonical local projection over `docs`, each indexed at `path` and held on disk at `onDisk` (none when missing). */
export async function packageOver<D extends { ref: string; disk: Disk; path: string; onDisk: string; bytes: Uint8Array }>(caseId: string, tag: string, docs: D[]) {
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

// ---- NATIVE24 integration fix: originals as the real client intake (GRS-137) leaves them ----

export interface Submitted { ref: string; path: string; bytes: Uint8Array }
/** The operation id the intake fixture uses for one upload (the intake's own id format: 16 to 64 letters, digits or dashes). */
export const submissionOp = (caseId: string, ref: string) => `opn24-${caseId}-${ref}`.padEnd(16, '0');
/**
 * Uploads each original through the REAL client intake controller (submissions/controller.ts) over the real submissions
 * repository and the real GRS-115 original intake, on the world's own D1 and R2: declared under `sub-<operationId>` with the
 * basename as `filename`, the case-relative path recorded only in the finalized submission. `commit: false` injects a fault
 * at the final mark, so the upload stays `reserved` (the original is bound by GRS-115 but the submission is not final).
 * Its own allow-all upload grant and writer; fixture plumbing only.
 */
export async function submit(dep: Dep, caseId: string, uploads: readonly Submitted[], o: { commit?: boolean } = {}) {
  const writer = { bindings: { db: dep.db, bucket: dep.bucket }, clientId: ids.clientA, budgets: BUDGETS, quotas: QUOTAS, authorize: async () => {}, now: caseNow };
  const repository = d1SubmissionRepository(dep.db);
  const ports = {
    clientId: ids.clientA, budget: { maxMetadataBytes: 4096, maxFileBytes: BUDGETS.maxOriginalBytes }, authorizeUpload: async () => {}, now: caseNow,
    originals: createOriginalIntake(writer as never),
    repository: o.commit === false ? { ...repository, commitRevision: async () => { throw new Error('injected fault at the final mark'); } } : repository,
  };
  const controller = createIntakeController(ports as never);
  const identity = grantedIdentity(ids.clientA, [caseId]).identity;
  const origin = 'https://client-a.example';
  const out: { operationId: string; status: number }[] = [];
  for (const u of uploads) {
    const operationId = submissionOp(caseId, u.ref);
    const declareUrl = new URL(`${origin}/client/intake/${caseId}/submissions`);
    const body = JSON.stringify({ operationId, path: u.path, size: u.bytes.byteLength, sha256: shaOf(u.bytes), mediaType: 'application/pdf' });
    const d = await controller.declare({ request: new Request(declareUrl, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body }), url: declareUrl, params: { caseId }, identity });
    if (d.status !== 201 && d.status !== 200) throw new Error(`fixture declare of ${u.ref} failed: ${d.status} ${await d.text()}`);
    const putUrl = new URL(`${origin}/client/intake/${caseId}/submissions/${operationId}`);
    const p = await controller.upload({ request: new Request(putUrl, { method: 'PUT', headers: { origin, 'content-type': 'application/pdf' }, body: new Uint8Array(u.bytes) as Uint8Array<ArrayBuffer> }), url: putUrl, params: { caseId, operationId }, identity });
    if (o.commit !== false && p.status !== 201 && p.status !== 200) throw new Error(`fixture upload of ${u.ref} failed: ${p.status} ${await p.text()}`);
    out.push({ operationId, status: p.status });
  }
  return out;
}

// ---- U16: one submission revision holding a set of files, through the real intake's set routes ----

/** The id the set fixture uses for the set itself and for each of its files (the intake's own id format). */
export const setOp = (caseId: string, ref: string) => `set24-${caseId}-${ref}`.padEnd(16, '0');
/**
 * Opens a set, declares and stores each file through the REAL client intake controller over the real repository and the real
 * GRS-115 original intake, then seals it in steps. Returns the set's revision id. `seal: false` leaves the set open (stored,
 * not sealed). Its own allow-all upload grant and writer; fixture plumbing only.
 */
export async function submitSet(dep: Dep, caseId: string, setRef: string, uploads: readonly Submitted[], o: { seal?: boolean } = {}) {
  const writer = { bindings: { db: dep.db, bucket: dep.bucket }, clientId: ids.clientA, budgets: BUDGETS, quotas: QUOTAS, authorize: async () => {}, now: caseNow };
  const controller = createIntakeController({
    clientId: ids.clientA, budget: { maxMetadataBytes: 4096, maxFileBytes: BUDGETS.maxOriginalBytes }, authorizeUpload: async () => {}, now: caseNow,
    originals: createOriginalIntake(writer as never), repository: d1SubmissionRepository(dep.db),
  } as never);
  const identity = grantedIdentity(ids.clientA, [caseId]).identity;
  const origin = 'https://client-a.example', setId = setOp(caseId, setRef);
  const call = async (method: 'POST' | 'PUT', tail: string, params: Record<string, string>, body: BodyInit, type: string, handler: (r: never) => Promise<Response>) => {
    const url = new URL(`${origin}/client/intake/${caseId}/sets${tail}`);
    const r = await handler({ request: new Request(url, { method, headers: { origin, 'content-type': type }, body }), url, params: { caseId, ...params }, identity } as never);
    if (r.status >= 300) throw new Error(`fixture ${method} ${tail} failed: ${r.status} ${await r.text()}`);
    return r;
  };
  const total = uploads.reduce((n, u) => n + u.bytes.byteLength, 0);
  await call('POST', '', {}, JSON.stringify({ setId, fileCount: uploads.length, totalBytes: total }), 'application/json', controller.openSet);
  for (const u of uploads) {
    const operationId = setOp(caseId, `${setRef}-${u.ref}`);
    await call('POST', `/${setId}/files`, { setId }, JSON.stringify({ operationId, path: u.path, size: u.bytes.byteLength, sha256: shaOf(u.bytes), mediaType: 'application/pdf' }), 'application/json', controller.declareSetFile);
    await call('PUT', `/${setId}/files/${operationId}`, { setId, operationId }, new Uint8Array(u.bytes) as Uint8Array<ArrayBuffer>, 'application/pdf', controller.uploadSetFile);
  }
  if (o.seal !== false) {
    const digest = await fileSetDigest(uploads.map((u) => ({ path: u.path.normalize('NFC'), size: u.bytes.byteLength, sha256: shaOf(u.bytes) })));
    for (let i = 0; ; i++) {
      const r = await call('POST', `/${setId}/seal`, { setId }, JSON.stringify({ filesSha256: digest }), 'application/json', controller.sealSet);
      if (r.status !== 202) break;
      if (i > 10_000) throw new Error('fixture seal did not finish');
    }
  }
  return `subrev-${setId}`;
}
