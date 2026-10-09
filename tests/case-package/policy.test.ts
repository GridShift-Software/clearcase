// canActivate: a pure policy over a fresh ImportResult, an acknowledgement and a trusted baseline.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acceptedWarnings, acknowledge, canActivate, importCandidate, type ImportResult } from '../../src/lib/case-package/index.ts';
import { buildSynth, editPackage, type Built } from './fixtures/build.ts';
import { cleanup } from './fixtures/synth.ts';

const roots: string[] = [];
const built = async (tag: string, edit?: Parameters<typeof buildSynth>[1]): Promise<Built> => { const b = await buildSynth(tag, edit); roots.push(b.root); return b; };
afterAll(async () => { for (const r of roots) await cleanup(r); });
const reasonCodes = (d: ReturnType<typeof canActivate>) => d.reasons.map((r) => r.code);

describe('first import', () => {
  it('treats every warning as new, including the unresolved catalogue citation and META disagreements', async () => {
    const b = await built('first');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.diagnostics.filter((d) => d.severity === 'warning').every((d) => d.baseline === 'new')).toBe(true);
    const d = canActivate(r, null, []);
    expect(d.ok).toBe(false);
    expect(reasonCodes(d)).toEqual(['ACK_REQUIRED']);
    expect(d.newWarnings).toEqual(r.warningFingerprints);
    const cite = r.diagnostics.find((x) => x.code === 'CITE_UNRESOLVED')!;
    const partial = acknowledge(r, r.warningFingerprints.filter((f) => f !== cite.fingerprint));
    expect(reasonCodes(canActivate(r, partial, []))).toEqual(['ACK_INCOMPLETE']);
    expect(canActivate(r, acknowledge(r, d.newWarnings), []).ok).toBe(true);
  });

  it('does not trust anything from package content', async () => {
    const b = await built('selftrust');
    const files = new Map(b.files);
    files.set('baseline.json', new TextEncoder().encode(JSON.stringify({ entries: [] })));
    const r = await importCandidate({ files }, b.caseDir);
    expect(canActivate(r, null).ok).toBe(false);
  });
});

describe('carry-forward of acknowledged warnings', () => {
  it('needs no new acknowledgement for the same defects after reconversion and reordered records', async () => {
    const b1 = await built('cf1');
    const r1 = await importCandidate(b1.pkgDir, b1.caseDir);
    const ack1 = acknowledge(r1, r1.warningFingerprints);
    expect(canActivate(r1, ack1).ok).toBe(true);
    const trusted = acceptedWarnings(r1, ack1, []);
    const b2 = await built('cf2', (r) => { (r.DATA.chronology as unknown[]).reverse(); (r.DATA.people as unknown[]).reverse(); });
    const r2 = await importCandidate(b2.pkgDir, b2.caseDir, { trustedBaseline: trusted });
    expect(r2.candidate!.resultsVersion).not.toBe(r1.candidate!.resultsVersion);
    expect(r2.warningFingerprints).toEqual(r1.warningFingerprints);
    expect(r2.diagnostics.filter((d) => d.severity === 'warning').every((d) => d.baseline === 'known')).toBe(true);
    expect(canActivate(r2, null, trusted)).toMatchObject({ ok: true, newWarnings: [] });
  });

  it('requires a fresh acknowledgement for a new defect and refuses a stale one', async () => {
    const b1 = await built('stale1');
    const r1 = await importCandidate(b1.pkgDir, b1.caseDir);
    const ack1 = acknowledge(r1, r1.warningFingerprints);
    const trusted = acceptedWarnings(r1, ack1, []);
    const b2 = await built('stale2', (r) => { (r.DATA.timeline as any).events[0].ref = 'OD-404'; });
    const r2 = await importCandidate(b2.pkgDir, b2.caseDir, { trustedBaseline: trusted });
    const d = canActivate(r2, ack1, trusted);
    expect(d.ok).toBe(false);
    expect(reasonCodes(d)).toEqual(['ACK_STALE', 'ACK_INCOMPLETE']);
    expect(d.newWarnings).toHaveLength(1);
    expect(r2.diagnostics.find((x) => x.fingerprint === d.newWarnings[0])?.subject).toBe('OD-404');
    expect(canActivate(r2, acknowledge(r2, d.newWarnings), trusted).ok).toBe(true);
  });

  it('treats changed diagnostics or a different validator version as stale', async () => {
    const b = await built('digest');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    const ack = acknowledge(r, r.warningFingerprints);
    expect(reasonCodes(canActivate({ ...r, diagnosticsSha256: 'sha256:' + '1'.repeat(64) } as ImportResult, ack))).toContain('ACK_STALE');
    expect(reasonCodes(canActivate(r, { ...ack, validatorVersion: 'other@1' }))).toContain('ACK_STALE');
    expect(reasonCodes(canActivate(r, { ...ack, manifestSha256: '0'.repeat(64) }))).toContain('ACK_STALE');
  });
});

describe('errors are never waivable', () => {
  it('refuses a changed original even when its fingerprint is acknowledged or trusted', async () => {
    const b = await built('changed');
    const r1 = await importCandidate(b.pkgDir, b.caseDir);
    await writeFile(path.join(b.caseDir, 'DISCOVERY A', 'OD-002 Invoice 1001.pdf'), '%PDF-1.4\n% synthetic invoice 1009\n%%EOF\n');
    const r2 = await importCandidate(b.pkgDir, b.caseDir);
    expect(r2.verdict).toBe('reject');
    const forged = { ...acknowledge(r1, r1.warningFingerprints), warningFingerprints: [...r2.errorFingerprints, ...r1.warningFingerprints] };
    const d = canActivate(r2, forged, r2.errorFingerprints);
    expect(d.ok).toBe(false);
    expect(reasonCodes(d)).toEqual(expect.arrayContaining(['REJECTED', 'ERRORS_PRESENT', 'ERROR_NOT_WAIVABLE']));
  });

  it('cannot acknowledge a rejected import', async () => {
    const b = await built('rej');
    const r = await importCandidate({ files: editPackage(b.files, 'assets.json', (v) => { v.assets['OD-001'].path = '../x.pdf'; }) }, b.caseDir);
    expect(() => acknowledge(r, [])).toThrow();
    expect(canActivate(r, null).ok).toBe(false);
  });
});

describe('capped diagnostics', () => {
  it('requires acknowledgement of warnings that appear only in capped totals', async () => {
    const b = await built('capped', (r) => {
      const rows = r.DATA.timeline as any;
      for (let i = 0; i < 5; i++) rows.events.push({ ...rows.events[0], ref: `OD-90${i}` });
    });
    const r = await importCandidate(b.pkgDir, b.caseDir, { limits: { diagnosticsPerCode: 2 } });
    expect(r.counts.CITE_UNRESOLVED).toBe(6);
    expect(r.diagnostics.filter((d) => d.code === 'CITE_UNRESOLVED')).toHaveLength(2);
    expect(r.diagnostics.find((d) => d.code === 'DIAG_TRUNCATED' && d.subject === 'CITE_UNRESOLVED')).toBeDefined();
    const listedOnly = r.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.fingerprint);
    const d = canActivate(r, acknowledge(r, listedOnly), []);
    expect(reasonCodes(d)).toEqual(['ACK_INCOMPLETE']);
    expect(canActivate(r, acknowledge(r, r.warningFingerprints), []).ok).toBe(true);
  });
});
