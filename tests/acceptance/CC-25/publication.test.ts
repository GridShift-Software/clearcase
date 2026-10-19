// CC-25 (GRS-24) acceptance item 4: unrecognized data is retained privately with coverage and repair information,
// an unsupported generation or an invalid required section never publishes, and the version already published stays
// active and served throughout. Synthetic cases through the real converter, click import, package import and
// activation; every value is invented.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { decodeUtf8Strict, parseStrictJson } from '../../../src/lib/case-package/strict-json.ts';
import { writePackageDir } from '../../../src/lib/case-package/writer.ts';
import type { ImportReport, LocalCase } from '../../../src/lib/local-case/service.server.ts';
import { ackFor, cleanup, service, tempRoot } from '../../../src/lib/local-case/test-support.ts';
import { putOriginal } from '../../e2e/pilot/lib/fixtures.ts';
import { synthOriginals, writeCaseFolder } from '../../case-package/fixtures/synth.ts';
import { editPackage, resealFiles } from '../../case-package/fixtures/build.ts';
import { build, jsonHtml, payloadHtml, type Built } from './generations.ts';

type J = Record<string, any>;
const CASE = 'cc25-case';
let root: string, caseDir: string, lc: LocalCase, published: Built;

beforeAll(async () => {
  root = await tempRoot('cc25-publication');
  caseDir = path.join(root, 'case');
  await writeCaseFolder(caseDir);
  lc = service(path.join(root, 'data'));
  await lc.startup();
  published = await build(path.join(root, 'published'), payloadHtml({}, false), caseDir, CASE);
  const imp = await lc.importPackage(caseDir, published.pkgDir);
  expect(await lc.activate(published.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
}, 120_000);
afterAll(async () => { lc?.shutdown(); if (root) await cleanup(root); });

const reportOf = (importId: number) => JSON.parse(lc.store.getImport(importId)!.report) as ImportReport;
const errors = (r: ImportReport) => [...new Set(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))].sort();

/** The published version is still the active one, verifies, and serves its register and originals. */
function stillPublished() {
  const vid = published.resultsVersion;
  expect(lc.currentActive()).toEqual({ caseId: CASE, vid });
  expect(lc.store.activeVersionId(CASE)).toBe(vid);
  expect(lc.verify(vid, true).ok).toBe(true);
  expect(lc.store.documentCount(vid)).toBe(7);
  for (const ref of ['OD-001', 'SD-001']) {
    expect(lc.store.document(vid, ref)).toBeTruthy();
    expect(lc.store.assetForServe(vid, ref)).toMatchObject({ status: 'verified' });
  }
}

describe('CC-25 item 4: an unsupported generation never publishes', () => {
  // a click import of a case folder (workspace HTML plus originals) named like the published case
  async function clickImport(tag: string, html: Uint8Array) {
    const source = path.join(root, tag, CASE);
    await writeCaseFolder(source, synthOriginals());
    await putOriginal(source, 'Workspace.html', html);
    const destination = path.join(root, tag, 'dest');
    await putOriginal(destination, '.keep', new Uint8Array());
    const before = lc.store.versionsOf(CASE).length;
    const r = await lc.importCasePack(source, destination);
    expect(r.kind).toBe('rejected');
    const report = reportOf((r as { importId: number }).importId);
    expect(report.verdict).toBe('reject');
    expect(report.resultsVersion).toBeNull();
    expect(report.app.map((a) => a.code)).toEqual(['APP_CONVERSION_REFUSED']);
    expect(lc.store.versionsOf(CASE)).toHaveLength(before);
    expect(await readdir(destination)).toEqual(['.keep']);
    // the received HTML, kept privately and byte for byte
    const kept = path.join(root, 'data', 'refused-inputs', `${sha256Hex(html)}.html`);
    expect(new Uint8Array(await readFile(kept))).toEqual(html);
    expect((await stat(kept)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(kept))).mode & 0o777).toBe(0o700);
    expect(report.app[0]!.message).toContain(kept);
    stillPublished();
    return errors(report);
  }

  it('a builder version nobody inventoried', async () => {
    expect(await clickImport('v2', payloadHtml({}, false, (r) => { r.META.version = 'V2'; }))).toEqual(['VER_UNSUPPORTED']);
  });
  it('a newer marker without META.version', async () => {
    expect(await clickImport('marker', payloadHtml({}, false, (r) => { r.META.fileCount = 7; }))).toEqual(['VER_UNSUPPORTED']);
  });
  it('neither payload lines nor app-data, and both at once', async () => {
    expect(await clickImport('none', new TextEncoder().encode('<!DOCTYPE html>\n<html><body><script>var DATA = {"chronology": []};</script></body></html>\n'))).toEqual(['V5_PAYLOAD_MISSING']);
    const both = decodeUtf8Strict(payloadHtml({}, false)).replace('</body></html>', decodeUtf8Strict(jsonHtml({ 'OD-001': 'DISCOVERY A/OD-001 Supply agreement.pdf' })).split('\n').filter((l) => l.startsWith('<script id=')).join('\n') + '\n</body></html>');
    expect(await clickImport('both', new TextEncoder().encode(both))).toContain('V5_PAYLOAD_AMBIGUOUS');
  });
});

describe('CC-25 item 4: an invalid required section never publishes', () => {
  const FUTURE = { envelope: 'clearcase.dataset/1', key: 'future-thing', kind: 'generated', schema: 'future.thing@1', count: 0, provenance: { source: 'v5-workspace-html', sourcePath: 'DATA.futureThing', adapter: 'clearcase-v5-adapter@0' }, data: [] };
  const withFuture = (required: boolean) => {
    const files = new Map(published.files);
    const env = { ...FUTURE, required };
    files.set('datasets/future-thing.json', canonicalBytes(env));
    // listed first, then sealed: resealFiles fills sizes and digests only for entries already in the manifest
    return resealFiles(resealFiles(files, (m) => { m.files.push({ path: 'datasets/future-thing.json', role: 'dataset', key: 'future-thing', kind: 'generated', schema: 'future.thing@1', required, count: 0, sha256: '', size: 0 }); m.files.sort((a: J, b: J) => (a.path < b.path ? -1 : 1)); }));
  };
  const chronology = 'datasets/chronology.json';
  const cases: [string, () => Map<string, Uint8Array>, string][] = [
    ['the register is missing', () => resealFiles(new Map([...published.files].filter(([p]) => p !== chronology)), (m) => { m.files = m.files.filter((f: J) => f.path !== chronology); }), 'DS_REQUIRED_MISSING'],
    ['the register is relabelled opaque', () => resealFiles(editPackage(published.files, chronology, (v) => { v.schema = 'opaque@1'; }, false), (m) => { m.files.find((f: J) => f.path === chronology).schema = 'opaque@1'; }), 'DS_SCHEMA_UNSUPPORTED'],
    ['a required dataset has a schema this reader does not know', () => withFuture(true), 'DS_SCHEMA_UNSUPPORTED'],
    ['two register rows share a ref', () => editPackage(published.files, chronology, (v) => { v.data[1].ref = v.data[0].ref; }), 'ID_DUPLICATE'],
    ['a register row has no valid ref', () => editPackage(published.files, chronology, (v) => { v.data[0].ref = 'not a ref'; }), 'ID_REF_INVALID'],
    ['another package format version', () => resealFiles(published.files, (m) => { m.formatVersion = 2; }), 'VER_UNSUPPORTED'],
  ];
  it.each(cases)('%s: rejected, nothing stored, the published version stays', async (tag, make, code) => {
    const pkg = path.join(root, 'invalid', tag.replace(/\W+/g, '-'));
    const files = make();
    await writePackageDir(pkg, files);
    const before = lc.store.versionsOf(CASE).length;
    const r = await lc.importPackage(caseDir, pkg);
    expect(r.kind).toBe('rejected');
    const report = reportOf(r.importId);
    expect(report.verdict).toBe('reject');
    expect(errors(report)).toContain(code);
    expect(lc.store.versionsOf(CASE)).toHaveLength(before);
    stillPublished();
  });

  it('an optional dataset with an unknown schema is kept, reported, and needs the operator before it publishes', async () => {
    const pkg = path.join(root, 'optional-future');
    const files = withFuture(false);
    await writePackageDir(pkg, files);
    const r = await lc.importPackage(caseDir, pkg);
    expect(r.kind).toBe('stored');
    const report = reportOf(r.importId);
    expect(report.verdict).toBe('report');
    expect(report.diagnostics.find((d) => d.code === 'DS_UNKNOWN_SCHEMA' && d.file === 'datasets/future-thing.json')).toMatchObject({ severity: 'warning' });
    const vid = report.resultsVersion!;
    expect(lc.store.packageFiles(vid).has('datasets/future-thing.json')).toBe(true);
    const refused = await lc.activate(vid, null);
    expect(refused?.reasons?.map((x) => x.code)).toContain('ACK_REQUIRED');
    stillPublished();
  });
});

describe('CC-25 item 4: unrecognized source data is retained privately with coverage and repair information', () => {
  it('a newer export\'s unknown key and hand-authored analysis are kept as residual datasets, listed by the import report, and never published unacknowledged', async () => {
    const overlay = ['/* ===== module mod_00_analysis.js ===== */', `(function(){ const X = ${JSON.stringify({ riskMatrix: [{ issue: 'Invented', category: 'Invented', owner: 'Invented', refs: ['OD-001'] }], timeline: [1, 2] })};`, '  Object.assign(DATA, X);', '})();'];
    const newer = await build(path.join(root, 'residual'), payloadHtml({}, true, (r) => { r.DATA.futureThing = [{ a: 1 }, { a: 2 }]; }, overlay), caseDir, CASE);
    expect(newer.generation).toBe('v5-js-newer');
    const r = await lc.importPackage(caseDir, newer.pkgDir);
    expect(r.kind).toBe('stored');
    const report = reportOf(r.importId);
    expect(report.verdict).toBe('report');
    // the validator's report names every residual dataset as preserved and not rendered, with the operator's next step
    const residual = report.diagnostics.filter((d) => d.code === 'DS_UNKNOWN_SCHEMA').map((d) => [d.file, d.severity, d.hint.length > 0]);
    expect(residual).toEqual(expect.arrayContaining([['datasets/v5-residual-analysis-overlay.json', 'warning', true], ['datasets/v5-residual-future-thing.json', 'warning', true]]));
    // the converter's own coverage (which keys, how many records) is retained in the stored version's conversion report
    const stored = lc.store.packageFiles(r.kind === 'stored' ? report.resultsVersion! : '');
    const conv = (parseStrictJson(decodeUtf8Strict(stored.get('datasets/conversion-report.json')!)) as { data: { diagnostics: { code: string; subject: string | null; message: string }[] } }).data.diagnostics;
    expect(conv.find((d) => d.code === 'V5_UNMAPPED_KEY' && d.subject === 'DATA.futureThing')).toBeTruthy();
    expect(conv.find((d) => d.code === 'V5_OVERLAY_UNMAPPED')?.message).toMatch(/riskMatrix.*1.*timeline.*2|timeline.*2.*riskMatrix.*1/);
    for (const key of ['v5-residual-analysis-overlay', 'v5-residual-future-thing']) expect(stored.has(`datasets/${key}.json`)).toBe(true);
    // kept under the data directory, which is the operator's own (not a served path, not the case folder)
    expect(await readdir(caseDir)).not.toContain('.clearcase');
    expect((await lc.activate(report.resultsVersion!, null))?.reasons?.map((x) => x.code)).toContain('ACK_REQUIRED');
    stillPublished();
    // acknowledged, it publishes; returning to the earlier version brings that version back whole
    expect(await lc.activate(report.resultsVersion!, ackFor(lc, r.importId))).toBeNull();
    expect(lc.currentActive()?.vid).toBe(report.resultsVersion);
    expect(await lc.rollback(CASE, report.resultsVersion!, published.resultsVersion)).toBeNull();
    stillPublished();
  });
});
