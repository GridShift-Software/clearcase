// CC-25 (GRS-24) acceptance item 5: a ref reused across export generations or versions never silently attaches user
// work to a different original. One synthetic case folder; the v5, newer and JSON-script generations each give the
// same refs to other originals; notes are written through the real store and read back across activation, rollback
// and restart. Every value is invented.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { putOriginal } from '../../e2e/pilot/lib/fixtures.ts';
import { writeCaseFolder } from '../../case-package/fixtures/synth.ts';
import type { LocalCase } from '../../../src/lib/local-case/service.server.ts';
import { ackFor, cleanup, service, tempRoot } from '../../../src/lib/local-case/test-support.ts';
import { AGREEMENT, AGREEMENT_COPY, INVOICE, MISSING, SCAN, STATEMENT, build, bytesOf, jsonHtml, payloadHtml } from './generations.ts';

const CASE = 'cc25-case';
const roots: string[] = [];
const open: LocalCase[] = [];
afterEach(async () => {
  for (const lc of open.splice(0)) lc.shutdown();
  for (const r of roots.splice(0)) await cleanup(r);
});

async function setup() {
  const root = await tempRoot('cc25-anchors');
  roots.push(root);
  const caseDir = path.join(root, 'case');
  await writeCaseFolder(caseDir);
  await putOriginal(caseDir, AGREEMENT_COPY, bytesOf(AGREEMENT_COPY));
  const lc = service(path.join(root, 'data'));
  open.push(lc);
  await lc.startup();
  return { root, caseDir, lc };
}
const bodies = (lc: LocalCase, vid: string, ref: string) => lc.userWork.notesFor(CASE, vid, ref).map((n) => [n.body, n.status, n.candidates]);
const assetSha = (files: Map<string, Uint8Array>, ref: string) => (JSON.parse(new TextDecoder().decode(files.get('assets.json')!)) as { assets: Record<string, { sha256?: string }> }).assets[ref]?.sha256;
const sha = (lc: LocalCase, vid: string, ref: string) => lc.store.assetForServe(vid, ref)?.sha256;

describe('CC-25 item 5: reused refs across generations', () => {
  it('notes follow their original by fingerprint through v5, newer and JSON-script versions, never by ref', async () => {
    const { root, caseDir, lc } = await setup();
    // v5: the synthetic register, plus OD-009 whose original is not in the folder
    const v5 = await build(path.join(root, 'v5'), payloadHtml({ 'OD-009': MISSING }, false), caseDir, CASE);
    // newer: OD-001 and OD-002 swap originals, SD-001 is renumbered SD-002, and OD-009 now names the scan (OD-003 before)
    const newer = await build(path.join(root, 'newer'), payloadHtml({ 'OD-001': INVOICE, 'OD-002': AGREEMENT, 'SD-001': null, 'SD-002': STATEMENT, 'OD-003': null, 'OD-009': SCAN }, true), caseDir, CASE);
    // JSON script: OD-001 names the statement, the agreement is filed twice with identical bytes, the invoice is gone
    const json = await build(path.join(root, 'json'), jsonHtml({ 'OD-001': STATEMENT, 'DC-SYN-001': AGREEMENT, 'DC-SYN-002': AGREEMENT_COPY }), caseDir, CASE);
    expect([v5.generation, newer.generation, json.generation]).toEqual(['v5-js', 'v5-js-newer', 'json-script']);
    // the controlled data: one ref, three originals
    expect(new Set([assetSha(v5.files, 'OD-001'), assetSha(newer.files, 'OD-001'), assetSha(json.files, 'OD-001')]).size).toBe(3);

    const i1 = await lc.importPackage(caseDir, v5.pkgDir);
    expect(i1.kind).toBe('stored');
    expect(await lc.activate(v5.resultsVersion, ackFor(lc, i1.importId))).toBeNull();
    for (const [ref, body] of [['OD-001', 'A on the agreement'], ['OD-002', 'B on the invoice'], ['SD-001', 'C on the statement'], ['OD-009', 'E on a missing original']]) {
      expect((await lc.userWork.addNote(CASE, v5.resultsVersion, ref, body)).status).toBe('here');
    }
    expect(lc.userWork.notesFor(CASE, v5.resultsVersion, 'OD-009')[0]!.anchorSha256).toBeNull();

    // the newer version, previewed before activation and after it
    const i2 = await lc.importPackage(caseDir, newer.pkgDir);
    expect(i2.kind).toBe('stored');
    const atNewer = () => {
      expect(bodies(lc, newer.resultsVersion, 'OD-001')).toEqual([['B on the invoice', 'exact', []]]);
      expect(bodies(lc, newer.resultsVersion, 'OD-002')).toEqual([['A on the agreement', 'exact', []]]);
      expect(bodies(lc, newer.resultsVersion, 'SD-002')).toEqual([['C on the statement', 'exact', []]]);
      expect(bodies(lc, newer.resultsVersion, 'OD-009')).toEqual([]);
      expect(lc.userWork.summary(CASE, newer.resultsVersion)).toMatchObject({ total: 4, exact: 3, unanchored: 1, missing: 0 });
    };
    atNewer();
    expect(await lc.activate(newer.resultsVersion, ackFor(lc, i2.importId))).toBeNull();
    expect(lc.currentActive()).toEqual({ caseId: CASE, vid: newer.resultsVersion });
    atNewer();
    const d = await lc.userWork.addNote(CASE, newer.resultsVersion, 'OD-001', 'D on the invoice, written in the newer version');
    expect(d.anchorSha256).toBe(sha(lc, v5.resultsVersion, 'OD-002'));

    // the JSON-script version: OD-001 is the statement here; the agreement's two refs share one fingerprint
    const i3 = await lc.importPackage(caseDir, json.pkgDir);
    expect(i3.kind).toBe('stored');
    expect(await lc.activate(json.resultsVersion, ackFor(lc, i3.importId))).toBeNull();
    expect(bodies(lc, json.resultsVersion, 'OD-001')).toEqual([['C on the statement', 'exact', []]]);
    const ambiguous = [['A on the agreement', 'ambiguous', ['DC-SYN-001', 'DC-SYN-002']]];
    expect(bodies(lc, json.resultsVersion, 'DC-SYN-001')).toEqual(ambiguous);
    expect(bodies(lc, json.resultsVersion, 'DC-SYN-002')).toEqual(ambiguous);
    const s3 = lc.userWork.summary(CASE, json.resultsVersion);
    expect(s3).toMatchObject({ total: 5, exact: 1, ambiguous: 1, missing: 2, unanchored: 1 });
    expect(s3.detached.map((n) => [n.body, n.status]).sort()).toEqual([['B on the invoice', 'missing'], ['D on the invoice, written in the newer version', 'missing'], ['E on a missing original', 'unanchored']]);

    // back to the newer version (rollback), then to v5, then a restart: every note where its original is
    expect(await lc.rollback(CASE, json.resultsVersion, newer.resultsVersion)).toBeNull();
    expect(bodies(lc, newer.resultsVersion, 'OD-001')).toEqual([['B on the invoice', 'exact', []], ['D on the invoice, written in the newer version', 'here', []]]);
    expect(await lc.activate(v5.resultsVersion, ackFor(lc, i1.importId))).toBeNull();
    const atV5 = (x: LocalCase) => {
      expect(bodies(x, v5.resultsVersion, 'OD-001')).toEqual([['A on the agreement', 'here', []]]);
      expect(bodies(x, v5.resultsVersion, 'OD-002')).toEqual([['B on the invoice', 'here', []], ['D on the invoice, written in the newer version', 'exact', []]]);
      expect(bodies(x, v5.resultsVersion, 'SD-001')).toEqual([['C on the statement', 'here', []]]);
      expect(bodies(x, v5.resultsVersion, 'OD-009')).toEqual([['E on a missing original', 'here', []]]);
    };
    atV5(lc);
    lc.shutdown();
    open.splice(open.indexOf(lc), 1);
    const again = service(path.join(root, 'data'));
    open.push(again);
    await again.startup();
    expect(again.currentActive()?.vid).toBe(v5.resultsVersion);
    atV5(again);
    expect(again.userWork.summary(CASE, v5.resultsVersion)).toMatchObject({ total: 5, here: 4, exact: 1 });
  });

  it('a ref is a package-local alias: the same ref and bytes at another path keep the note, other bytes never take it', async () => {
    const { root, caseDir, lc } = await setup();
    const v5 = await build(path.join(root, 'v5'), payloadHtml({}, false), caseDir, CASE);
    // the agreement moved to another path with the same bytes, under the same ref, in a JSON-script export
    const moved = await build(path.join(root, 'moved'), jsonHtml({ 'OD-001': AGREEMENT_COPY, 'OD-002': INVOICE }), caseDir, CASE);
    const i1 = await lc.importPackage(caseDir, v5.pkgDir);
    expect(await lc.activate(v5.resultsVersion, ackFor(lc, i1.importId))).toBeNull();
    await lc.userWork.addNote(CASE, v5.resultsVersion, 'OD-001', 'on the agreement');
    expect((await lc.importPackage(caseDir, moved.pkgDir)).kind).toBe('stored');
    expect(bodies(lc, moved.resultsVersion, 'OD-001')).toEqual([['on the agreement', 'exact', []]]);
    // the bytes of the agreement changed on disk: a new conversion gives OD-001 a new fingerprint, and the note stays detached
    await putOriginal(caseDir, AGREEMENT_COPY, new TextEncoder().encode('%PDF-1.4\n% another agreement\n%%EOF\n'));
    const changed = await build(path.join(root, 'changed'), jsonHtml({ 'OD-001': AGREEMENT_COPY, 'OD-002': INVOICE }), caseDir, CASE);
    expect(changed.resultsVersion).not.toBe(moved.resultsVersion);
    expect((await lc.importPackage(caseDir, changed.pkgDir)).kind).toBe('stored');
    expect(bodies(lc, changed.resultsVersion, 'OD-001')).toEqual([]);
    expect(lc.userWork.summary(CASE, changed.resultsVersion)).toMatchObject({ total: 1, missing: 1 });
    expect(await readFile(path.join(caseDir, ...AGREEMENT.split('/')))).toEqual(Buffer.from(bytesOf(AGREEMENT)));
  });
});
