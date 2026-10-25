// Synthetic actual migrations/adapters; SQLite and R2 transport doubles, never provider evidence.
import { afterEach, expect, it } from 'vitest';
import { exportCase, exportNativeCase } from '../../../src/lib/recovery/hosted/export.ts';
import { verifyNativeExport } from '../../../src/lib/recovery/hosted/native-evidence.ts';
import { world, CASE, CLIENT, type World } from '../recovery-native-adapters/world.ts';
import { submit } from '../storage/fixture.ts';
import { pdf } from '../../results-review/native/fixtures.ts';
import { nativeWorld, POLICY, req } from './world.ts';
import { provisioningAuditPort } from '../../../src/lib/audit/provisioning.ts';
import { now } from '../recovery-native-adapters/world.ts';
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
async function setup(correction = false) { const w = await nativeWorld(correction); worlds.push(w); return w; }
it('exports finalized native submission lineage as checked /2 instead of the /1 unavailable hold', async () => {
  const w = await setup(), deps = await w.deps();
  const result = await exportNativeCase(deps, req), m = result.manifest;
  expect(m.format).toBe('clearcase.recovery-export/2');
  expect(m.clientId).toBe(CLIENT); expect(m.evidence.tables.native_candidate![0]!.candidate_id).toBe(w.current.candidateId);
  expect(m.evidence.tables.native_import_link![0]).toMatchObject({ link_id: w.current.link.linkId, submission_revision_id: w.revisionId, submission_manifest_sha256: w.current.link.submissionManifestSha256 });
  expect(m.resultsVersions[0]!.version.input_revision_id).not.toBe(w.revisionId);
  expect(m.evidence.tables.submissions_file![0]).toMatchObject({ path: 'folder/source.pdf', revision_id: w.revisionId, asset_id: w.current.link.coverage.mappedOriginals[0]!.submissionAssetId });
  expect(m.source).not.toHaveProperty('caseRevision'); expect(m.source.r2.atomicWithD1).toBe(false);
  expect(m.evidence.tables.native_candidate_audit_intent![0]!.archival_event).toContain('"kind":"historical"');
  expect(JSON.stringify(m)).not.toContain(w.identity.sessionId!);
  expect(await verifyNativeExport(deps, { ...req, expectedManifestSha256: result.manifestSha256 })).toMatchObject({ manifestSha256: result.manifestSha256 });
  expect(w.sessions).toEqual(['first-primary', 'first-primary']);
  await expect(exportCase(deps, { ...req, exportId: 'legacy-hold' })).rejects.toMatchObject({ code: 'recovery-unavailable' });
});
it('refuses missing policy and missing native lineage before acknowledgement', async () => {
  const w = await world(); worlds.push(w);
  const p = await w.stage(); w.publish(p.identity.resultsVersion);
  await submit(w, CASE, [{ path: 'folder/source.pdf', bytes: pdf('native recovery'), ref: 'native-source' }]);
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'recovery-unavailable' });
  w.options.nativeEvidence = { ...POLICY };
  await expect(exportNativeCase(await w.deps(), req)).rejects.toMatchObject({ code: 'export-incomplete' });
  expect(w.bucket.puts.some((k) => k.endsWith('/native-e1/manifest.json'))).toBe(false);
});
it('retains exact NFC paths and persisted NFKC collision keys without rewriting a submission', async () => {
  const w = await nativeWorld(false, false, 'ＦＯＬＤＥＲ/Ｓｏｕｒｃｅ.pdf'); worlds.push(w);
  const out = await exportNativeCase(await w.deps(), req), file = out.manifest.evidence.tables.submissions_file![0]!;
  expect(file.path).toBe('ＦＯＬＤＥＲ/Ｓｏｕｒｃｅ.pdf'); expect(file.path_key).toBe('folder/source.pdf');
  expect(file.revision_id).toBe(w.revisionId);
});
it('preserves system audit provenance as historical-system, never an authenticated requester', async () => {
  const w = await setup();
  await provisioningAuditPort({ db: w.db, config: w.auditConfig, now }).append({ eventId: 'synthetic-system-evidence', actor: { kind: 'system', component: 'provisioning', operator: 'synthetic-bootstrap' }, action: 'case.provisioned', object: { kind: 'case', id: CASE, caseId: CASE }, version: null, outcome: 'succeeded', at: now().toISOString() });
  const d = await w.deps(), out = await exportNativeCase(d, req);
  const archived = out.manifest.evidence.tables.native_audit_events!.find((r) => r.event_id === 'synthetic-system-evidence')!;
  expect(JSON.parse(String(archived.archival_event)).actor).toEqual({ kind: 'historical-system', component: 'provisioning', operator: 'synthetic-bootstrap' });
  expect(await verifyNativeExport(d, { ...req, expectedManifestSha256: out.manifestSha256 })).toMatchObject({ manifestSha256: out.manifestSha256 });
});
it('preserves actual correction, parent package bytes and committed audit provenance', async () => {
  const w = await setup(true), d = await w.deps();
  const result = await exportNativeCase(d, req), m = result.manifest;
  expect(m.resultsVersions).toHaveLength(2);
  expect(m.evidence.tables.native_candidate_supersession).toEqual([expect.objectContaining({ old_candidate_id: w.imported.candidateId, new_candidate_id: w.current.candidateId, reason: 'Correct synthetic title' })]);
  expect(m.evidence.tables.native_correction_change!.length).toBeGreaterThan(0);
  expect(m.evidence.tables.native_candidate_audit_intent).toHaveLength(2);
  expect(m.evidence.tables.native_candidate_audit_settlement).toHaveLength(2);
  expect(m.evidence.tables.native_correction_change).toEqual([expect.objectContaining({ path: 'datasets/matter.json', candidate_id: w.current.candidateId })]);
  expect(m.evidence.tables.native_candidate!.map((r) => r.manifest_sha256).sort()).toEqual([w.imported.link.candidate.manifestSha256, w.current.link.candidate.manifestSha256].sort());
  expect(await verifyNativeExport(d, { ...req, expectedManifestSha256: result.manifestSha256 })).toMatchObject({ verifiedBlobs: m.accounting.blobs.distinct });
});
