import { afterEach, describe, expect, it } from 'vitest';
import { createHostedCandidateStager } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import { validateHostedPackage } from '../../../src/lib/case-package/hosted-validation.ts';
import { readOriginalFacts } from '../../../src/lib/storage/cloud/original-facts.ts';
import { preparePackage } from '../../../src/lib/results/hosted/project.ts';
import { buildCoverage } from '../../../src/lib/results-review/native/coverage.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { caseId, world, docs, pdf } from './world.ts';
import { ids } from '../storage/fixture.ts';
import { buildFixture } from '../../results-review/native/fixtures.ts';
import { resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import { readModelDigest, type StagedProjection } from '../../../src/lib/results/hosted/read-model.ts';

const worlds: ReturnType<typeof world>[] = [];
const setup = (ds = docs(1)) => { const w = world(ds); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.db.sqlite.close(); });

describe('real hosted candidate stager', () => {
  it('stages genuine bytes, diagnostics and read model, re-reads a repeat, and never publishes', async () => {
    const w = setup(), revision = await w.upload(), a = await w.request(revision);
    const out = await w.ports.stager.stage(a);
    expect(out.kind).toBe('staged');
    if (out.kind !== 'staged') return;
    const row = w.db.rows<{ state: string; diagnostics_sha256: string; warning_fingerprints: string }>('SELECT * FROM rs_results_version')[0];
    expect(row.state).toBe('stored');
    expect(row.diagnostics_sha256).toBe(out.diagnosticsSha256);
    expect(JSON.parse(row.warning_fingerprints)).toEqual(out.warningFingerprints);
    const gets = w.bucket.gets;
    expect(await w.ports.stager.stage(a)).toEqual({ ...out, repeated: true });
    expect(w.bucket.gets).toBeGreaterThan(gets);
    expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
    expect(w.events.filter((e) => e.action === 'results.native-stage').map((e) => e.outcome)).toEqual(['succeeded', 'succeeded']);
  });

  it.each(['case', 'nfc'] as const)('preserves genuine %s mismatch diagnostics for all package aliases without rewriting IDs', async (mode) => {
    const original = docs(1)[0], d = { ...original, path: mode === 'nfc' ? original.path.normalize('NFD') : original.path };
    const ds = [d, { ...d, ref: 'OD-002' }];
    // Intake canonicalizes supplied names to NFC; the package's indexed name can still be NFD.
    const w = setup(ds), real = mode === 'case' ? d.path.toUpperCase() : d.path.normalize('NFC');
    const a = await w.request(await w.upload(real));
    const out = await w.ports.stager.stage(a);
    expect(out.kind).toBe('staged');
    if (out.kind !== 'staged') return;
    expect(out.resultsVersion).toBe(a.identity.resultsVersion);
    expect(out.inputRevisionId).not.toBe(a.submission.manifest.revisionId);
    const assets = w.db.rows<{ row_json: string }>('SELECT row_json FROM rs_asset').map((r) => JSON.parse(r.row_json));
    expect(assets.map((x) => x.status)).toEqual(['case-mismatch', 'case-mismatch']);
    const prepared = preparePackage(a.files);
    if (!prepared.ok) throw new Error('fixture');
    const bootstrap = validateHostedPackage({ files: a.files, originals: new Map(ds.map((d) => [d.ref, { path: real, sha256: sha256Hex(d.bytes), size: d.bytes.length, mediaType: 'application/pdf', status: 'case-mismatch', downloadOnly: false }])) });
    expect(out.caseMismatch).toEqual(bootstrap.caseMismatch);
    const coverage = buildCoverage({ assets: bootstrap.result.candidate!.assets, submission: a.submission, caseMismatch: out.caseMismatch, warningFingerprints: out.warningFingerprints });
    if (!coverage.ok) throw new Error('coverage');
    const facts = await readOriginalFacts({ ...w, clientId: ids.clientA, budgets: w.config.budgets }, caseId, prepared.fileAssets, coverage.coverage.mappedOriginals);
    expect(facts.kind).toBe('ok');
    expect(coverage.coverage.mappedOriginals[0].packageRefs).toEqual(['OD-001', 'OD-002']);
  });

  it('returns the uncapped genuine mismatch mapping beyond the diagnostic listing cap', async () => {
    const d = docs(1)[0], ds = Array.from({ length: 2002 }, (_, i) => ({ ...d, ref: 'OD-' + String(i + 1).padStart(4, '0') }));
    const w = setup(ds), a = await w.request(await w.upload(d.path.toUpperCase()));
    const out = await w.ports.stager.stage(a);
    expect(out.kind).toBe('staged');
    if (out.kind !== 'staged') return;
    expect(out.caseMismatch).toHaveLength(2002);
    expect(new Set(out.caseMismatch.map((x) => x.fingerprint)).size).toBe(2002);
    expect(out.caseMismatch.every((x) => out.warningFingerprints.includes(x.fingerprint))).toBe(true);
  });

  it('selects the explicit old revision at an occupied path, never the latest revision or a hash elsewhere', async () => {
    const w = setup(), old = await w.upload(), a = await w.request(old);
    await w.upload(docs(1)[0].path, pdf('newer unrelated bytes'), 'newer');
    expect((await w.ports.stager.stage(a)).kind).toBe('staged');
    const newer = await w.request(await w.upload('OTHER/same-bytes.pdf', docs(1)[0].bytes, 'hash-elsewhere'));
    expect(await w.ports.stager.stage(newer)).toMatchObject({ kind: 'refused', reason: 'original-link-required' });
  });

  it('does not fall back to folded bytes when the literal selected path has a wrong fingerprint', async () => {
    const w = setup(), a = await w.request(await w.upload(docs(1)[0].path, pdf('wrong bytes')));
    await w.upload(docs(1)[0].path.toUpperCase(), docs(1)[0].bytes, 'folded');
    expect(await w.ports.stager.stage(a)).toMatchObject({ kind: 'refused', reason: 'integrity' });
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
  });

  it('refuses an ambiguous fold across actual finalized revisions without inventing a warning', async () => {
    const w = setup(), d = docs(1)[0], a = await w.request(await w.upload(d.path.toUpperCase()));
    await w.upload(d.path.toLowerCase(), d.bytes, 'another-fold');
    expect(await w.ports.stager.stage(a)).toMatchObject({ kind: 'refused', reason: 'integrity' });
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
  });

  it.each(['missing-object', 'changed-object', 'association', 'foreign-association'] as const)('refuses %s originals even with a global hash object', async (failure) => {
    const w = setup(), a = await w.request(await w.upload()), key = 'orig/' + sha256Hex(docs(1)[0].bytes);
    if (failure === 'missing-object') w.bucket.objects.delete(key);
    if (failure === 'changed-object') w.bucket.tamper(key, (b) => { b[b.length - 1] ^= 1; return b; });
    if (failure === 'association' || failure === 'foreign-association') {
      w.db.exec('DELETE FROM rs_case_original WHERE case_id = ?', caseId);
      if (failure === 'foreign-association') w.db.exec('INSERT INTO rs_case_original (case_id, asset_id, sha256, filename, media_type, finalized_at) VALUES (?, ?, ?, ?, ?, \'2001-01-01T00:00:00Z\')', ids.caseB, a.submission.manifest.files[0].assetId, sha256Hex(docs(1)[0].bytes), docs(1)[0].path, 'application/pdf');
    }
    expect((await w.ports.stager.stage(a)).kind).toBe('refused');
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
  });

  it.each(['hash', 'bytes', 'path', 'revision', 'case'] as const)('refuses a changed caller submission %s snapshot before original bytes', async (field) => {
    const w = setup(), a = await w.request(await w.upload());
    const submission = JSON.parse(JSON.stringify(a.submission));
    if (field === 'hash') submission.storedManifestSha256 = '0'.repeat(64);
    if (field === 'bytes') submission.storedManifestBytes++;
    if (field === 'path') submission.manifest.files[0].path = 'OTHER/wrong.pdf';
    if (field === 'revision') submission.manifest.revisionId = 'subrev-not-finalized';
    if (field === 'case') submission.manifest.caseId = ids.caseB;
    const before = w.bucket.gets;
    expect(await w.ports.stager.stage({ ...a, submission })).toMatchObject({ kind: 'refused', reason: 'submission-changed' });
    expect(w.bucket.gets - before).toBe(1); // bounded storage identity, no original bytes
  });

  it('refuses a genuinely finalized foreign-case submission even when its hash also exists in this case', async () => {
    const w = setup(), a = await w.request(await w.upload());
    const foreignId = await w.upload(docs(1)[0].path, docs(1)[0].bytes, 'foreign-final', ids.caseB);
    const foreign = await w.submissions.finalized({ clientId: ids.clientA, caseId: ids.caseB, revisionId: foreignId });
    if (foreign.state !== 'finalized') throw new Error('fixture');
    expect(await w.ports.stager.stage({ ...a, submission: foreign })).toMatchObject({ kind: 'refused', reason: 'submission-changed' });
    expect(w.db.rows('SELECT * FROM rs_results_version')).toEqual([]);
  });

  it('does not accept a reserved submission even when GRS-115 already bound its original', async () => {
    const w = setup(), a = await w.request(await w.upload());
    const revisionId = await w.upload(docs(1)[0].path, docs(1)[0].bytes, 'reserved', caseId, false);
    expect(await w.ports.stager.stage({ ...a, submission: { ...a.submission, manifest: { ...a.submission.manifest, revisionId } } })).toMatchObject({ kind: 'refused', reason: 'submission-changed' });
  });

  it('rejects a changed persisted diagnostic state on repeat instead of reporting the fresh diagnostics as stored', async () => {
    const w = setup(), a = await w.request(await w.upload());
    expect((await w.ports.stager.stage(a)).kind).toBe('staged');
    w.db.exec('UPDATE rs_results_version SET diagnostics_sha256 = ?', '0'.repeat(64));
    expect(await w.ports.stager.stage(a)).toMatchObject({ kind: 'refused', reason: 'validation-changed' });
    expect(w.db.rows<{ diagnostics_sha256: string }>('SELECT diagnostics_sha256 FROM rs_results_version')[0].diagnostics_sha256).toBe('0'.repeat(64));
  });

  it('refuses a repeated version when an original disappeared after its stored validation', async () => {
    const w = setup(), a = await w.request(await w.upload(docs(1)[0].path.toUpperCase()));
    const first = await w.ports.stager.stage(a);
    expect(first.kind).toBe('staged');
    if (first.kind !== 'staged') return;
    expect(first.caseMismatch).toHaveLength(1);
    w.bucket.objects.delete('orig/' + sha256Hex(docs(1)[0].bytes));
    expect(await w.ports.stager.stage(a)).toMatchObject({ kind: 'refused', reason: 'integrity' });
    expect(w.db.rows<{ diagnostics_sha256: string }>('SELECT diagnostics_sha256 FROM rs_results_version')[0].diagnostics_sha256).toBe(first.diagnosticsSha256);
  });

  it('rechecks originals and exact persisted package/model on retries', async () => {
    const w = setup(), a = await w.request(await w.upload());
    expect((await w.ports.stager.stage(a)).kind).toBe('staged');
    const object = w.db.rows<{ object_key: string }>("SELECT object_key FROM rs_package_file WHERE path = 'assets.json'")[0].object_key;
    w.bucket.tamper(object, (b) => { b[1] ^= 1; return b; });
    await expect(w.ports.stager.stage(a)).rejects.toMatchObject({ code: 'integrity' });
  });

  it('fails with retryable storage semantics and recovers an interrupted staging attempt', async () => {
    const w = setup(), a = await w.request(await w.upload()), put = w.bucket.put.bind(w.bucket);
    let fail = true;
    w.bucket.put = async (...args) => { if (fail && args[0].startsWith('pkg/')) { fail = false; throw new Error('R2 unavailable'); } return put(...args); };
    await expect(w.ports.stager.stage(a)).rejects.toMatchObject({ code: 'storage-unavailable', retryable: true });
    expect((await w.ports.stager.stage(a)).kind).toBe('staged');
  });

  it('refuses a package of another case before storage metadata or original bytes', async () => {
    const w = setup(), a = await w.request(await w.upload());
    const foreign = buildFixture({ caseId: ids.caseB, docs: docs(1) });
    const before = { statements: w.db.statements, gets: w.bucket.gets };
    expect(await w.ports.stager.stage({ ...a, files: foreign.files, identity: { resultsVersion: resultsVersion(foreign.manifest.resultsVersion), manifestSha256: sha256Hex(foreign.files.get('manifest.json')!) } })).toMatchObject({ kind: 'refused', reason: 'wrong-case' });
    expect(w.db.statements).toBe(before.statements);
    expect(w.bucket.gets).toBe(before.gets);
  });

  it('detects an original changed while package objects are persisted, before staged success', async () => {
    const w = setup(), a = await w.request(await w.upload()), put = w.bucket.put.bind(w.bucket);
    let changed = false;
    w.bucket.put = async (...args) => {
      const result = await put(...args);
      if (!changed && args[0].startsWith('pkg/')) {
        changed = true;
        w.bucket.tamper('orig/' + sha256Hex(docs(1)[0].bytes), (b) => { b[b.length - 1] ^= 1; return b; });
      }
      return result;
    };
    expect(await w.ports.stager.stage(a)).toMatchObject({ kind: 'refused', reason: 'integrity' });
    expect(w.events.at(-1)?.outcome).toBe('refused');
    expect(w.db.rows('SELECT * FROM rs_publication')).toEqual([]);
  });

  it('does not trust a stored read model rewritten together with its digest on repeat', async () => {
    const w = setup(), a = await w.request(await w.upload());
    expect((await w.ports.stager.stage(a)).kind).toBe('staged');
    w.db.exec("UPDATE rs_document SET state_json = '{}' WHERE version_id = ?", a.identity.resultsVersion);
    const version = w.db.rows<{ overview: string; expected_documents: number; expected_assets: number; expected_seeds: number; expected_files: number }>('SELECT * FROM rs_results_version')[0];
    const model: StagedProjection = {
      documents: w.db.rows('SELECT * FROM rs_document'), seeds: w.db.rows('SELECT * FROM rs_seed'),
      assets: w.db.rows<{ row_json: string }>('SELECT row_json FROM rs_asset').map((r) => JSON.parse(r.row_json)),
      chronologyJson: JSON.stringify(w.db.rows<{ list_json: string }>('SELECT list_json FROM rs_document ORDER BY ord').map((r) => JSON.parse(r.list_json))),
      overview: version.overview, expect: { documents: version.expected_documents, assets: version.expected_assets, seeds: version.expected_seeds, files: version.expected_files },
    };
    w.db.exec('UPDATE rs_results_version SET read_model_sha256 = ?', await readModelDigest(model));
    await expect(w.ports.stager.stage(a)).rejects.toMatchObject({ code: 'integrity' });
  });

  it('preserves storage quota refusal', async () => {
    const w = setup(), a = await w.request(await w.upload());
    const ports = createHostedCandidateStager({ ...w.config, quotas: { ...w.config.quotas, maxPackageBytesPerCase: 1 } });
    expect(await ports.stager.stage(a)).toMatchObject({ kind: 'refused', reason: 'over-quota' });
  });
});
