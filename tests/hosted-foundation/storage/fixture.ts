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

const utf8 = (s: string) => new TextEncoder().encode(s);
export const pdf = (tag: string) => utf8(`%PDF-1.4\n% SYNTHETIC ONLY ${tag}\n%%EOF\n`);
export const shaOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export const BUDGETS = { maxPackageFiles: 64, maxPackageFileBytes: 1 << 20, maxPackageBytes: 4 << 20, maxDocuments: 1000, maxRowsPerBatch: 3, maxBufferedObjectBytes: 1 << 20, maxOriginalBytes: 1 << 20 };

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
