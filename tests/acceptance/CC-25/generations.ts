// CC-25 (GRS-24): one synthetic case folder converted by each of the three workspace generations (v5-js,
// v5-js-newer, json-script) through the real converter, so a test controls which original each ref names in each
// generation. Every value is invented; nothing here comes from a case.
import path from 'node:path';
import { DiagSink } from '../../../src/lib/case-package/diagnostics.ts';
import { convertV5 } from '../../../src/lib/case-package/v5/adapter.ts';
import { extractV5, type Generation } from '../../../src/lib/case-package/v5/extract.ts';
import { writePackageDir } from '../../../src/lib/case-package/writer.ts';
import { row, url } from '../../e2e/pilot/lib/fixtures.ts';
import { synthHtml, synthOriginals, synthRoots, type SynthRoots } from '../../case-package/fixtures/synth.ts';

type J = Record<string, any>;
export const AGREEMENT = 'DISCOVERY A/OD-001 Supply agreement.pdf';
export const INVOICE = 'DISCOVERY A/OD-002 Invoice 1001.pdf';
export const STATEMENT = 'DISCOVERY B/SD-001 Statement.pdf';
export const SCAN = 'DISCOVERY A/OD-003 Scan.pdf';
/** the agreement's bytes again, at another path: two refs with one fingerprint */
export const AGREEMENT_COPY = 'DISCOVERY C/Agreement copy.pdf';
export const MISSING = 'DISCOVERY A/OD-009 Not in the folder.pdf';
const BYTES: Record<string, Uint8Array> = { ...synthOriginals(), [AGREEMENT_COPY]: synthOriginals()[AGREEMENT]!, [MISSING]: new TextEncoder().encode('%PDF-1.4\n% never written\n%%EOF\n') };
export const bytesOf = (p: string) => BYTES[p]!;

export interface Built { generation: Generation; html: Uint8Array; pkgDir: string; resultsVersion: string; files: Map<string, Uint8Array>; diagnostics: { code: string; severity: string }[] }

const enc = (s: string) => new TextEncoder().encode(s);
const tag = (id: string, v: J) => `<script id="${id}" type="application/json">${JSON.stringify(v).replace(/</g, '\\u003c')}</script>`;

/** A JSON-script workspace (app-data and app-seed) whose register is exactly `refs` (ref -> original path). */
export function jsonHtml(refs: Record<string, string>, appData: J = {}, appSeed: J = {}): Uint8Array {
  const chronology = Object.entries(refs).map(([ref, p], i) => ({ n: i + 1, ref, date: '2001-02-03', ds: 'text', fn: p.split('/').pop(), sj: `Invented ${ref}`, sd: '', to: '', cc: '', ex: 'Invented', st: 'Invented', dt: 'other', amt: null, ai: [], ts: 'extracted', url: url(p), sz: bytesOf(p).byteLength, bd: 'Original' }));
  return enc(['<!DOCTYPE html>', '<html><body>', tag('app-data', { chronology, meta: { builtAt: '2002-06-07 08:09' }, ...appData }), tag('app-seed', appSeed), '<script>var DATA = JSON.parse(document.getElementById("app-data").textContent);</script>', '</body></html>', ''].join('\n'));
}

/**
 * The synthetic v5 roots with the register edited: each `refs` entry points an existing row at another original, adds
 * a row, or (null) drops the row. `newer` stamps the newer builder's META.version.
 */
export function payloadHtml(refs: Record<string, string | null>, newer: boolean, edit?: (r: SynthRoots) => void, extraLines: string[] = []): Uint8Array {
  const r = synthRoots();
  if (newer) r.META.version = 'V1';
  let rows = r.DATA.chronology as J[];
  for (const [ref, p] of Object.entries(refs)) {
    if (p === null) { rows = rows.filter((x) => x.ref !== ref); continue; }
    const hit = rows.find((x) => x.ref === ref);
    if (hit) Object.assign(hit, { url: url(p), filename: p.split('/').pop(), size: bytesOf(p).byteLength });
    else rows.push(row(ref, 40 + rows.length, p, bytesOf(p).byteLength));
  }
  r.DATA.chronology = rows;
  edit?.(r);
  return synthHtml(r, extraLines);
}

/** Convert `html` against `caseDir` and write the package to `<root>/pkg`; throws when the converter refuses it. */
export async function build(root: string, html: Uint8Array, caseDir: string, caseId: string): Promise<Built> {
  const generation = extractV5(html, new DiagSink())?.generation;
  if (!generation) throw new Error('the converter does not recognise this synthetic workspace');
  const res = await convertV5({ html, htmlName: 'workspace.html', caseFolder: caseDir, caseId });
  if (!res.files || !res.manifest) throw new Error('synthetic conversion refused: ' + res.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code).join(','));
  const pkgDir = path.join(root, 'pkg');
  await writePackageDir(pkgDir, res.files);
  return { generation, html, pkgDir, resultsVersion: res.manifest.resultsVersion, files: res.files, diagnostics: res.diagnostics };
}
