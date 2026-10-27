// U9 scaled PDF evidence beyond the decisive case. SDK BOUNDARY DOUBLES ONLY, over the real 0001-0004 viewer migrations in
// SQLite: the page double fabricates canvas proofs, so nothing here is renderer acceptance. Every input is synthetic.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareHostedPdfAssets } from '../../../scripts/hosted-pdf-assets.ts';
import { installWorkerdRedirectContract } from '../workerd-redirect-contract.ts';
import { createNativePdfEvidenceChecker, createNativePreviewRenderChecker, NATIVE_PDF_EVIDENCE_CEILINGS, NATIVE_PDF_RENDER_CEILINGS, pdfEvidenceStepCost }
 from '../../../src/lib/viewer/hosted/native-render-check.ts';
import { receiptJson } from '../../../src/lib/viewer/hosted/pdf-content-receipts.ts';
import type { NativePdfEvidenceBudget, PdfEvidenceDocument } from '../../../src/lib/viewer/hosted/render-check-contract.ts';
import { clientId, doc, evidenceOptions, pdfBrowser, pdfDatabase, step, syntheticPdf, DAY_MS, type PdfScript } from './pdf-evidence-world.ts';

const sdk = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: sdk.launch } }));
const root = mkdtempSync(join(tmpdir(), 'clearcase-pdf-evidence-scale-'));
const pins = prepareHostedPdfAssets({ root: resolve('.'), publicRoot: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));
let restoreRequest: (() => void) | undefined;
beforeAll(() => { restoreRequest = installWorkerdRedirectContract(); });
afterAll(() => restoreRequest?.());
let clock = 20_000 * DAY_MS + 10_000;
beforeEach(() => { sdk.launch.mockReset(); clock = 20_000 * DAY_MS + 10_000; });
const LEASE_MS = NATIVE_PDF_EVIDENCE_CEILINGS.maxSessionMs + 62_000;

function world(script: Map<string, PdfScript>, budget: Partial<NativePdfEvidenceBudget> = {}, db = pdfDatabase()) {
 const boundary = pdfBrowser(script);
 sdk.launch.mockImplementation(async () => boundary.launch());
 const options = evidenceOptions(db, pins, root, () => clock, budget, NATIVE_PDF_EVIDENCE_CEILINGS);
 return { db, boundary, options, checker: createNativePdfEvidenceChecker(options).then(c => c!) };
}
function corpus(n: number, totalPages = 3) {
 const pdfs = Array.from({ length: n }, (_, i) => syntheticPdf(`document ${i}`));
 return { pdfs, script: new Map(pdfs.map(p => [p.sha256, { totalPages }] as const)) };
}
const verdicts = (outcomes: readonly { assetId: string; state: string; pages: number | null; checkedPages: readonly number[]; reason: string | null }[]) =>
 outcomes.map(({ assetId, state, pages, checkedPages, reason }) => ({ assetId, state, pages, checkedPages, reason }));
const receipts = (db: ReturnType<typeof pdfDatabase>) => db.sqlite.prepare('SELECT input_sha256, page_set FROM npr_content_receipts ORDER BY input_sha256, page_set').all();

describe('U9 resumable steps', () => {
 it('a step killed mid-batch resumes from its sealed receipts and reaches the uninterrupted result, rendering only the unsealed documents again', async () => {
  const { pdfs, script } = corpus(6);
  const documents = () => pdfs.map((p, i) => doc(`asset-${i}`, p, [2]));
  const control = world(script);
  const uninterrupted = await (await control.checker).step(step('candidate-1', 'a', documents()));
  expect(uninterrupted.remaining).toEqual([]);

  const killed = world(script);
  killed.db.state.killAfterReceipts = 3;
  await (await killed.checker).step(step('candidate-1', 'a', documents()));
  expect(killed.db.state.killed).toBe(true);
  expect(killed.boundary.inspected).toHaveLength(4);
  expect(receipts(killed.db)).toHaveLength(3);

  // A fresh isolate on the same D1. The killed session's lease is still held, so the first resume is refused without a launch.
  const early = world(script, {}, pdfDatabase(killed.db.sqlite));
  const refused = await (await early.checker).step(step('candidate-1', 'a', documents()));
  expect(refused).toMatchObject({ sessions: 0, stopped: 'render-admission-refused', remaining: ['asset-3', 'asset-4', 'asset-5'] });
  expect(refused.outcomes.map(o => [o.assetId, o.receipt])).toEqual([['asset-0', 'reused'], ['asset-1', 'reused'], ['asset-2', 'reused']]);
  expect(early.boundary.inspected).toEqual([]);

  clock += LEASE_MS;
  const resumed = world(script, {}, pdfDatabase(killed.db.sqlite));
  const reads = pdfs.map(() => ({ n: 0 }));
  const after = await (await resumed.checker).step(step('candidate-1', 'a', pdfs.map((p, i) => doc(`asset-${i}`, p, [2], reads[i]))));
  expect(after.remaining).toEqual([]);
  expect(verdicts(after.outcomes)).toEqual(verdicts(uninterrupted.outcomes));
  expect(after.outcomes.map(o => o.receipt)).toEqual(['reused', 'reused', 'reused', 'created', 'created', 'created']);
  expect(reads.map(r => r.n)).toEqual([0, 0, 0, 1, 1, 1]);
  expect(resumed.boundary.inspected.map(d => d.sha256)).toEqual(pdfs.slice(3).map(p => p.sha256));
  expect(receipts(killed.db)).toEqual(receipts(control.db));
 });

 it('drives a 100-document candidate to completion in bounded steps, each within its computed cost', async () => {
  const { pdfs, script } = corpus(100);
  const budget = { maxDocumentsPerStep: 40, maxRendersPerSession: 8 };
  const w = world(script, budget), checker = await w.checker;
  const cost = pdfEvidenceStepCost({ ...NATIVE_PDF_EVIDENCE_CEILINGS, ...budget });
  const reads = { n: 0 };
  let documents: PdfEvidenceDocument[] = pdfs.map((p, i) => doc(`asset-${String(i).padStart(3, '0')}`, p, [3], reads));
  const settled: string[] = [];
  let steps = 0;
  while (documents.length) {
   const before = { d1: w.db.state.calls, reads: reads.n, assets: vi.mocked(w.options.assets!.fetch).mock.calls.length, launches: sdk.launch.mock.calls.length };
   const started = performance.now();
   const r = await checker.step(step('candidate-1', 'a', documents));
   steps++;
   const subrequests = (w.db.state.calls - before.d1) + (reads.n - before.reads) + (vi.mocked(w.options.assets!.fetch).mock.calls.length - before.assets);
   expect(subrequests).toBeLessThanOrEqual(cost.subrequests);
   expect(performance.now() - started).toBeLessThanOrEqual(cost.wallMs);
   expect(sdk.launch.mock.calls.length - before.launches).toBe(r.sessions);
   expect(r.outcomes.filter(o => o.receipt === 'created')).toHaveLength(Math.min(8, documents.length));
   expect(r.stopped).toBeNull();
   settled.push(...r.outcomes.map(o => o.assetId));
   documents = documents.filter(d => r.remaining.includes(d.assetId));
   clock += LEASE_MS;
  }
  expect(steps).toBe(13);
  expect(settled.sort()).toEqual(pdfs.map((_, i) => `asset-${String(i).padStart(3, '0')}`));
  expect(w.boundary.contexts).toEqual({ opened: 100, closed: 100 });
  const again = await checker.step(step('candidate-2', 'b', pdfs.slice(0, 40).map((p, i) => doc(`asset-${i}`, p, [3]))));
  expect(again).toMatchObject({ sessions: 0, remaining: [], stopped: null });
  expect(again.outcomes.every(o => o.state === 'rendered' && o.receipt === 'reused')).toBe(true);
 });

 it('stops a session at its byte and time bounds and leaves the rest for the next step', async () => {
  const { pdfs, script } = corpus(4);
  const size = pdfs[0]!.size;
  const bytes = world(script, { maxSessionBytes: size * 2, maxFileBytes: size * 2 });
  const r = await (await bytes.checker).step(step('candidate-1', 'a', pdfs.map((p, i) => doc(`asset-${i}`, p, []))));
  expect(r).toMatchObject({ sessions: 1, stopped: null, remaining: ['asset-2', 'asset-3'] });

  clock += LEASE_MS;
  script.set(pdfs[1]!.sha256, { totalPages: 3, behaviour: 'hang' });
  const slow = world(script, { maxDocumentMs: 300, maxSessionMs: 2_000 });
  const started = performance.now();
  const s = await (await slow.checker).step(step('candidate-1', 'a', pdfs.map((p, i) => doc(`asset-${i}`, p, []))));
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(s.outcomes).toEqual([expect.objectContaining({ assetId: 'asset-0', state: 'rendered' }),
   expect.objectContaining({ assetId: 'asset-1', state: 'failed', reason: 'render-timeout', receipt: null })]);
  expect(s).toMatchObject({ stopped: 'render-timeout', remaining: ['asset-2', 'asset-3'] });
 });

 it('admits one session at a time per client and at most the configured sessions per day', async () => {
  const { pdfs, script } = corpus(3);
  const w = world(script, { maxSessionsPerClientPerDay: 2 }), checker = await w.checker;
  const one = (i: number) => checker.step(step('candidate-1', 'a', [doc(`asset-${i}`, pdfs[i]!, [])]));
  expect(await one(0)).toMatchObject({ sessions: 1, remaining: [] });
  expect(await one(1)).toMatchObject({ sessions: 0, stopped: 'render-admission-refused', remaining: ['asset-1'] });
  clock += LEASE_MS;
  expect(await one(1)).toMatchObject({ sessions: 1, remaining: [] });
  clock += LEASE_MS;
  expect(await one(2)).toMatchObject({ sessions: 0, stopped: 'render-admission-refused', remaining: ['asset-2'] });
  clock += DAY_MS;
  expect(await one(2)).toMatchObject({ sessions: 1, remaining: [] });
  expect(() => w.db.sqlite.exec('UPDATE npr_pdf_sessions SET lease_ms = 62001')).toThrow(/immutable/);
  expect(() => w.db.sqlite.exec('DELETE FROM npr_pdf_sessions')).toThrow(/immutable/);
  expect(() => w.db.sqlite.exec('UPDATE npr_pdf_session_days SET runs = runs + 1')).toThrow(/monotonic|projection/);
 });
});

describe('U9 receipts are reused only for the same bytes and renderer', () => {
 it('reuses a receipt across candidates and within a step, and a later candidate citing fewer pages reuses the wider receipt', async () => {
  const pdf = syntheticPdf('shared exhibit');
  const w = world(new Map([[pdf.sha256, { totalPages: 12 }]])), checker = await w.checker;
  const first = await checker.step(step('candidate-1', 'a', [doc('asset-a', pdf, [5, 9]), doc('asset-b', pdf, [9, 5])]));
  expect(first.outcomes.map(o => [o.assetId, o.state, o.receipt, o.checkedPages])).toEqual([['asset-a', 'rendered', 'created', [1, 5, 9]], ['asset-b', 'rendered', 'reused', [1, 5, 9]]]);
  expect(w.boundary.inspected).toHaveLength(1);
  sdk.launch.mockClear();
  const later = await checker.step(step('candidate-2', 'b', [doc('asset-z', pdf, [9])]));
  expect(later.outcomes).toEqual([expect.objectContaining({ state: 'rendered', receipt: 'reused', pages: 12, checkedPages: [1, 9] })]);
  expect(sdk.launch).not.toHaveBeenCalled();
 });

 it('refuses a receipt from another renderer version and renders again under its own', async () => {
  const pdf = syntheticPdf('renderer change'), w = world(new Map([[pdf.sha256, { totalPages: 4 }]])), checker = await w.checker;
  const v1 = await (await createNativePreviewRenderChecker({ ...w.options, budget: { ...NATIVE_PDF_RENDER_CEILINGS } }))!.verify({
   clientId, caseId: w.options.clientId as never, candidateId: 'c', resultsVersion: 'sha256:' + 'a'.repeat(64) as never, assetId: 'x', bytes: new Uint8Array(1), sha256: 'a'.repeat(64), mediaType: 'image/png' });
  for (const other of [v1.rendererVersion, checker.rendererVersion.replace(/[0-9a-f]{64}$/, 'f'.repeat(64))]) {
   const pages = [{ number: 1, width: 10, height: 10, pixelBytes: 400, pixelSha256: 'd'.repeat(64) }];
   w.db.sqlite.prepare('INSERT INTO npr_content_receipts VALUES (?,?,?,?,?,?)')
    .run(pdf.sha256, pdf.size, other, '[1]', 4, receiptJson({ sha256: pdf.sha256, size: pdf.size, rendererVersion: other, totalPages: 4, pages }));
  }
  const r = await checker.step(step('candidate-1', 'a', [doc('asset-a', pdf, [])]));
  expect(r.outcomes).toEqual([expect.objectContaining({ state: 'rendered', receipt: 'created' })]);
  expect(sdk.launch).toHaveBeenCalledOnce();
  expect(w.db.sqlite.prepare('SELECT count(*) n FROM npr_content_receipts WHERE renderer_version = ?').get(checker.rendererVersion)).toEqual({ n: 1 });
 });

 it('keeps the v1 single-file renderer version, and the page program is a distinct renderer', async () => {
  const w = world(new Map()), checker = await w.checker;
  const v1 = await (await createNativePreviewRenderChecker({ ...w.options, budget: { ...NATIVE_PDF_RENDER_CEILINGS } }))!.verify({
   clientId, caseId: 'case-a1' as never, candidateId: 'c', resultsVersion: 'sha256:' + 'a'.repeat(64) as never, assetId: 'x', bytes: new Uint8Array(1), sha256: 'a'.repeat(64), mediaType: 'image/png' });
  expect(v1.rendererVersion).toBe('clearcase.native-pdf/2;sha256:58360780b85cec4881e95911e67a2837f158b3a7dd9ddf9c702bf40108385330');
  expect(checker.rendererVersion).toMatch(/^clearcase\.native-pdf-pages\/1;sha256:[0-9a-f]{64}$/);
 });

 const pdf = syntheticPdf('forged receipt target');
 const proof = (number: number) => ({ number, width: 10, height: 10, pixelBytes: 400, pixelSha256: 'e'.repeat(64) });
 const forgeries: [string, (rv: string) => [string, number, string]][] = [
  ['a page set claiming a page the receipt lacks (partial)', rv => ['[1,37]', 40, receiptJson({ sha256: pdf.sha256, size: pdf.size, rendererVersion: rv, totalPages: 40, pages: [proof(1)] })]],
  ['a receipt for other bytes', rv => ['[1,37]', 40, receiptJson({ sha256: 'f'.repeat(64), size: pdf.size, rendererVersion: rv, totalPages: 40, pages: [proof(1), proof(37)] })]],
  ['a receipt naming another renderer', rv => ['[1,37]', 40, receiptJson({ sha256: pdf.sha256, size: pdf.size, rendererVersion: rv + 'x', totalPages: 40, pages: [proof(1), proof(37)] })]],
  ['a page count that disagrees with its row', rv => ['[1,37]', 41, receiptJson({ sha256: pdf.sha256, size: pdf.size, rendererVersion: rv, totalPages: 40, pages: [proof(1), proof(37)] })]],
  ['a page set without page 1', rv => ['[37]', 40, receiptJson({ sha256: pdf.sha256, size: pdf.size, rendererVersion: rv, totalPages: 40, pages: [proof(37)] })]],
  ['a wrong pixel byte count', rv => ['[1,37]', 40, receiptJson({ sha256: pdf.sha256, size: pdf.size, rendererVersion: rv, totalPages: 40, pages: [proof(1), { ...proof(37), pixelBytes: 401 }] })]],
  ['an extra key', rv => ['[1,37]', 40, receiptJson({ sha256: pdf.sha256, size: pdf.size, rendererVersion: rv, totalPages: 40, pages: [proof(1), proof(37)] }).replace('{"format"', '{"trusted":true,"format"')]],
  ['non-canonical spacing', rv => ['[1, 37]', 40, receiptJson({ sha256: pdf.sha256, size: pdf.size, rendererVersion: rv, totalPages: 40, pages: [proof(1), proof(37)] })]],
 ];
 it.each(forgeries)('fails closed on %s: the document holds with no read and no browser', async (_, forge) => {
  const w = world(new Map([[pdf.sha256, { totalPages: 40 }]])), checker = await w.checker;
  w.db.sqlite.prepare('INSERT INTO npr_content_receipts VALUES (?,?,?,?,?,?)').run(pdf.sha256, pdf.size, checker.rendererVersion, ...forge(checker.rendererVersion));
  const reads = { n: 0 };
  const r = await checker.step(step('candidate-1', 'a', [doc('asset-a', pdf, [37], reads)]));
  expect(r.outcomes).toEqual([expect.objectContaining({ state: 'pending', reason: 'render-receipt-integrity', receipt: null })]);
  expect([reads.n, r.sessions, sdk.launch.mock.calls.length]).toEqual([0, 0, 0]);
 });
});

describe('U9 untrusted PDFs', () => {
 it('truncated bytes, a non-PDF and an over-budget file fail before any browser, with no receipt', async () => {
  const good = syntheticPdf('intact'), notPdf = new TextEncoder().encode('PK\x03\x04 synthetic archive');
  const { createHash } = await import('node:crypto');
  const w = world(new Map([[good.sha256, { totalPages: 2 }]]), { maxFileBytes: 1_000 }), checker = await w.checker;
  const truncated: PdfEvidenceDocument = { ...doc('asset-truncated', good, []), read: async () => good.bytes.slice(0, good.size - 5) };
  const archive: PdfEvidenceDocument = { assetId: 'asset-archive', sha256: createHash('sha256').update(notPdf).digest('hex'), size: notPdf.length, citedPages: [], read: async () => notPdf };
  const swapped: PdfEvidenceDocument = { ...doc('asset-swapped', good, []), read: async () => { const b = good.bytes.slice(); b[b.length - 2] ^= 1; return b; } };
  const huge: PdfEvidenceDocument = { ...doc('asset-huge', good, []), size: 1_001 };
  const r = await checker.step(step('candidate-1', 'a', [truncated, swapped, archive, huge]));
  expect(r.outcomes.map(o => [o.assetId, o.state, o.reason])).toEqual([['asset-truncated', 'failed', 'input-integrity-mismatch'],
   ['asset-swapped', 'failed', 'input-integrity-mismatch'], ['asset-archive', 'failed', 'unsupported-pdf'], ['asset-huge', 'failed', 'file-budget-exceeded']]);
  expect([r.sessions, sdk.launch.mock.calls.length, receipts(w.db).length]).toEqual([0, 0, 0]);
 });

 it('a corrupt PDF and an incomplete transcript fail without a receipt, and the session goes on to the next document', async () => {
  const corrupt = syntheticPdf('corrupt'), partial = syntheticPdf('partial'), fine = syntheticPdf('fine');
  const w = world(new Map([[corrupt.sha256, { totalPages: 5, behaviour: 'corrupt' }], [partial.sha256, { totalPages: 5, behaviour: 'omit-page' }], [fine.sha256, { totalPages: 5 }]]));
  const r = await (await w.checker).step(step('candidate-1', 'a', [doc('asset-c', corrupt, [4]), doc('asset-p', partial, [4]), doc('asset-f', fine, [4])]));
  expect(r.outcomes.map(o => [o.assetId, o.state, o.reason, o.receipt])).toEqual([
   ['asset-c', 'failed', 'render-failed', null], ['asset-p', 'failed', 'incomplete-render-transcript', null], ['asset-f', 'rendered', null, 'created']]);
  expect(r).toMatchObject({ sessions: 1, stopped: null, remaining: [] });
  expect(receipts(w.db)).toEqual([{ input_sha256: fine.sha256, page_set: '[1,4]' }]);
  expect(w.boundary.contexts).toEqual({ opened: 3, closed: 3 });
 });

 it('a document whose page requests an unowned path ends the session; later documents wait for a fresh session', async () => {
  const hostile = syntheticPdf('hostile'), next = syntheticPdf('next');
  const w = world(new Map([[hostile.sha256, { totalPages: 2, behaviour: 'violate' }], [next.sha256, { totalPages: 2 }]]));
  const r = await (await w.checker).step(step('candidate-1', 'a', [doc('asset-h', hostile, []), doc('asset-n', next, [])]));
  expect(r.outcomes).toEqual([expect.objectContaining({ assetId: 'asset-h', state: 'failed', reason: 'render-failed', receipt: null })]);
  expect(r).toMatchObject({ stopped: 'render-failed', remaining: ['asset-n'] });
  expect(receipts(w.db)).toEqual([]);
  expect(w.boundary.browser.close).toHaveBeenCalledOnce();
 });

 it('refuses invalid citations, another client, and copies the documents before its first await', async () => {
  const pdf = syntheticPdf('copied'), w = world(new Map([[pdf.sha256, { totalPages: 3 }]])), checker = await w.checker;
  const bad = await checker.step(step('candidate-1', 'a', [doc('asset-zero', pdf, [0]), doc('asset-frac', pdf, [1.5]), { ...doc('asset-many', pdf, []), citedPages: Array.from({ length: 300 }, (_, i) => i + 1) }]));
  expect(bad.outcomes.map(o => [o.assetId, o.reason])).toEqual([['asset-zero', 'invalid-render-input'], ['asset-frac', 'invalid-render-input'], ['asset-many', 'file-budget-exceeded']]);
  const other = await checker.step({ ...step('candidate-1', 'a', [doc('asset-a', pdf, [])]), clientId: 'client-b' as never });
  expect(other.outcomes).toEqual([expect.objectContaining({ state: 'failed', reason: 'invalid-render-input' })]);
  const documents = [doc('asset-a', pdf, [2])];
  const pending = checker.step(step('candidate-1', 'a', documents));
  (documents[0] as { citedPages: number[] }).citedPages.push(3);
  documents[0] = doc('asset-swapped', pdf, [3]);
  expect((await pending).outcomes).toEqual([expect.objectContaining({ assetId: 'asset-a', checkedPages: [1, 2] })]);
  expect(w.boundary.inspected).toEqual([{ sha256: pdf.sha256, pages: [1, 2] }]);
 });
});

describe('U9 per-step cost', () => {
 it('the ceilings fit one Workers Paid invocation, and an inconsistent or over-ceiling budget supplies no checker', async () => {
  const cost = pdfEvidenceStepCost(NATIVE_PDF_EVIDENCE_CEILINGS);
  expect(cost.subrequests).toBeLessThanOrEqual(1_000);
  expect(cost.memoryBytes).toBeLessThanOrEqual(100 * 1024 * 1024);
  expect(cost.wallMs).toBeLessThanOrEqual(62_000);
  for (const key of Object.keys(NATIVE_PDF_EVIDENCE_CEILINGS) as (keyof NativePdfEvidenceBudget)[]) {
   for (const bad of [undefined, 0, -1, 1.5, NaN, NATIVE_PDF_EVIDENCE_CEILINGS[key] + 1]) {
    expect(await createNativePdfEvidenceChecker(evidenceOptions(pdfDatabase(), pins, root, () => clock, { [key]: bad } as never, NATIVE_PDF_EVIDENCE_CEILINGS))).toBeNull();
   }
  }
  for (const inconsistent of [{ maxDocumentMs: 20_000, maxSessionMs: 10_000 }, { maxFileBytes: 2_000, maxSessionBytes: 1_000 }, { maxRendersPerSession: 10, maxDocumentsPerStep: 5 }]) {
   expect(await createNativePdfEvidenceChecker(evidenceOptions(pdfDatabase(), pins, root, () => clock, inconsistent, NATIVE_PDF_EVIDENCE_CEILINGS))).toBeNull();
  }
  expect(await createNativePdfEvidenceChecker({ ...evidenceOptions(pdfDatabase(), pins, root, () => clock), budget: null })).toBeNull();
 });
});
