// The synthetic fixture of one journey run: one invented PDF and the precomputed processed package for exactly that PDF.
// The package comes from GRS-10's own converter (convertV5 over a synthetic v5-shaped workspace), so it passes the real
// package contract. No model, recipe or case document is involved: this is precomputed synthetic output, the manual
// hand-off that the native alpha rehearses. Every value is invented and carries the run id, so two runs never collide.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { convertV5 } from '../../src/lib/case-package/v5/adapter.ts';
import { synthHtml, synthRoots, writeCaseFolder } from '../case-package/fixtures/synth.ts';
import { storedZip } from '../case-package/fixtures/zip.ts';
import { sha256Hex } from './common.ts';

export interface JourneyFixture {
  runId: string;
  pdf: { path: string; filename: string; bytes: Uint8Array; sha256: string; size: number };
  /** invented text that appears in the original's bytes, the chronology row and nowhere in a refusal */
  subject: string;
  ref: string;
  packageZip: Uint8Array;
  packageManifestSha256: string;
  inputRevisionId: string;
  resultsVersion: string;
  /** invented strings that must never reach a refused request */
  markers: string[];
}

const RUN = /^[0-9a-f]{12}$/;
const enc = (s: string) => new TextEncoder().encode(s);

/** A minimal one-page PDF with the marker as its only text; it starts with %PDF- and ends with %%EOF. */
export function syntheticPdf(label: string): Uint8Array {
  return enc([
    '%PDF-1.4', '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj', '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length 60 >> stream\nBT /F1 18 Tf 20 100 Td (${label.replace(/[()\\]/g, '')}) Tj ET\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj', 'trailer << /Root 1 0 R >>', '%%EOF', '',
  ].join('\n'));
}

export async function buildFixture(runId: string): Promise<JourneyFixture> {
  if (!RUN.test(runId)) throw new Error('the run id is 12 lower-case hex characters');
  const subject = `Synthetic journey letter ${runId}`;
  const filename = `JN-001 letter ${runId}.pdf`;
  const rel = `JOURNEY/${filename}`;
  const bytes = syntheticPdf(subject);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-journey-'));
  try {
    await writeCaseFolder(dir, { [rel]: bytes });
    const roots = synthRoots();
    const url = './' + rel.split('/').map(encodeURIComponent).join('/');
    roots.DATA = { chronology: [{ n: '1', ref: 'JN-001', date: '2001-02-03', filename, subject, sender: 'Ann Lee', to: 'Org A Ltd', cc: '', excerpt: 'Invented excerpt.', doc_type: 'other', bundle: 'Original', amount: '', also_in: [], text_status: 'extracted', url, refs: [], invoice_no: '', size: bytes.byteLength, seq: '1', attachments: [] }] };
    roots.META = { builtAt: '2001-05-06 07:08', docCount: 1, dataFolderName: `Synthetic journey case ${runId}`, bundles: { Original: 1 }, emails: 0, invoices: 0, people: 0, textNone: 0, textPending: 0, dateSpan: ['2001-02-03', '2001-02-03'], docTypes: { other: 1 } };
    roots.SCHED = { discovery: [], supplementary: [] };
    roots.CASELINES = { file: '', pages: 0, index: [] };
    const res = await convertV5({ html: synthHtml(roots, [], {}), htmlName: 'workspace.html', caseFolder: dir, caseId: `journey-${runId}` });
    if (!res.files || !res.manifest) throw new Error('the synthetic conversion failed: ' + res.diagnostics.map((d) => d.code).join(','));
    const manifestBytes = res.files.get('manifest.json');
    if (!manifestBytes) throw new Error('the converted package has no manifest.json');
    return {
      runId, pdf: { path: rel, filename, bytes, sha256: sha256Hex(bytes), size: bytes.byteLength }, subject, ref: 'JN-001',
      packageZip: storedZip(res.files), packageManifestSha256: sha256Hex(manifestBytes), inputRevisionId: res.manifest.inputRevision.id, resultsVersion: res.manifest.resultsVersion,
      markers: [subject, `journey-${runId}`, filename],
    };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
