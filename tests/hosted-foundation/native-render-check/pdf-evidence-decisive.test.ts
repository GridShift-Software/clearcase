// U9 decisive test (real-export design, U9 row). SDK BOUNDARY DOUBLES ONLY: the page double fabricates canvas proofs, so
// this proves the server's page selection, receipt reuse and out-of-range verdict, NOT that PDF.js rasterised anything.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareHostedPdfAssets } from '../../../scripts/hosted-pdf-assets.ts';
import { installWorkerdRedirectContract } from '../workerd-redirect-contract.ts';
import { createNativePdfEvidenceChecker, NATIVE_PDF_EVIDENCE_CEILINGS } from '../../../src/lib/viewer/hosted/native-render-check.ts';
import { doc, evidenceOptions, pdfBrowser, pdfDatabase, step, syntheticPdf, DAY_MS } from './pdf-evidence-world.ts';

const sdk = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: sdk.launch } }));
const root = mkdtempSync(join(tmpdir(), 'clearcase-pdf-evidence-decisive-'));
const pins = prepareHostedPdfAssets({ root: resolve('.'), publicRoot: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));
let restoreRequest: (() => void) | undefined;
beforeAll(() => { restoreRequest = installWorkerdRedirectContract(); });
afterAll(() => restoreRequest?.());
let clock = 20_000 * DAY_MS + 10_000;
beforeEach(() => { sdk.launch.mockReset(); clock = 20_000 * DAY_MS + 10_000; });

describe('U9 scaled PDF evidence: first and cited pages, content receipts', () => {
 it('a 40-page PDF cited at p37 records pages=40 and renders only p1 and p37; p41 fails out of range; a new candidate reuses the receipt with no browser', async () => {
  const db = pdfDatabase(), bundle = syntheticPdf('forty-page bundle'), boundary = pdfBrowser(new Map([[bundle.sha256, { totalPages: 40 }]]));
  sdk.launch.mockImplementation(async () => boundary.launch());
  const checker = (await createNativePdfEvidenceChecker(evidenceOptions(db, pins, root, () => clock, {}, NATIVE_PDF_EVIDENCE_CEILINGS)))!;
  expect(checker).not.toBeNull();

  const first = await checker.step(step('candidate-1', 'a', [doc('asset-bundle', bundle, [37])]));
  expect(first.outcomes).toEqual([expect.objectContaining({ assetId: 'asset-bundle', state: 'rendered', reason: null, pages: 40, checkedPages: [1, 37], receipt: 'created' })]);
  expect(first.remaining).toEqual([]);
  expect(boundary.inspected).toEqual([{ sha256: bundle.sha256, pages: [1, 37] }]);
  expect(sdk.launch).toHaveBeenCalledOnce();

  sdk.launch.mockClear();
  const beyond = await checker.step(step('candidate-1', 'a', [doc('asset-bundle-copy', bundle, [41])]));
  expect(beyond.outcomes).toEqual([expect.objectContaining({ assetId: 'asset-bundle-copy', state: 'failed', reason: 'page-reference-out-of-range', pages: 40 })]);
  expect(sdk.launch).not.toHaveBeenCalled();

  const reads = { n: 0 };
  const again = await checker.step(step('candidate-2', 'b', [doc('asset-bundle', bundle, [37], reads)]));
  expect(again.outcomes).toEqual([expect.objectContaining({ assetId: 'asset-bundle', state: 'rendered', pages: 40, checkedPages: [1, 37], receipt: 'reused' })]);
  expect(again.sessions).toBe(0);
  expect(sdk.launch).not.toHaveBeenCalled();
  expect(reads.n).toBe(0);
  expect(boundary.inspected).toHaveLength(1);
 });

 it('a p41 citation on bytes never rendered before fails out of range after one session that renders p1 only', async () => {
  const db = pdfDatabase(), bundle = syntheticPdf('fresh forty-page bundle'), boundary = pdfBrowser(new Map([[bundle.sha256, { totalPages: 40 }]]));
  sdk.launch.mockImplementation(async () => boundary.launch());
  const checker = (await createNativePdfEvidenceChecker(evidenceOptions(db, pins, root, () => clock, {}, NATIVE_PDF_EVIDENCE_CEILINGS)))!;
  const r = await checker.step(step('candidate-1', 'a', [doc('asset-bundle', bundle, [41])]));
  expect(r.outcomes).toEqual([expect.objectContaining({ state: 'failed', reason: 'page-reference-out-of-range', pages: 40 })]);
  expect(boundary.inspected).toEqual([{ sha256: bundle.sha256, pages: [1, 41] }]);
 });
});
