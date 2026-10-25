import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { importCandidate } from '../../../src/lib/case-package/import.ts';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import { validateHostedPackage } from '../../../src/lib/case-package/hosted-validation.ts';
import { acknowledge, canActivate } from '../../../src/lib/case-package/policy.ts';
import type { OriginalFact } from '../../../src/lib/results/hosted/project.ts';
import { buildSynth, editManifestOnly, editPackage, resealFiles } from '../../case-package/fixtures/build.ts';
import { bytes, complete, docs, factsFor, fixture, parity } from './fixture.ts';

const json = (files: Map<string, Uint8Array>, p: string) => JSON.parse(new TextDecoder().decode(files.get(p)!));

describe('offline canonical importCandidate parity', () => {
  it('accepts an intact package with byte-verified originals, with unchanged identities', async () => {
    const f = fixture();
    const { result, caseMismatch } = await parity(f.files, f.stored, factsFor(f.docs, f.stored));
    expect(result.verdict).toBe('accept');
    expect(result.diagnostics).toEqual([]);
    expect(caseMismatch).toEqual([]);
    expect(result.candidate?.resultsVersion).toBe(json(f.files, 'manifest.json').resultsVersion);
    expect(result.candidate?.caseId).toBe('synthetic-hosted-validator');
  });

  it.each(['case', 'NFC'] as const)('reproduces genuine %s mismatch messages, context and fingerprints', async (kind) => {
    const f = fixture();
    const stored = new Map([...f.stored].map(([p, b]) => [kind === 'case' ? p.toLowerCase() : p.normalize('NFD'), b]));
    const { result, canonical, caseMismatch } = await parity(f.files, stored, factsFor(f.docs, stored));
    expect(result.verdict).toBe('report');
    const warnings = canonical.diagnostics.filter((d) => d.code === 'ORIG_CASE_MISMATCH');
    expect(warnings).toHaveLength(2);
    expect(caseMismatch).toEqual(warnings.map((d) => ({ ref: d.subject!, fingerprint: d.fingerprint })));
    expect(result.candidate?.original('OD-001')?.path).toBe([...stored.keys()][0]);
  });

  it('keeps every warning fingerprint and exact mismatch lineage past the listing cap', async () => {
    const f = fixture(docs(9));
    const stored = new Map([...f.stored].map(([p, b]) => [p.toLowerCase(), b]));
    const facts = factsFor(f.docs, stored);
    const { result, caseMismatch, canonical } = await parity(f.files, stored, facts, { diagnosticsPerCode: 1 });
    const full = validateHostedPackage({ files: f.files, originals: facts });
    expect(result.counts.ORIG_CASE_MISMATCH).toBe(9);
    expect(result.diagnostics.filter((d) => d.code === 'ORIG_CASE_MISMATCH')).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.code === 'DIAG_TRUNCATED')).toBe(true);
    expect(result.warningFingerprints).toHaveLength(9);
    expect(result.warningFingerprints).toEqual(full.result.warningFingerprints);
    expect(caseMismatch).toEqual(full.caseMismatch);
    expect(caseMismatch.map((d) => d.fingerprint).sort()).toEqual(canonical.warningFingerprints);
    expect(canActivate(result, null).ok).toBe(false);
    expect(canActivate(result, acknowledge(result, result.warningFingerprints)).ok).toBe(true);
    expect(canActivate(result, acknowledge(result, [result.diagnostics.find((d) => d.code === 'ORIG_CASE_MISMATCH')!.fingerprint])).ok).toBe(false);
  });

  it('preserves uncapped warning identities across several capped codes', async () => {
    const f = fixture(docs(7));
    const files = editPackage(f.files, 'assets.json', (v) => { for (const a of Object.values(v.assets) as { textStatus: string }[]) a.textStatus = 'none'; });
    const { result, caseMismatch } = await parity(files, new Map(), new Map(), { diagnosticsPerCode: 1 });
    expect(result.counts.ORIG_MISSING).toBe(7);
    expect(result.counts.TEXT_NONE).toBe(7);
    expect(result.warningFingerprints).toHaveLength(14);
    expect(result.diagnostics.filter((d) => d.severity === 'warning')).toHaveLength(2);
    expect(caseMismatch).toEqual([]);
  });

  it('keeps a genuine mismatch mapping even when a different original rejects the import', async () => {
    const f = fixture();
    const stored = new Map([[f.docs[0]!.path.replace('Letter', 'letter'), f.docs[0]!.bytes], [f.docs[1]!.path, bytes('wrong')]]);
    const { result, caseMismatch } = await parity(f.files, stored, factsFor(f.docs, stored));
    expect(result.verdict).toBe('reject');
    expect(caseMismatch).toHaveLength(1);
    expect(result.warningFingerprints).toContain(caseMismatch[0]!.fingerprint);
  });

  it('reports missing originals and deduplicates cited-unavailable diagnostics', async () => {
    const f = fixture();
    const files = editPackage(f.files, 'datasets/chronology.json', (v) => { v.data[0].refs = ['OD-002', 'OD-002']; });
    const stored = new Map([[f.docs[0]!.path, f.docs[0]!.bytes]]);
    const { result } = await parity(files, stored, factsFor(f.docs, stored));
    expect(result.verdict).toBe('report');
    expect(result.counts.ORIG_MISSING).toBe(1);
    expect(result.counts.CITE_TARGET_NO_ORIGINAL).toBe(1);
    expect(result.candidate?.original('OD-002')).toBeNull();
    expect(result.candidate?.isUnavailable('OD-002')).toBe(true);
  });

  it('does not promote package-declared missing assets even when facts contain their ref', async () => {
    const f = fixture();
    const files = editPackage(f.files, 'assets.json', (v) => { v.assets['OD-002'] = { kind: 'missing', path: f.docs[1]!.path, mediaType: 'application/pdf', textStatus: 'pending' }; });
    const { result } = await parity(files, f.stored, factsFor(f.docs, f.stored));
    expect(result.verdict).toBe('report');
    expect(result.counts.ASSET_MISSING_AT_BUILD).toBe(1);
    expect(result.candidate?.isUnavailable('OD-002')).toBe(true);
    expect(result.candidate?.original('OD-002')).toBeNull();
  });

  it('flags a cited embedded descendant when its container is unavailable', async () => {
    const f = fixture();
    let files = editPackage(f.files, 'assets.json', (v) => {
      v.assets['OD-001'].mediaType = 'message/rfc822';
      v.assets['OD-001.a1'] = { kind: 'embedded', parentRef: 'OD-001', ordinal: 1, member: 'letter.pdf', mediaType: 'application/pdf', textStatus: 'pending' };
    });
    files = editPackage(files, 'datasets/chronology.json', (v) => { v.data[1].refs = ['OD-001.a1', 'OD-001.a1']; });
    const stored = new Map([[f.docs[1]!.path, f.docs[1]!.bytes]]);
    const { result } = await parity(files, stored, factsFor(f.docs, stored));
    expect(result.verdict).toBe('report');
    expect(result.diagnostics.filter((d) => d.code === 'CITE_TARGET_NO_ORIGINAL').map((d) => d.subject)).toEqual(['OD-001.a1']);
  });

  it('treats an ambiguous case-fold lookup as missing, never verified', async () => {
    const f = fixture();
    const stored = new Map([[f.docs[0]!.path.replace('Letter', 'letter'), f.docs[0]!.bytes], [f.docs[0]!.path.replace('Letter', 'LETTER'), f.docs[0]!.bytes]]);
    const { result, caseMismatch } = await parity(f.files, stored, factsFor(f.docs, stored));
    expect(result.verdict).toBe('report');
    expect(result.counts.ORIG_MISSING).toBe(2);
    expect(caseMismatch).toEqual([]);
    expect(result.candidate?.originalRefs()).toEqual([]);
  });

  it('uses verified sniff facts for content-type warnings and download-only mappings', async () => {
    const ds = docs();
    ds[0]!.bytes = bytes('<!doctype html><html>synthetic disguised PDF</html>');
    const f = fixture(ds);
    const { result } = await parity(f.files, f.stored, factsFor(f.docs, f.stored));
    expect(result.verdict).toBe('report');
    expect(result.counts.ORIG_MEDIA_MISMATCH).toBe(1);
    expect(result.candidate?.original('OD-001')?.downloadOnly).toBe(true);
  });

  it.each(['size', 'sha256'] as const)('rejects verified facts that disagree on %s', async (kind) => {
    const f = fixture();
    const changed = kind === 'size' ? bytes('short') : new Uint8Array(f.docs[0]!.bytes);
    if (kind === 'sha256') changed[changed.length - 2] = 33;
    const stored = new Map(f.stored).set(f.docs[0]!.path, changed);
    const { result } = await parity(f.files, stored, factsFor(f.docs, stored));
    expect(result.verdict).toBe('reject');
    expect(result.counts.ORIG_FINGERPRINT_MISMATCH).toBe(1);
    expect(result.candidate).toBeNull();
    expect(canActivate(result, null).ok).toBe(false);
  });

  it('deduplicates the original-byte budget by real path for aliases', async () => {
    const ds = docs();
    ds[1] = { ...ds[0]!, ref: ds[1]!.ref };
    const f = fixture(ds);
    const { result } = await parity(f.files, f.stored, factsFor(f.docs, f.stored), { originalsTotalBytes: ds[0]!.bytes.byteLength });
    expect(result.verdict).toBe('accept');
    expect(result.counts.ASSET_SHARED_PATH).toBe(1);
    expect(result.candidate?.originalRefs()).toHaveLength(2);
  });

  it('checks observed original size bounds before applying any facts', async () => {
    const f = fixture();
    const stored = new Map(f.stored).set(f.docs[0]!.path, new Uint8Array(200));
    const { result } = await parity(f.files, stored, factsFor(f.docs, stored), { originalBytes: 100 });
    expect(result.verdict).toBe('reject');
    expect(result.counts.ORIG_TOO_LARGE).toBe(1);
  });

  it('checks the unique observed original total, not only declared sizes', async () => {
    const f = fixture();
    const stored = new Map(f.stored).set(f.docs[0]!.path, new Uint8Array(200));
    const { result } = await parity(f.files, stored, factsFor(f.docs, stored), { originalsTotalBytes: 150 });
    expect(result.verdict).toBe('reject');
    expect(result.counts.ORIG_TOTAL_TOO_LARGE).toBe(1);
  });
});

it('matches the full synthetic v5 corpus through the actual canonical importer', async () => {
  const built = await buildSynth('hosted-validator');
  try {
    const canonical = await importCandidate({ files: built.files }, built.caseDir);
    expect(canonical.verdict).not.toBe('reject');
    const facts = new Map<string, OriginalFact>();
    for (const ref of canonical.candidate!.originalRefs()) {
      const { ref: _ref, ...fact } = canonical.candidate!.original(ref)!;
      facts.set(ref, fact);
    }
    const hosted = validateHostedPackage({ files: built.files, originals: facts });
    expect(complete(hosted.result)).toEqual(complete(canonical));
    expect(hosted.result.candidate!.datasetKeys().length).toBeGreaterThan(30);
  } finally { await rm(built.root, { recursive: true, force: true }); }
});

const mutations: [string, (f: Map<string, Uint8Array>) => Map<string, Uint8Array>, string][] = [
  ['absent manifest', (f) => { f.delete('manifest.json'); return f; }, 'PKG_MANIFEST_MISSING'],
  ['unsupported format', (f) => editManifestOnly(f, (m) => { m.formatVersion = 2; }), 'VER_UNSUPPORTED'],
  ['invalid manifest', (f) => editManifestOnly(f, (m) => { delete m.case; }), 'PKG_MANIFEST_INVALID'],
  ['wrong results identity', (f) => editManifestOnly(f, (m) => { m.resultsVersion = 'sha256:' + '0'.repeat(64); }), 'PKG_VERSION_MISMATCH'],
  ['wrong input identity', (f) => editManifestOnly(f, (m) => { m.inputRevision.id = 'sha256:' + '0'.repeat(64); }), 'PKG_INPUT_REVISION_MISMATCH'],
  ['missing listed file', (f) => { f.delete('assets.json'); return f; }, 'PKG_FILE_MISSING'],
  ['byte tamper', (f) => { f.set('assets.json', bytes('{}')); return f; }, 'PKG_FILE_HASH_MISMATCH'],
  ['noncanonical JSON', (f) => { f.set('assets.json', bytes(JSON.stringify(json(f, 'assets.json')))); return resealFiles(f); }, 'PKG_NONCANONICAL'],
  ['duplicate JSON key', (f) => { f.set('assets.json', bytes('{"index":1,"index":2}')); return resealFiles(f); }, 'JSON_DUPLICATE_KEY'],
  ['bad UTF-8', (f) => { f.set('assets.json', new Uint8Array([0xff])); return resealFiles(f); }, 'JSON_BAD_UTF8'],
  ['traversal transport', (f) => f.set('../untrusted', bytes('bad')), 'PKG_PATH_TRAVERSAL'],
  ['record shape', (f) => editPackage(f, 'datasets/chronology.json', (v) => { delete v.data[0].filename; }), 'DS_SHAPE_INVALID'],
  ['duplicate ref', (f) => editPackage(f, 'datasets/chronology.json', (v) => { v.data[1].ref = v.data[0].ref; }), 'ID_DUPLICATE'],
  ['envelope schema', (f) => editPackage(f, 'datasets/chronology.json', (v) => { v.schema = 'unknown@1'; }), 'DS_SCHEMA_UNSUPPORTED'],
  ['wrong count', (f) => editPackage(f, 'datasets/chronology.json', (v) => { v.count = 3; }), 'DS_COUNT_MISMATCH'],
  ['unsafe link', (f) => editPackage(f, 'datasets/chronology.json', (v) => { v.data[0].url = 'javascript:alert(1)'; }), 'LINK_UNSAFE_SCHEME'],
  ['user work', (f) => editManifestOnly(f, (m) => { m.extensions = { 'x-carry': { syn_notes_v1: [] } }; }), 'DS_USERWORK_EMBEDDED'],
  ['path traversal', (f) => editPackage(f, 'assets.json', (v) => { v.assets['OD-001'].path = '../escape.pdf'; }), 'ASSET_PATH_TRAVERSAL'],
  ['reserved original', (f) => editPackage(f, 'assets.json', (v) => { v.assets['OD-001'].path = '.clearcase/secret.pdf'; }), 'ASSET_PATH_RESERVED'],
  ['case collision', (f) => editPackage(f, 'assets.json', (v) => { v.assets['OD-002'].path = v.assets['OD-001'].path.toLowerCase(); }), 'ASSET_AMBIGUOUS_MAPPING'],
];

it.each(mutations)('matches complete canonical rejection: %s', async (_name, mutate, code) => {
  const f = fixture();
  const { result } = await parity(mutate(new Map(f.files)), f.stored, factsFor(f.docs, f.stored));
  expect(result.verdict).toBe('reject');
  expect(result.counts[code]).toBeGreaterThan(0);
});

it.each([
  ['manifestBytes', 1], ['fileBytes', 1], ['packageBytes', 1], ['packageFiles', 1], ['datasets', 0], ['assets', 0], ['originalBytes', 1], ['originalsTotalBytes', 1],
] as const)('matches canonical rejection under %s=%i', async (key, value) => {
  const f = fixture();
  const { result } = await parity(f.files, f.stored, factsFor(f.docs, f.stored), { [key]: value });
  expect(result.verdict).toBe('reject');
});

it('preserves unresolved-citation diagnostics and ignores unlisted bytes without importing them', async () => {
  const f = fixture();
  const files = editPackage(f.files, 'datasets/chronology.json', (v) => { v.data[0].refs = ['XD-999']; });
  files.set('extra.json', bytes('not even JSON'));
  const { result } = await parity(files, f.stored, factsFor(f.docs, f.stored));
  expect(result.verdict).toBe('report');
  expect(result.counts.CITE_UNRESOLVED).toBe(1);
  expect(result.counts.PKG_UNLISTED_FILE).toBe(1);
  expect(result.candidate?.fileBytes('extra.json')).toBeNull();
});

it('does not accept original claims embedded as asset status fields', async () => {
  const f = fixture();
  const files = editPackage(f.files, 'assets.json', (v) => { v.assets['OD-001'].status = 'verified'; });
  const { result } = await parity(files, new Map(), new Map());
  expect(result.candidate?.originalRefs() ?? []).toEqual([]);
  expect(result.verdict === 'reject' || result.counts.ORIG_MISSING > 0).toBe(true);
});

describe('trusted-facts contract defenses', () => {
  it.each([
    { status: 'claimed' }, { status: undefined }, { path: '../escape' }, { path: '.clearcase/private' },
    { path: 'somewhere-else.pdf' }, { path: 'docs/letter café 0.pdf', status: 'verified' },
    { status: 'case-mismatch' }, { sha256: '' }, { size: undefined }, { size: -1 }, { mediaType: 'text/html' }, { downloadOnly: undefined },
  ])('keeps malformed or inconsistent facts unavailable: %j', (change) => {
    const f = fixture();
    const facts = factsFor(f.docs, f.stored);
    facts.set('OD-001', { ...facts.get('OD-001')!, ...change } as OriginalFact);
    const r = validateHostedPackage({ files: f.files, originals: facts });
    expect(r.result.verdict).toBe('report');
    expect(r.result.candidate?.original('OD-001')).toBeNull();
    expect(r.result.candidate?.isUnavailable('OD-001')).toBe(true);
    expect(r.result.counts.ORIG_MISSING).toBe(1);
    expect(r.caseMismatch).toEqual([]);
  });

  it('does not treat presence-only facts as verification', () => {
    const f = fixture();
    const facts = new Map([['OD-001', {}], ['OD-002', { status: 'verified' }]]) as unknown as Map<string, OriginalFact>;
    const r = validateHostedPackage({ files: f.files, originals: facts });
    expect(r.result.verdict).toBe('report');
    expect(r.result.counts.ORIG_MISSING).toBe(2);
    expect(r.result.candidate?.originalRefs()).toEqual([]);
  });

  it('keeps contradictory positive facts for one real file unavailable', () => {
    const ds = docs();
    ds[1] = { ...ds[0]!, ref: ds[1]!.ref };
    const f = fixture(ds);
    const facts = factsFor(f.docs, f.stored);
    facts.get('OD-002')!.sha256 = '0'.repeat(64);
    const { result } = validateHostedPackage({ files: f.files, originals: facts });
    expect(result.verdict).toBe('report');
    expect(result.counts.ORIG_MISSING).toBe(2);
    expect(result.candidate?.originalRefs()).toEqual([]);
  });

  it('binds warning identities to indexed bytes/path, not just the package-local ref', async () => {
    const f = fixture(docs(1));
    const stored = new Map([...f.stored].map(([p, b]) => [p.toLowerCase(), b]));
    const first = await parity(f.files, stored, factsFor(f.docs, stored));
    const changedDocs = f.docs.map((d) => ({ ...d, bytes: bytes('%PDF-1.4\n% new synthetic original\n%%EOF\n') }));
    const next = fixture(changedDocs);
    const nextStored = new Map([...next.stored].map(([p, b]) => [p.toLowerCase(), b]));
    const second = await parity(next.files, nextStored, factsFor(next.docs, nextStored));
    expect(first.caseMismatch[0]!.ref).toBe(second.caseMismatch[0]!.ref);
    expect(first.caseMismatch[0]!.fingerprint).not.toBe(second.caseMismatch[0]!.fingerprint);
    expect(canActivate(second.result, acknowledge(first.result, first.result.warningFingerprints)).ok).toBe(false);
  });

  it('contains unexpected source failures rather than throwing or defaulting to accept', () => {
    const f = fixture();
    const files: ReadonlyMap<string, Uint8Array> = new Map(f.files);
    Object.defineProperty(files, Symbol.iterator, { value: () => { throw new Error('synthetic failure'); } });
    const r = validateHostedPackage({ files, originals: new Map() });
    expect(r.result.verdict).toBe('reject');
    expect(r.result.candidate).toBeNull();
    expect(r.result.counts).toEqual({ PKG_UNPROCESSABLE: 1 });
  });

  it('returns frozen identities/results and defensive file/fact snapshots, without mutating its inputs', () => {
    const f = fixture();
    const stored = new Map([...f.stored].map(([p, b]) => [p.toLowerCase(), b]));
    const facts = factsFor(f.docs, stored);
    const out = validateHostedPackage({ files: f.files, originals: facts });
    const before = structuredClone(complete(out.result));
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.result)).toBe(true);
    expect(Object.isFrozen(out.result.diagnostics)).toBe(true);
    expect(out.result.diagnostics.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(out.result.counts)).toBe(true);
    expect(Object.isFrozen(out.result.warningFingerprints)).toBe(true);
    expect(Object.isFrozen(out.result.errorFingerprints)).toBe(true);
    expect(Object.isFrozen(out.caseMismatch)).toBe(true);
    expect(out.caseMismatch.every(Object.isFrozen)).toBe(true);
    const c = out.result.candidate!;
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.manifest.files)).toBe(true);
    expect(Object.isFrozen(c.original('OD-001'))).toBe(true);
    expect(Object.isFrozen(facts.get('OD-001'))).toBe(false);
    f.files.get('manifest.json')!.fill(0);
    f.files.clear();
    facts.get('OD-001')!.path = 'changed';
    facts.clear();
    c.fileBytes('assets.json')!.fill(0);
    [...c.snapshot()][0]!.bytes.fill(0);
    expect(complete(out.result)).toEqual(before);
    expect(canonicalBytes(c.manifest).byteLength).toBeGreaterThan(0);
  });
});
