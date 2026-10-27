// U15 acceptance: the chunked, resumable import. The poc package (fixtures:generate --profile poc) is imported in bounded
// batches, the process is killed at a random write and a fresh one resumes: the resultsVersion and the candidate must equal
// those of an uninterrupted import, no file is accepted twice, and a file whose bytes do not match the manifest is refused.
import { beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '../../../src/lib/case-package/limits.ts';
import { buildPackage } from '../../../src/lib/case-package/writer.ts';
import { nativeImportBudget, type LinkedCandidate } from '../../../src/lib/results-review/native/index.ts';
import { planBatches, stagedBatchCost, type StagedImport, type StagedOutcome } from '../../../src/lib/results-review/native/staging/index.ts';
import { ValidatingStager } from './doubles.ts';
import { buildFixture, pdf as syntheticPdf } from './fixtures.ts';
import { Durable, Killed, KILL_PHASES, RecordingStager, pocPackage, sha256Hex, startProcess, submissionOf, type Kill, type Process } from './staged-world.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const OP = 'op-staged-0001-0b7c2f3e1d2a4c5b';
const REVISION = 'subrev-staged';
const sizesOf = (files: ReadonlyMap<string, Uint8Array>, only: readonly string[]) => only.map((p) => [p, files.get(p)!.byteLength] as const);
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

interface Package { caseId: string; files: ReadonlyMap<string, Uint8Array>; originals: readonly { path: string; sha256: string; size: number }[] }
const assetOriginals = (files: ReadonlyMap<string, Uint8Array>) => {
  const index = JSON.parse(dec(files.get('assets.json')!)) as { assets: Record<string, { kind: string; path: string; sha256: string; size: number }> };
  const seen = new Map<string, { path: string; sha256: string; size: number }>();
  for (const a of Object.values(index.assets)) if (a.kind === 'file') seen.set(`${a.path}\0${a.sha256}`, { path: a.path, sha256: a.sha256, size: a.size });
  return [...seen.values()];
};

/** What a client does: open with the manifest, ask what is missing, send it in planned batches, then complete. Stops at a kill. */
async function drive(p: Process, pkg: Package, opts: { open?: boolean; complete?: boolean } = {}) {
  const staged = p.service.staged!;
  const manifest = pkg.files.get('manifest.json')!;
  if (opts.open !== false) {
    const opened = await staged.open(p.token, { operationId: OP, submissionRevisionId: REVISION, manifest });
    if (opened.kind !== 'progress') throw new Error('open refused ' + JSON.stringify(opened));
  }
  const requests: { files: number; bytes: number }[] = [];
  for (;;) {
    const s = await staged.status(p.token, { operationId: OP });
    if (s.kind !== 'progress') throw new Error('status refused ' + JSON.stringify(s));
    if (s.missing.length === 0) break;
    for (const batch of planBatches(sizesOf(pkg.files, s.missing), staged.bounds)) {
      const files = new Map(batch.map((path) => [path, pkg.files.get(path)!] as const));
      const out = await staged.put(p.token, { operationId: OP, files });
      if (out.kind !== 'progress') throw new Error('put refused ' + JSON.stringify(out));
      requests.push({ files: files.size, bytes: [...files.values()].reduce((n, b) => n + b.byteLength, 0) });
    }
  }
  const done = opts.complete === false ? null : await staged.complete(p.token, { operationId: OP });
  return { requests, done };
}
const linked = (o: unknown): LinkedCandidate => {
  const out = o as { kind: string; candidate?: LinkedCandidate };
  if (out.kind !== 'linked' || !out.candidate) throw new Error('not linked: ' + JSON.stringify(o));
  return out.candidate;
};
const rowCount = (d: Durable) => d.db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM native_import_staged_file')[0]!.n;

describe('the poc package imports in batches and survives a kill at any write', () => {
  let poc: Package;
  let reference: { candidate: LinkedCandidate; puts: number; rowBatches: number; requests: number };
  const options = (d: Durable, stager = new RecordingStager(), kill?: Kill) => ({ durable: d, caseId: poc.caseId, stager, kill: kill ?? null, maxBatchFiles: 4,
    submissions: submissionsFor(poc) });
  let submissionsFor: (p: Package) => ReturnType<typeof submissionOf> extends Promise<infer R> ? R : never;

  beforeAll(async () => {
    const loaded = await pocPackage();
    const originals = assetOriginals(loaded.files);
    poc = { ...loaded, originals };
    const reader = await submissionOf(poc.caseId, originals, REVISION);
    submissionsFor = () => reader;
    const durable = new Durable();
    const stager = new RecordingStager();
    const p = await startProcess(options(durable, stager));
    const out = await drive(p, poc);
    reference = { candidate: linked(out.done), puts: durable.stagedPuts.length, rowBatches: durable.counts.rowBatches, requests: out.requests.length };
    // The uninterrupted import is itself checked: every staged byte reached the stager unchanged.
    expect(stager.received!.size).toBe(poc.files.size);
    for (const [path, bytes] of poc.files) expect(Buffer.from(stager.received!.get(path)!).equals(Buffer.from(bytes))).toBe(true);
  }, 600_000);

  it('uses bounded batches of the real poc files, more than one of them', () => {
    expect(poc.files.size).toBe(37);
    expect(reference.requests).toBeGreaterThan(8);
    expect(reference.candidate.link.candidate.resultsVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('killed at a random write (seed %i) then resumed equals the uninterrupted import', async (seed) => {
    const random = rng(seed);
    const phase = KILL_PHASES[Math.floor(random() * KILL_PHASES.length)]!;
    const nth = 1 + Math.floor(random() * (phase.includes('r2') ? reference.puts : reference.rowBatches));
    const durable = new Durable();
    const dead = await startProcess(options(durable, new RecordingStager(), { phase, nth }));
    await expect(drive(dead, poc)).rejects.toSatisfy((e) => e instanceof Killed || (e as { cause?: unknown })?.cause instanceof Killed || /killed|storage-unavailable/i.test(String((e as Error).message) + String((e as { code?: string }).code)));

    // A new process over the same D1 and R2: status says what is missing; only that is sent.
    const stager = new RecordingStager();
    const alive = await startProcess(options(durable, stager));
    const before = durable.stagedPuts.length;
    const out = await drive(alive, poc, { open: true });
    const candidate = linked(out.done);

    expect(candidate.link.candidate.resultsVersion).toBe(reference.candidate.link.candidate.resultsVersion);
    expect(candidate.candidateId).toBe(reference.candidate.candidateId);
    expect(JSON.stringify(candidate)).toBe(JSON.stringify(reference.candidate));
    for (const [path, bytes] of poc.files) expect(Buffer.from(stager.received!.get(path)!).equals(Buffer.from(bytes))).toBe(true);
    // No file is accepted twice or lost: one ledger row per listed file, and no R2 key was written twice.
    expect(rowCount(durable)).toBe(poc.files.size - 1);
    expect(new Set(durable.stagedPuts).size).toBe(durable.stagedPuts.length);
    expect(durable.stagedPuts.length).toBe(reference.puts);
    expect(durable.stagedPuts.length - before).toBeLessThanOrEqual(reference.puts);
    expect(durable.db.rows('SELECT 1 FROM native_candidate').length).toBe(1);
  }, 120_000);

  it('a second complete answers the same candidate without staging again', async () => {
    const durable = new Durable();
    const stager = new RecordingStager();
    const p = await startProcess(options(durable, stager));
    const first = linked((await drive(p, poc)).done);
    const again = await p.service.staged!.complete(p.token, { operationId: OP });
    expect(again).toMatchObject({ kind: 'linked', repeated: true });
    expect(linked(again).candidateId).toBe(first.candidateId);
    expect(stager.calls).toBe(1);
  });

  it('refuses a file whose bytes do not match the manifest, writes nothing of that batch, and holds the import', async () => {
    const durable = new Durable();
    const stager = new RecordingStager();
    const p = await startProcess(options(durable, stager));
    const staged = p.service.staged!;
    await staged.open(p.token, { operationId: OP, submissionRevisionId: REVISION, manifest: poc.files.get('manifest.json')! });
    const paths = [...poc.files.keys()].filter((x) => x !== 'manifest.json').sort();
    const good = paths[0]!, victim = paths.find((x) => poc.files.get(x)!.byteLength > 100 && x !== good)!;
    const flipped = new Uint8Array(poc.files.get(victim)!);
    flipped[50] ^= 1; // same size, one bit different
    const objectsBefore = durable.r2.objects.size, rowsBefore = rowCount(durable);

    const refusal = await staged.put(p.token, { operationId: OP, files: new Map([[good, poc.files.get(good)!], [victim, flipped]]) });
    expect(refusal).toMatchObject({ kind: 'refused', code: 'file-mismatch' });
    expect((refusal as { detail: string[] }).detail.join(' ')).toContain(victim);
    expect(durable.r2.objects.size).toBe(objectsBefore);
    expect(rowCount(durable)).toBe(rowsBefore);

    const shortened = await staged.put(p.token, { operationId: OP, files: new Map([[victim, poc.files.get(victim)!.subarray(0, 99)]]) });
    expect(shortened).toMatchObject({ kind: 'refused', code: 'file-mismatch' });
    const unlisted = await staged.put(p.token, { operationId: OP, files: new Map([['datasets/not-in-the-manifest.json', enc('{}')]]) });
    expect(unlisted).toMatchObject({ kind: 'refused', code: 'file-not-in-manifest' });
    expect(rowCount(durable)).toBe(rowsBefore);

    // The import holds: it cannot be completed with the file missing, nothing reached the stager, and no candidate exists.
    const held = await staged.complete(p.token, { operationId: OP });
    expect(held).toMatchObject({ kind: 'refused', code: 'incomplete' });
    expect(stager.calls).toBe(0);
    expect(durable.db.rows('SELECT 1 FROM native_candidate')).toHaveLength(0);
    const status = await staged.status(p.token, { operationId: OP }) as Extract<StagedOutcome, { kind: 'progress' }>;
    expect(status.acceptedFiles).toBe(0);
    expect(status.state).toBe('open');

    // The right bytes then go through, and the import finishes as any other.
    const out = await drive(p, poc, { open: false });
    expect(linked(out.done).link.candidate.resultsVersion).toBe(reference.candidate.link.candidate.resultsVersion);
  });

  it('refuses a manifest that is not the package it names', async () => {
    const durable = new Durable();
    const p = await startProcess(options(durable));
    const text = dec(poc.files.get('manifest.json')!);
    const tampered = enc(text.replace(/"size": ?(\d+)/, (_m, n) => `"size": ${Number(n) + 1}`));
    const out = await p.service.staged!.open(p.token, { operationId: OP, submissionRevisionId: REVISION, manifest: tampered });
    expect(out).toMatchObject({ kind: 'refused', code: 'package-invalid' });
    expect(durable.db.rows('SELECT 1 FROM native_import_session')).toHaveLength(0);
  });
});

describe('a package past the old 1,024-file cap', () => {
  const N = 1500;
  function scalePackage() {
    const docs = Array.from({ length: N }, (_, i) => {
      const ref = `OD-${String(i + 1).padStart(4, '0')}`;
      return { ref, path: `Letters/${ref}.pdf`, bytes: syntheticPdf(`original ${ref}`), preview: syntheticPdf(`preview ${ref}`) };
    });
    const rows = docs.map((d, i) => ({ n: String(i + 1), ref: d.ref, date: '2001-01-01', filename: `${d.ref}.pdf`, subject: `Synthetic scale ${i + 1}`, sender: '', to: '', cc: '', excerpt: '', doc_type: 'other',
      bundle: '', amount: '', also_in: [], text_status: 'pending', url: '', refs: [], invoice_no: '', size: d.bytes.byteLength, seq: String(i + 1), attachments: [] }));
    const assets: Record<string, unknown> = {};
    const previews = new Map<string, Uint8Array>();
    for (const d of docs) {
      const previewPath = `previews/${d.ref}.pdf`;
      previews.set(previewPath, d.preview);
      assets[d.ref] = { kind: 'file', path: d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength, mediaType: 'application/pdf', textStatus: 'pending',
        preview: { path: previewPath, sha256: sha256Hex(d.preview), size: d.preview.byteLength, originalSha256: sha256Hex(d.bytes) } };
    }
    const prov = (s: string) => ({ source: 'synthetic-native', sourcePath: s, adapter: 'native-fixture@0' });
    const { files } = buildPackage({
      caseId: 'case-a', caseLabel: 'Synthetic scale', inputKind: 'synthetic-native',
      sources: [{ role: 'synthetic-html', name: 'workspace.html', sha256: sha256Hex(enc('html-scale')), size: 100 }], producer: { name: 'native-fixture', version: '1' }, created: '2001-01-01T00:00',
      datasets: [
        { key: 'chronology', kind: 'generated', schema: 'v5.chronology@1', required: true, provenance: prov('DATA.chronology'), data: rows },
        { key: 'matter', kind: 'authored', schema: 'v5.matter@1', required: true, provenance: prov('DATA.matter'), data: { title: 'Matter', short: 'M', forum: 'High Court', storyline: [{ h: 'Background', t: 'Synthetic.' }], strategy: [] } },
      ],
      assets: assets as never, previews,
    });
    return { docs, files };
  }

  it('imports through the real validator, in batches that stay inside the stated per-request cost', async () => {
    const { docs, files } = scalePackage();
    expect(files.size).toBeGreaterThan(1024);
    const stager = new ValidatingStager();
    stager.folder = new Map(docs.map((d) => [d.path, d.bytes]));
    const durable = new Durable();
    const reader = await submissionOf('case-a', docs.map((d) => ({ path: d.path, sha256: sha256Hex(d.bytes), size: d.bytes.byteLength })), REVISION);
    const p = await startProcess({ durable, caseId: 'case-a', stager, submissions: reader, rowsPerBatch: 50 });
    const pkg: Package = { caseId: 'case-a', files, originals: [] };

    const perRequest: { files: number; r2: number; d1: number }[] = [];
    const staged = p.service.staged!;
    const opened = await staged.open(p.token, { operationId: OP, submissionRevisionId: REVISION, manifest: files.get('manifest.json')! });
    expect(opened).toMatchObject({ kind: 'progress', state: 'open', expectedFiles: files.size - 1, acceptedFiles: 0 });
    for (;;) {
      const s = await staged.status(p.token, { operationId: OP }) as Extract<StagedOutcome, { kind: 'progress' }>;
      if (s.missing.length === 0) break;
      for (const batch of planBatches(sizesOf(files, s.missing), staged.bounds)) {
        const r2 = durable.counts.r2, d1 = durable.counts.d1;
        const out = await staged.put(p.token, { operationId: OP, files: new Map(batch.map((x) => [x, files.get(x)!] as const)) });
        expect(out.kind).toBe('progress');
        perRequest.push({ files: batch.length, r2: durable.counts.r2 - r2, d1: durable.counts.d1 - d1 });
      }
    }
    expect(perRequest.length).toBe(Math.ceil((files.size - 1) / staged.bounds.maxBatchFiles));
    for (const r of perRequest) {
      expect(r.files).toBeLessThanOrEqual(staged.bounds.maxBatchFiles);
      const cost = stagedBatchCost(r.files, 50);
      expect(r.r2).toBeLessThanOrEqual(cost.r2);
      expect(r.d1).toBeLessThanOrEqual(cost.d1);
    }
    const done = await staged.complete(p.token, { operationId: OP });
    expect(linked(done).link.coverage.mappedOriginals).toHaveLength(N);
    expect(pkg.files.size).toBe(files.size);
  }, 300_000);
});

describe('the reviewed ceiling', () => {
  it('raises the package file cap from 1,024 to 8,192 everywhere it is stated, and no further', () => {
    expect(LIMITS.packageFiles).toBe(8192);
    expect(LIMITS.archiveEntries).toBe(8192);
    expect(LIMITS.manifestBytes).toBe(4 * 1024 * 1024);
    const budget = { maxRequestBytes: 1 << 20, maxFiles: 8192, maxFileBytes: 1 << 19, maxPackageBytes: 1 << 30 };
    expect(nativeImportBudget(budget)).not.toBeNull();
    expect(nativeImportBudget({ ...budget, maxFiles: 8193 })).toBeNull();
  });
});

describe('the small-package path is unchanged', () => {
  it('has no staged API until the ledger and the store are composed, and the one-request import links as before', async () => {
    const doc = { ref: 'OD-001', path: 'Letters/A.pdf', bytes: syntheticPdf('a') };
    const fx = buildFixture({ docs: [doc] });
    const reader = await submissionOf('case-a', [{ path: doc.path, sha256: sha256Hex(doc.bytes), size: doc.bytes.byteLength }], REVISION);
    const durable = new Durable();
    const p = await startProcess({ durable, caseId: 'case-a', stager: new RecordingStager(), submissions: reader, staging: false });
    expect(p.service.staged).toBeNull();
    const out = await p.service.importPackage(p.token, { operationId: OP, submissionRevisionId: REVISION, files: fx.files });
    expect(out.kind).toBe('linked');
    expect(durable.db.rows('SELECT 1 FROM native_import_session')).toHaveLength(0);
    expect(durable.r2.objects.size).toBe(0);
  });
});

export type { StagedImport };
