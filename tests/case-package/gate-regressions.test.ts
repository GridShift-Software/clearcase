// Regressions for the defects the CC-23 / GRS-11 independent gate found at c3c773c: G1 (folded
// lookup listed a directory outside the case folder), G2 (over-limit Markdown destinations cut
// into valid URLs) and the follow-ups N1-N4. The containment and long-destination cases are
// adapted from the gate's tests/acceptance/CC-23/containment.test.ts and contract.test.ts.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/lib/case-package/canonical.ts';
import { DiagSink, diagnosticsDigest } from '../../src/lib/case-package/diagnostics.ts';
import { importCandidate, type ImportResult } from '../../src/lib/case-package/index.ts';
import { classifyLink, MAX_LINK } from '../../src/lib/case-package/links.ts';
import { servePolicy } from '../../src/lib/case-package/media.ts';
import { markdownLinkTargets } from '../../src/lib/case-package/validate.ts';
import { storedZip } from './fixtures/zip.ts';
import { miniPackage } from './hostile/cases.ts';

const original = new TextEncoder().encode('%PDF-1.4\n% invented gate original\n%%EOF\n');
const codes = (r: ImportResult) => r.diagnostics.map((d) => d.code);
let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc02-gate-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

/** A fresh case folder and a sibling outside folder under the shared temp root. */
async function folders(tag: string): Promise<{ caseDir: string; outside: string }> {
  const caseDir = path.join(root, tag, 'case');
  const outside = path.join(root, tag, 'outside');
  await mkdir(caseDir, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { caseDir, outside };
}
const importOne = (caseDir: string, p: string, bytes = original) => importCandidate({ files: miniPackage({ docs: [{ ref: 'GT-001', path: p, bytes }] }) }, caseDir);

describe('G1: the folded lookup never lists or opens a directory outside the case folder', () => {
  it.each([true, false])('rejects linked -> outside as ORIG_ESCAPE with no outside directory read (matching name present: %s)', async (present) => {
    const { caseDir, outside } = await folders(`g1-watch-${present}`);
    await symlink(outside, path.join(caseDir, 'linked'));
    if (present) await writeFile(path.join(outside, 'Secret.PDF'), original);
    const watcher = fileURLToPath(new URL('./containment/watch-directory.py', import.meta.url));
    const probe = fileURLToPath(new URL('./containment/probe.ts', import.meta.url));
    const run = spawnSync('python3', ['-I', watcher, outside, probe, caseDir], { encoding: 'utf8', timeout: 20_000 });
    expect(run.status, run.stderr).toBe(0);
    const observed = JSON.parse(run.stdout) as { result: { verdict: string; counts: Record<string, number>; candidate: boolean }; outsideDirectoryReads: string[] };
    expect(observed.outsideDirectoryReads).toEqual([]);
    expect(observed.result).toMatchObject({ verdict: 'reject', counts: { ORIG_ESCAPE: 1 }, candidate: false });
  });

  it('gives the same verdict and diagnostics whether or not the outside name exists, at any depth', async () => {
    const seen: string[] = [];
    for (const present of [true, false]) {
      const { caseDir, outside } = await folders(`g1-deep-${present}`);
      await mkdir(path.join(caseDir, 'a'));
      await symlink(outside, path.join(caseDir, 'a', 'Linked'));
      if (present) { await mkdir(path.join(outside, 'Sub')); await writeFile(path.join(outside, 'Sub', 'Secret.PDF'), original); }
      const r = await importOne(caseDir, 'a/linked/sub/secret.pdf');
      expect(r.verdict).toBe('reject');
      expect(r.candidate).toBeNull();
      seen.push(JSON.stringify([r.counts, r.diagnosticsSha256]));
    }
    expect(seen[0]).toBe(seen[1]);
  });

  it('still finds a case- or NFC-only match through in-folder directories and links', async () => {
    const { caseDir } = await folders('g1-fold');
    const name = 'Café Notes.PDF'; // NFD on disk
    await mkdir(path.join(caseDir, 'Real Dir'));
    await writeFile(path.join(caseDir, 'Real Dir', name), original);
    await symlink('Real Dir', path.join(caseDir, 'alias'));
    for (const indexed of ['real dir/café notes.pdf', 'alias/CAFÉ NOTES.pdf']) {
      const r = await importOne(caseDir, indexed);
      expect(r.verdict, indexed).toBe('report');
      expect(codes(r)).toContain('ORIG_CASE_MISMATCH');
      expect(r.candidate!.original('GT-001')).toMatchObject({ path: `Real Dir/${name}`, status: 'case-mismatch' });
    }
  });
});

describe('G2: an over-limit Markdown destination is rejected, never cut into a shorter one', () => {
  const long = `https://example.invalid/${'a'.repeat(100_000)}`;
  it.each([
    ['inline', `[Invented link](${long})`],
    ['reference definition', `[Invented link]: ${long}`],
    ['angle inline', `[Invented link](<${long}>)`],
    ['autolink', `<${long}>`],
    ['entities that decode shorter', `[x](https://example.invalid/${'&amp;'.repeat(1000)})`],
    ['autolink entities that decode shorter', `<https://example.invalid/${'&amp;'.repeat(1000)}>`],
  ])('rejects a long %s destination with no candidate', async (_form, text) => {
    const { caseDir } = await folders(`g2-${_form.replace(/ /g, '-')}`);
    await writeFile(path.join(caseDir, 'source.pdf'), original);
    const r = await importCandidate({ files: miniPackage({ docs: [{ ref: 'GT-001', path: 'source.pdf', bytes: original }], prose: [text] }) }, caseDir);
    expect(r.verdict).toBe('reject');
    expect(r.candidate).toBeNull();
    expect(codes(r)).toContain('LINK_RELATIVE_UNSAFE');
    expect(codes(r)).not.toContain('LINK_EXTERNAL');
  });

  it('keeps the limit exact and the scan bounded', () => {
    const at = (n: number) => `https://example.invalid/${'a'.repeat(n - 'https://example.invalid/'.length)}`;
    expect(markdownLinkTargets(`[x](${at(MAX_LINK)})`).map(classifyLink)).toMatchObject([{ kind: 'external' }]);
    expect(markdownLinkTargets(`[x](${at(MAX_LINK + 1)})`).map(classifyLink)).toMatchObject([{ kind: 'rejected' }]);
    for (const t of markdownLinkTargets(`[x](${at(1_000_000)}) [y]: ${at(1_000_000)}`)) expect(t.length).toBe(MAX_LINK + 1);
    const t0 = performance.now();
    markdownLinkTargets('[x](<'.repeat(200_000));
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe('gate follow-ups N1-N4', () => {
  it('N1: cuts diagnostic text on a code-point boundary and returns a digestible result', async () => {
    const sink = new DiagSink();
    sink.add('PKG_UNLISTED_FILE', 'x', { subject: `${'a'.repeat(199)}\u{1F600}` });
    const [d] = sink.finish();
    expect(d!.subject).toBe('a'.repeat(199));
    expect(() => diagnosticsDigest('v', sink.finish(), {}, [])).not.toThrow();
    const files = miniPackage({ docs: [{ ref: `${'A'.repeat(39)}\u{1F600}`, path: 'source.pdf', bytes: original }] });
    const r = await importCandidate({ files }, root);
    expect(r.verdict).toBe('reject');
    expect(codes(r)).toContain('ID_REF_INVALID');
    expect(() => canonicalJson(r.diagnostics)).not.toThrow();
  });

  it('N2: builds download headers for a legal name whose 200th unit splits a surrogate pair', () => {
    const name = `${'a'.repeat(199)}\u{1F600}.pdf`;
    const h = servePolicy('application/pdf', name).headers['Content-Disposition']!;
    expect(h).toContain(`filename*=UTF-8''${'a'.repeat(199)}`);
    expect(h.isWellFormed()).toBe(true);
  });

  it('N3: refuses an in-folder alias that resolves into .clearcase/', async () => {
    const { caseDir } = await folders('n3');
    await mkdir(path.join(caseDir, '.clearcase'));
    await writeFile(path.join(caseDir, '.clearcase', 'state.pdf'), original);
    await symlink('.clearcase', path.join(caseDir, 'alias'));
    await symlink('.clearcase/state.pdf', path.join(caseDir, 'state.pdf'));
    for (const indexed of ['alias/state.pdf', 'state.pdf', 'ALIAS/state.pdf']) {
      const r = await importOne(caseDir, indexed);
      expect(r.verdict, indexed).toBe('reject');
      expect(codes(r)).toContain('ASSET_PATH_RESERVED');
      expect(r.candidate).toBeNull();
    }
  });

  it('N4: keeps zip member names byte-exact (a BOM-prefixed assets.json is not assets.json)', async () => {
    const { caseDir } = await folders('n4');
    await writeFile(path.join(caseDir, 'source.pdf'), original);
    const files = miniPackage({ docs: [{ ref: 'GT-001', path: 'source.pdf', bytes: original }] });
    const ok = path.join(root, 'n4', 'ok.zip');
    await writeFile(ok, storedZip(files));
    expect((await importCandidate(ok, caseDir)).verdict).toBe('accept');
    const bom = path.join(root, 'n4', 'bom.zip');
    await writeFile(bom, storedZip(new Map([...files].map(([k, v]) => [k === 'assets.json' ? '﻿assets.json' : k, v]))));
    const r = await importCandidate(bom, caseDir);
    expect(r.verdict).toBe('reject');
    expect(r.candidate).toBeNull();
  });
});
