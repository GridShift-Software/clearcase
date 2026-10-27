// U9 fix round 1 regressions: response encoding memory (H1), charged reads and one step deadline (M1), and a browser that
// stays inside its reserved lease (M2). SDK BOUNDARY DOUBLES ONLY over the real viewer migrations; not renderer acceptance.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareHostedPdfAssets } from '../../../scripts/hosted-pdf-assets.ts';
import { installWorkerdRedirectContract } from '../workerd-redirect-contract.ts';
import { createNativePdfEvidenceChecker, NATIVE_PDF_EVIDENCE_CEILINGS, pdfEvidenceStepCost } from '../../../src/lib/viewer/hosted/native-render-check.ts';
import type { NativePdfEvidenceBudget } from '../../../src/lib/viewer/hosted/render-check-contract.ts';
import { receiptJson } from '../../../src/lib/viewer/hosted/pdf-content-receipts.ts';
import { doc, evidenceOptions, pdfBrowser, pdfDatabase, step, syntheticPdf, DAY_MS, type PdfScript } from './pdf-evidence-world.ts';

const sdk = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: sdk.launch } }));
const root = mkdtempSync(join(tmpdir(), 'clearcase-pdf-evidence-bounds-'));
const pins = prepareHostedPdfAssets({ root: resolve('.'), publicRoot: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));
let restoreRequest: (() => void) | undefined;
beforeAll(() => { restoreRequest = installWorkerdRedirectContract(); });
afterAll(() => restoreRequest?.());
let clock = 20_000 * DAY_MS + 10_000;
beforeEach(() => { sdk.launch.mockReset(); clock = 20_000 * DAY_MS + 10_000; });
const MiB = 1024 * 1024;
// Workers Paid gives an isolate 128 MB; the step must leave room for the runtime and the bundled code.
const STEP_MEMORY_LIMIT = 96 * MiB;
const largestPin = Math.max(...pins.files.map(f => f.bytes));

function world(script: Map<string, PdfScript>, budget: Partial<NativePdfEvidenceBudget> = {}, db = pdfDatabase()) {
 const boundary = pdfBrowser(script);
 sdk.launch.mockImplementation(async () => boundary.launch());
 const options = evidenceOptions(db, pins, root, () => clock, budget, NATIVE_PDF_EVIDENCE_CEILINGS);
 return { db, boundary, options, checker: createNativePdfEvidenceChecker(options).then(c => c!) };
}

describe('H1: the SDK response encoder never sees a whole large PDF', () => {
 it('serves a 3 MiB PDF in parts of at most 1 MiB, one response at a time, and the page reassembles the exact bytes', async () => {
  const big = syntheticPdf('three mebibytes', 3 * MiB);
  const w = world(new Map([[big.sha256, { totalPages: 40, behaviour: 'burst' }]]));
  const r = await (await w.checker).step(step('candidate-1', 'a', [doc('asset-big', big, [37])]));
  expect(r.outcomes).toEqual([expect.objectContaining({ state: 'rendered', pages: 40, checkedPages: [1, 37] })]);
  expect(w.boundary.responses.largest).toBeLessThanOrEqual(Math.max(MiB, largestPin));
  expect(w.boundary.responses.mostActive).toBe(1);
 });

 it('counts the encoder, three copies of the file and the receipt rows, and the ceilings fit the step memory limit', () => {
  const cost = pdfEvidenceStepCost(NATIVE_PDF_EVIDENCE_CEILINGS);
  // The pinned SDK builds one array slot per body byte, then a joined string, base64 and the CDP message.
  expect(cost.memoryBytes).toBeGreaterThanOrEqual(3 * NATIVE_PDF_EVIDENCE_CEILINGS.maxFileBytes + 8 * Math.max(MiB, largestPin));
  expect(cost.memoryBytes).toBeLessThanOrEqual(STEP_MEMORY_LIMIT);
 });

 it('a PDF above the file ceiling holds with file-budget-exceeded and is never read', async () => {
  const pdf = syntheticPdf('declared too large'), reads = { n: 0 };
  const w = world(new Map([[pdf.sha256, { totalPages: 1 }]]));
  const r = await (await w.checker).step(step('candidate-1', 'a', [{ ...doc('asset-huge', pdf, [], reads), size: NATIVE_PDF_EVIDENCE_CEILINGS.maxFileBytes + 1 }]));
  expect(r.outcomes).toEqual([expect.objectContaining({ state: 'failed', reason: 'file-budget-exceeded' })]);
  expect([reads.n, r.sessions]).toEqual([0, 0]);
 });
});

describe('M1: every read is charged and one deadline bounds the whole step', () => {
 it('failed reads count against the step, so its subrequests stay within the computed cost', async () => {
  const pdf = syntheticPdf('one render'), w = world(new Map([[pdf.sha256, { totalPages: 1 }]]), { maxRendersPerSession: 1 });
  let reads = 0;
  const documents = Array.from({ length: 90 }, (_, i) => ({ ...doc('asset-' + i, pdf, []), read: async () => {
   reads++; if (i < 89) throw Error('synthetic R2 read failed'); return pdf.bytes.slice();
  } }));
  const r = await (await w.checker).step(step('candidate-1', 'a', documents));
  const subrequests = reads + w.db.state.calls + vi.mocked(w.options.assets!.fetch).mock.calls.length + sdk.launch.mock.calls.length * 2;
  expect(subrequests).toBeLessThanOrEqual(pdfEvidenceStepCost({ ...NATIVE_PDF_EVIDENCE_CEILINGS, maxRendersPerSession: 1 }).subrequests);
  expect(reads).toBe(1);
  expect(r.outcomes).toEqual([expect.objectContaining({ assetId: 'asset-0', state: 'pending', reason: 'render-unavailable' })]);
  expect(r.remaining).toHaveLength(89);
 });

 it('a read that never settles in time leaves its document for the next step within the computed wall time', async () => {
  const pdf = syntheticPdf('slow read'), budget = { maxSessionMs: 2_000, maxDocumentMs: 500 };
  const w = world(new Map([[pdf.sha256, { totalPages: 1 }]]), budget);
  const started = performance.now();
  const r = await (await w.checker).step(step('candidate-1', 'a', [{ ...doc('asset-slow', pdf, []), read: () => new Promise<Uint8Array>(done => setTimeout(() => done(pdf.bytes.slice()), 5_000)) }]));
  expect(performance.now() - started).toBeLessThanOrEqual(pdfEvidenceStepCost({ ...NATIVE_PDF_EVIDENCE_CEILINGS, ...budget }).wallMs);
  expect(r).toMatchObject({ outcomes: [], remaining: ['asset-slow'], stopped: 'render-timeout', sessions: 0 });
  expect(sdk.launch).not.toHaveBeenCalled();
 });

 it('a receipt lookup that never settles in time leaves every document for the next step', async () => {
  const pdf = syntheticPdf('slow lookup'), budget = { maxSessionMs: 2_000, maxDocumentMs: 500 };
  const db = pdfDatabase(), prepare = db.primary.prepare.bind(db.primary);
  db.primary.prepare = sql => {
   const s = prepare(sql);
   if (sql.includes('FROM npr_content_receipts')) s.all = () => new Promise(() => {});
   return s;
  };
  const w = world(new Map([[pdf.sha256, { totalPages: 1 }]]), budget, db);
  const started = performance.now();
  const r = await (await w.checker).step(step('candidate-1', 'a', [doc('asset-a', pdf, [])]));
  expect(performance.now() - started).toBeLessThanOrEqual(pdfEvidenceStepCost({ ...NATIVE_PDF_EVIDENCE_CEILINGS, ...budget }).wallMs);
  expect(r).toMatchObject({ outcomes: [], remaining: ['asset-a'], stopped: 'render-timeout' });
 });
});

describe('M2: the browser lives inside the lease its admission reserved', () => {
 const lease = NATIVE_PDF_EVIDENCE_CEILINGS.maxSessionMs + 62_000;
 function delayedAdmission(db: ReturnType<typeof pdfDatabase>, by: number) {
  const batch = db.primary.batch.bind(db.primary);
  let delayed = false;
  db.primary.batch = async statements => {
   const result = await batch(statements);
   if (!delayed) { delayed = true; clock += by; }
   return result;
  };
 }

 it('an admission acknowledged after its lease ran out launches nothing, so a second step cannot overlap it', async () => {
  const pdf = syntheticPdf('lease'), db = pdfDatabase();
  delayedAdmission(db, lease);
  const w = world(new Map([[pdf.sha256, { totalPages: 1 }]]), {}, db), checker = await w.checker;
  const first = await checker.step(step('candidate-1', 'a', [doc('asset-1', pdf, [])]));
  expect(first).toMatchObject({ stopped: 'render-admission-unavailable', remaining: ['asset-1'] });
  expect(sdk.launch).not.toHaveBeenCalled();
  const second = await checker.step(step('candidate-2', 'b', [doc('asset-2', pdf, [])]));
  expect(second).toMatchObject({ sessions: 1, remaining: [] });
  expect(sdk.launch).toHaveBeenCalledOnce();
 });

 it('an admission acknowledged too late for one document launches nothing', async () => {
  const pdf = syntheticPdf('late ack'), db = pdfDatabase();
  delayedAdmission(db, NATIVE_PDF_EVIDENCE_CEILINGS.maxSessionMs - 1_000);
  const w = world(new Map([[pdf.sha256, { totalPages: 1 }]]), {}, db);
  const r = await (await w.checker).step(step('candidate-1', 'a', [doc('asset-1', pdf, [])]));
  expect(r).toMatchObject({ stopped: 'render-admission-unavailable', remaining: ['asset-1'] });
  expect(sdk.launch).not.toHaveBeenCalled();
 });

 it('documents stop when the reserved session time runs out by the trusted clock, even if the step still has time', async () => {
  const pdfs = [syntheticPdf('first'), syntheticPdf('second')], db = pdfDatabase();
  const w = world(new Map(pdfs.map(p => [p.sha256, { totalPages: 1 }])), {}, db);
  const seal = db.primary.batch.bind(db.primary);
  db.primary.batch = async statements => {
   const result = await seal(statements);
   if ((statements[0] as { sql?: string }).sql?.includes('npr_content_receipts')) clock += NATIVE_PDF_EVIDENCE_CEILINGS.maxSessionMs;
   return result;
  };
  const r = await (await w.checker).step(step('candidate-1', 'a', pdfs.map((p, i) => doc(`asset-${i}`, p, []))));
  expect(r.outcomes.map(o => [o.assetId, o.state])).toEqual([['asset-0', 'rendered']]);
  expect(r.remaining).toEqual(['asset-1']);
 });
});

describe('stored receipt rows are bounded by bytes, not by the current citation budget', () => {
 /** The receipt payload text the step's lookups fetched, in bytes. */
 function payloadMeter(db: ReturnType<typeof pdfDatabase>) {
  const fetched = { bytes: 0 }, prepare = db.primary.prepare.bind(db.primary);
  db.primary.prepare = sql => {
   const s = prepare(sql), all = s.all.bind(s);
   if (sql.includes('FROM npr_content_receipts')) s.all = async <T>() => {
    const r = await all<T>();
    for (const row of r.results as Record<string, unknown>[]) for (const k of ['receipt_json', 'page_set']) if (typeof row[k] === 'string') fetched.bytes += new TextEncoder().encode(row[k] as string).byteLength;
    return r;
   };
   return s;
  };
  return fetched;
 }
 const wideBudget = { maxDocumentsPerStep: 1, maxRendersPerSession: 1 };
 const narrowBudget = { ...wideBudget, maxCheckedPagesPerFile: 1 };

 it('a genuine 256-page receipt reused after the budget narrows to one page fits the receipt allowance the step reserves', async () => {
  const pdf = syntheticPdf('wide receipt'), db = pdfDatabase();
  const wide = world(new Map([[pdf.sha256, { totalPages: 100_000 }]]), wideBudget, db);
  const pages = [1, ...Array.from({ length: 255 }, (_, i) => 99_746 + i)];
  expect((await (await wide.checker).step(step('wide', 'a', [doc('wide', pdf, pages)]))).outcomes[0]).toMatchObject({ state: 'rendered', receipt: 'created' });
  const narrow = world(new Map([[pdf.sha256, { totalPages: 100_000 }]]), narrowBudget, db);
  const fetched = payloadMeter(db);
  const reused = await (await narrow.checker).step(step('narrow', 'b', [doc('narrow', pdf, [])]));
  expect(reused.outcomes[0]).toMatchObject({ state: 'rendered', receipt: 'reused' });
  expect(fetched.bytes).toBeGreaterThan(30_000);
  // Each fetched row is held three times: the D1 reply, the parsed row and the validation parse.
  expect(3 * fetched.bytes).toBeLessThanOrEqual(pdfEvidenceStepCost({ ...NATIVE_PDF_EVIDENCE_CEILINGS, ...narrowBudget }).receiptBytes);
 });

 it('a stored row over the renderer\'s fixed receipt bound is never fetched whole and holds its document', async () => {
  const pdf = syntheticPdf('oversized receipt'), db = pdfDatabase();
  const w = world(new Map([[pdf.sha256, { totalPages: 100_000 }]]), narrowBudget, db), checker = await w.checker;
  const pages = Array.from({ length: 400 }, (_, i) => ({ number: i + 1, width: 10, height: 10, pixelBytes: 400, pixelSha256: 'a'.repeat(64) }));
  db.sqlite.prepare('INSERT INTO npr_content_receipts VALUES (?,?,?,?,?,?)').run(pdf.sha256, pdf.size, checker.rendererVersion,
   JSON.stringify(pages.map(p => p.number)), 100_000, receiptJson({ sha256: pdf.sha256, size: pdf.size, rendererVersion: checker.rendererVersion, totalPages: 100_000, pages }));
  const fetched = payloadMeter(db), reads = { n: 0 };
  const r = await checker.step(step('candidate-1', 'a', [doc('asset-a', pdf, [], reads)]));
  expect(r.outcomes).toEqual([expect.objectContaining({ state: 'pending', reason: 'render-receipt-integrity', receipt: null })]);
  expect([fetched.bytes, reads.n, sdk.launch.mock.calls.length]).toEqual([0, 0, 0]);
 });
});
