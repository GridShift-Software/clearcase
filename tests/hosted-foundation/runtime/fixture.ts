import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildCase, pdf, row } from '../../e2e/pilot/lib/fixtures.ts';
import { importCandidate } from '../../../src/lib/case-package/import.ts';
import { readCandidate } from '../../../src/lib/case-package/reader.ts';
import { project, readModelDigest } from '../../../src/lib/local-case/project.server.ts';
import { id, resultsVersion, sha256 } from '../../../src/lib/server/runtime/ids.ts';
import type { DocumentRow, VersionInfo } from '../../../src/lib/server/runtime/contracts.ts';
import type { MemoryFixture } from '../../../src/lib/server/runtime/memory.ts';

export async function fixture() {
  const root = await mkdtemp(path.resolve('..', 'runtime-synthetic-'));
  try {
    const bytes = pdf('Hosted synthetic original');
    const built = await buildCase(root, { caseId: 'synthetic-published', originals: { 'HOSTED/test.pdf': bytes }, rows: [row('HOSTED-001', 999, 'HOSTED/test.pdf', bytes.length)] });
    const imported = await importCandidate({ files: built.files }, built.caseDir);
    if (!imported.candidate) throw new Error('Synthetic package rejected');
    const c = imported.candidate, p = project(c, {}), reader = readCandidate(c);
    const caseId = id('case', c.caseId), pending = id('case', 'synthetic-pending'), rv = resultsVersion(c.resultsVersion);
    const lists = JSON.parse(p.chronologyJson) as DocumentRow['list'][];
    const rows: DocumentRow[] = p.documents.map((d): DocumentRow => {
      const list = lists.find((l) => l.ref === d.ref);
      if (!list) throw new Error('Missing projection list');
      return { ref: d.ref, ord: d.ord, source: 'results', list, row: JSON.parse(d.row_json), state: JSON.parse(d.state_json) };
    }).sort((a, b) => a.ord - b.ord);
    const version: VersionInfo = { id: rv, case_id: caseId, input_revision_id: id('input-revision', c.inputRevisionId), case_label: 'Synthetic case', created: c.manifest.created, import_id: 1, verdict: 'accepted', stored_at: '2026-10-17T00:00:00Z', manifest_sha256: c.manifestSha256, diagnostics_sha256: imported.diagnosticsSha256, validator_version: 'fixture', warning_fingerprints: '[]', expect: JSON.stringify(p.expect), read_model_sha256: readModelDigest({ ...p, expect: JSON.stringify(p.expect) }), overview: p.overview };
    const assets = await Promise.all(rows.filter((d) => d.state.original).map(async (d) => {
      const o = d.state.original!;
      return { ref: { kind: 'original' as const, caseId, assetId: d.ref }, bytes: new Uint8Array(await readFile(path.join(built.caseDir, o.path))), metadata: { size: o.size, sha256: sha256(o.sha256), mediaType: o.mediaType, filename: path.basename(o.path), objectVersion: 'generation-1', etag: '"generation-1"' } };
    }));
    const clients = ['client-a', 'client-b'].map((value) => ({
      clientId: id('client', value), issuer: `https://${value}.example.invalid`,
      cases: [{ caseId, caseLabel: value, publication: { kind: 'published' as const, resultsVersion: rv }, href: `/cases/${caseId}`, documents: rows.length }, { caseId: pending, caseLabel: 'Awaiting processing', publication: { kind: 'none' as const }, href: `/cases/${pending}`, documents: null }],
      versions: [{ info: version, files: [...built.files].map(([path, bytes]) => ({ path, bytes })), rows, seeds: reader.seeds() }], assets,
    }));
    const identities = [
      { sessionId: id('session', 'a-viewer'), clientId: clients[0]!.clientId, subject: 'viewer', role: 'viewer' as const },
      { sessionId: id('session', 'a-editor'), clientId: clients[0]!.clientId, subject: 'editor', role: 'editor' as const },
      { sessionId: id('session', 'a-unassigned'), clientId: clients[0]!.clientId, subject: 'unassigned', role: null },
      { sessionId: id('session', 'a-admin'), clientId: clients[0]!.clientId, subject: 'admin', role: null },
      { sessionId: id('session', 'a-staff'), clientId: clients[0]!.clientId, subject: 'staff', role: null },
      { sessionId: id('session', 'b-editor'), clientId: clients[1]!.clientId, subject: 'editor', role: 'editor' as const },
    ].map((u) => ({ ...u, kind: u.subject === 'staff' ? 'staff' as const : 'client' as const, expiresAt: '2026-10-18T00:00:00Z' }));
    // Every listed identity is a member of its client; only the viewer and editors hold case grants.
    const memberships = identities.map(({ clientId, subject }) => ({ clientId, subject }));
    const grants = identities.flatMap(({ clientId, subject, role }) => role ? [caseId, pending].map((c) => ({ clientId, subject, caseId: c, role })) : []);
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const sessions = identities.map(({ role: _, ...session }) => session);
    const hash = createHash('sha256').update(JSON.stringify({ profile: 'runtime-contract/1', revision, clients: clients.map((c) => ({ ...c, versions: c.versions.map((v) => ({ ...v, files: v.files.map((f) => ({ path: f.path, sha256: createHash('sha256').update(f.bytes).digest('hex') })) })), assets: c.assets.map(({ ref, metadata }) => ({ ref, metadata })) })), identities: sessions, memberships, grants })).digest('hex');
    const data = { clients, identities: sessions, memberships, grants, revision, sha256: sha256(hash) } satisfies MemoryFixture;
    return { data, caseId, pending, rv, bytes, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (e) { await rm(root, { recursive: true, force: true }); throw e; }
}
