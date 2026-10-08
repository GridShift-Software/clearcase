// Regressions for defects found in independent review: each case failed before its fix.
import { mkdir, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acceptedWarnings, acknowledge, canActivate, convertV5, importCandidate, readCandidate, type ImportResult } from '../../src/lib/case-package/index.ts';
import { classifyLink } from '../../src/lib/case-package/links.ts';
import { markdownLinkTargets } from '../../src/lib/case-package/validate.ts';
import { buildSynth, editPackage, resealFiles, type Built } from './fixtures/build.ts';
import { cleanup } from './fixtures/synth.ts';

const roots: string[] = [];
const built = async (tag: string, edit?: Parameters<typeof buildSynth>[1]): Promise<Built> => { const b = await buildSynth(tag, edit); roots.push(b.root); return b; };
afterAll(async () => { for (const r of roots) await cleanup(r); });
const codes = (r: ImportResult) => new Set(r.diagnostics.map((d) => d.code));
const OD1 = 'DISCOVERY A/OD-001 Supply agreement.pdf';

describe('review regressions', () => {
  it('rejects values with their own toString instead of throwing', async () => {
    const b = await built('tostring');
    for (const [file, edit] of [
      ['datasets/chronology.json', (v: any) => { v.data[0].text_status = { toString: 1, valueOf: 1 }; }],
      ['datasets/filings.json', (v: any) => { v.data.registerSeed[0].ref = { toString: 1 }; }],
    ] as const) {
      const r = await importCandidate({ files: editPackage(b.files, file, edit) }, b.caseDir);
      expect(r.verdict).toBe('reject');
      expect(r.candidate).toBeNull();
    }
  });

  it('turns an escaping or non-file original into a conversion error, not a missing warning', async () => {
    const b = await built('conv-escape');
    const outside = path.join(b.root, 'outside.pdf');
    await rename(path.join(b.caseDir, OD1), outside);
    await symlink(outside, path.join(b.caseDir, OD1));
    await rm(path.join(b.caseDir, 'DISCOVERY A', 'OD-002 Invoice 1001.pdf'));
    await mkdir(path.join(b.caseDir, 'DISCOVERY A', 'OD-002 Invoice 1001.pdf'));
    const c = await convertV5({ html: b.html, htmlName: 'w.html', caseFolder: b.caseDir, caseId: 'synthetic-case' });
    expect(c.ok).toBe(false);
    expect(c.files).toBeNull();
    expect(c.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['ORIG_ESCAPE', 'ORIG_NOT_FILE']));
  });

  it('gives residual datasets distinct keys when source keys collide after kebab-casing', async () => {
    const b = await built('residual', (r) => { r.DATA.fooBar = [1]; r.DATA.foo_bar = [2]; r.DATA['é'] = [3]; r.DATA['ü'] = [4]; });
    const keys = [...b.files.keys()].filter((p) => p.includes('v5-residual'));
    expect(new Set(keys).size).toBe(4);
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.verdict).toBe('report');
    expect(r.counts.DS_UNKNOWN_SCHEMA).toBe(4);
  });

  it('fingerprints a defect per record, so a new record with the same defect is new', async () => {
    const one = await built('fp1', (r) => { (r.DATA.defenceMatrix as any[])[0].rebuttal = 'See [[ZZ-999]].'; });
    const three = await built('fp3', (r) => {
      const dm = r.DATA.defenceMatrix as any[];
      dm[0].rebuttal = 'See [[ZZ-999]].';
      dm.push({ ...dm[0], point: 'Second point' }, { ...dm[0], point: 'Third point' });
    });
    const r1 = await importCandidate(one.pkgDir, one.caseDir);
    const trusted = acceptedWarnings(r1, acknowledge(r1, r1.warningFingerprints), []);
    const r3 = await importCandidate(three.pkgDir, three.caseDir);
    const d = canActivate(r3, null, trusted);
    expect(d.ok).toBe(false);
    expect(d.newWarnings).toHaveLength(2);
  });

  it('keeps the listed diagnostics and the digest independent of hashing concurrency', async () => {
    const b = await built('cap');
    await rm(path.join(b.caseDir, OD1));
    await rm(path.join(b.caseDir, 'DISCOVERY A', 'OD-002 Invoice 1001.pdf'));
    const r1 = await importCandidate(b.pkgDir, b.caseDir, { concurrency: 1, limits: { diagnosticsPerCode: 1 } });
    const r4 = await importCandidate(b.pkgDir, b.caseDir, { concurrency: 4, limits: { diagnosticsPerCode: 1 } });
    expect(r4.diagnosticsSha256).toBe(r1.diagnosticsSha256);
  });

  it('scans manifest extensions for user-work store keys', async () => {
    const b = await built('ext');
    const r = await importCandidate({ files: resealFiles(b.files, (m) => { m.extensions = { 'x-carry': { syn_case_deadlines_v1: [] } }; }) }, b.caseDir);
    expect(r.verdict).toBe('reject');
    expect(codes(r)).toContain('DS_USERWORK_EMBEDDED');
  });

  it('classifies Markdown destinations in angle brackets, with entities and in reference definitions, in linear time', async () => {
    expect(new Set(markdownLinkTargets('[x](<javascript:a>) [y](java&#58;b) [z]: vbscript:c <data:text/html,x>'))).toEqual(new Set(['javascript:a', 'java:b', 'vbscript:c', 'data:text/html,x']));
    const t = performance.now();
    markdownLinkTargets(']('.repeat(1) + '](x'.repeat(300_000));
    markdownLinkTargets('<a'.repeat(300_000));
    expect(performance.now() - t).toBeLessThan(1000);
    const b = await built('md', (r) => { (r.DATA.matter as any).storyline[0].t = '[x](javascript&#58;alert(1))'; });
    expect(codes(await importCandidate(b.pkgDir, b.caseDir))).toContain('LINK_UNSAFE_SCHEME');
  });

  it('records the real path behind a folder link inside the case folder', async () => {
    const b = await built('reallink');
    await rename(path.join(b.caseDir, 'DISCOVERY A'), path.join(b.caseDir, 'real-A'));
    await symlink('real-A', path.join(b.caseDir, 'DISCOVERY A'));
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(r.candidate!.original('OD-001')!.path).toBe('real-A/OD-001 Supply agreement.pdf');
  });

  it('freezes the import result', async () => {
    const b = await built('frozen');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(() => { (r.warningFingerprints as string[]).length = 0; }).toThrow();
    expect(() => { (r as any).verdict = 'accept'; }).toThrow();
    expect(() => { (r.diagnostics[0] as any).severity = 'info'; }).toThrow();
  });

  it('compares META counts for untrusted names exactly', async () => {
    const dotted = await built('meta-dot', (r) => {
      for (const row of r.DATA.chronology as any[]) if (row.bundle === 'Supplementary') row.bundle = 'Supp.B';
      (r.META as any).bundles = { Original: 4, Correspondence: 2, 'Supp.B': 1 };
    });
    const r = await importCandidate(dotted.pkgDir, dotted.caseDir);
    expect(r.diagnostics.filter((d) => d.code === 'V5_META_COUNT_DISAGREEMENT').map((d) => d.subject).sort()).toEqual(['META.emails', 'META.textNone']);
    const proto = await built('meta-proto', (r) => {
      for (const row of r.DATA.chronology as any[]) if (row.bundle === 'Supplementary') row.bundle = 'constructor';
      (r.META as any).bundles = { Original: 4, Correspondence: 2 };
    });
    const rp = await importCandidate(proto.pkgDir, proto.caseDir);
    expect(rp.diagnostics.some((d) => d.code === 'V5_META_COUNT_DISAGREEMENT' && d.subject === 'META.bundles["constructor"]')).toBe(true);
    const counts = readCandidate(rp.candidate!).derivedCounts();
    expect(counts.byBundle.constructor).toBe(1);
    expect(Object.values(counts.byBundle).reduce((a, n) => a + n, 0)).toBe(7);
  });

  it('bounds the zip central directory by its entry count before reading it', async () => {
    const b = await built('zipcd');
    const zip = path.join(b.root, 'big.zip');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(200 * 1024 * 1024, 12); eocd.writeUInt32LE(0, 16);
    const fh = await import('node:fs/promises').then((f) => f.open(zip, 'w'));
    await fh.truncate(200 * 1024 * 1024);
    await fh.write(eocd, 0, 22, 200 * 1024 * 1024);
    await fh.close();
    const r = await importCandidate(zip, b.caseDir);
    expect(codes(r)).toContain('ARC_LIMIT');
  });

  it('keeps only the address of a mailto link', () => {
    expect(classifyLink('mailto:a@example.invalid?bcc=b@example.invalid&body=x')).toMatchObject({ kind: 'external', href: 'mailto:a@example.invalid' });
  });

  it('returns no typed data for a dataset whose schema the reader does not know', async () => {
    const b = await built('typed');
    const r = await importCandidate(b.pkgDir, b.caseDir);
    expect(readCandidate(r.candidate!).dataset('people')).not.toBeNull();
  });
});
