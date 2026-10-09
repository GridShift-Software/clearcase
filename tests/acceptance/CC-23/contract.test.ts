import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importCandidate } from '../../../src/lib/case-package/import.ts';
import { acknowledge, canActivate } from '../../../src/lib/case-package/policy.ts';
import { renderNarrative } from '../../../src/lib/case-package/render.ts';
import { verifyCandidateBytes } from '../../../src/lib/case-package/verify-bytes.ts';
import { editManifestOnly, editPackage } from '../../case-package/fixtures/build.ts';
import { miniPackage } from '../../case-package/hostile/cases.ts';

const original = new TextEncoder().encode('%PDF-1.4\n% invented gate original\n%%EOF\n');
const validFiles = () => miniPackage({ docs: [{ ref: 'GT-001', path: 'source.pdf', bytes: original }] });
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc23-'));
  await writeFile(path.join(root, 'source.pdf'), original);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('CC-23 independent package acceptance', () => {
  it('imports a complete synthetic candidate and binds its original bytes', async () => {
    const result = await importCandidate({ files: validFiles() }, root);
    expect(result.verdict).toBe('accept');
    expect(result.candidate?.caseId).toBe('synthetic-hostile');
    expect(result.candidate?.original('GT-001')?.path).toBe('source.pdf');
    expect(canActivate(result, null).ok).toBe(true);
    if (!result.candidate) throw new Error('a valid package has no candidate');
    const stored = new Map([...result.candidate.snapshot()].map(({ path, bytes }): [string, Uint8Array] => [path, bytes]));
    expect(verifyCandidateBytes(stored, result.candidate.identity())).toEqual({ ok: true, problems: [] });
  });

  it.each([2, '1', null])('rejects version %j before malformed shapes', async (formatVersion) => {
    const files = editManifestOnly(validFiles(), (m) => { m.formatVersion = formatVersion; m.case = 7; m.files = []; });
    const result = await importCandidate({ files }, root);
    expect(result.verdict).toBe('reject');
    expect(result.candidate).toBeNull();
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VER_UNSUPPORTED']);
  });

  it('refuses to waive a real structural error through either an acknowledgement or a baseline', async () => {
    const good = await importCandidate({ files: validFiles() }, root);
    const badFiles = editPackage(validFiles(), 'datasets/chronology.json', (v) => { v.count = 8; });
    const bad = await importCandidate({ files: badFiles }, root);
    expect(bad.verdict).toBe('reject');
    expect(bad.counts.DS_COUNT_MISMATCH).toBe(1);
    const ack = acknowledge(good, bad.errorFingerprints);
    const decision = canActivate(bad, ack, bad.errorFingerprints);
    expect(decision.ok).toBe(false);
    expect(decision.reasons.map((r) => r.code)).toEqual(['REJECTED', 'ERRORS_PRESENT', 'ERROR_NOT_WAIVABLE']);
  });

  it('never lets a registered dataset evade shape validation by relabelling its schema', async () => {
    const files = editPackage(validFiles(), 'datasets/chronology.json', (v) => { v.schema = 'opaque@1'; v.required = false; v.data[0].date = {}; });
    const result = await importCandidate({ files }, root);
    expect(result.verdict).toBe('reject');
    expect(result.counts.DS_SCHEMA_UNSUPPORTED).toBe(1);
    expect(result.candidate).toBeNull();
  });

  it('rejects duplicate register refs', async () => {
    const files = editPackage(validFiles(), 'datasets/chronology.json', (v) => { v.data.push({ ...v.data[0] }); v.count = 2; });
    const result = await importCandidate({ files }, root);
    expect(result.verdict).toBe('reject');
    expect(result.counts.ID_DUPLICATE).toBe(1);
  });

  it('rejects nested browser user work in preserved imported data', async () => {
    const files = editPackage(validFiles(), 'datasets/chronology.json', (v) => { v.data[0].extra = { nested: { gate_case_notes_v1: [{ note: 'Invented user note' }] } }; });
    const result = await importCandidate({ files }, root);
    expect(result.verdict).toBe('reject');
    expect(result.counts.DS_USERWORK_EMBEDDED).toBe(1);
  });

  it.each(['../outside.pdf', '/etc/hostname', 'C|/outside.pdf', '.clearcase/work.sqlite'])('rejects original locator %s', async (locator) => {
    const files = editPackage(validFiles(), 'assets.json', (v) => { v.assets['GT-001'].path = locator; });
    const result = await importCandidate({ files }, root);
    expect(result.verdict).toBe('reject');
    expect(result.candidate).toBeNull();
    expect(result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)).toContain(locator.startsWith('.clearcase') ? 'ASSET_PATH_RESERVED' : 'ASSET_PATH_TRAVERSAL');
  });

  it('refuses an outside symlink even when the attacker supplies matching bytes', async () => {
    const outside = path.join(root, 'outside.pdf');
    const caseFolder = await mkdtemp(path.join(root, 'inner-'));
    await writeFile(outside, original);
    await symlink(outside, path.join(caseFolder, 'source.pdf'));
    const result = await importCandidate({ files: validFiles() }, caseFolder);
    expect(result.verdict).toBe('reject');
    expect(result.counts.ORIG_ESCAPE).toBe(1);
    expect(result.candidate).toBeNull();
  });

  it.each(['[x](javascript:alert(1))', '[x](java&#x73;cript:alert(1))', '[x]: data:text/html,boom', '<vbscript:msgbox(1)>'])('rejects unsafe authored destination %s', async (text) => {
    const files = miniPackage({ docs: [{ ref: 'GT-001', path: 'source.pdf', bytes: original }], prose: [text] });
    const result = await importCandidate({ files }, root);
    expect(result.verdict).toBe('reject');
    expect(result.diagnostics.map((d) => d.code)).toContain('LINK_UNSAFE_SCHEME');
  });

  it('binds acknowledgements to the reviewed manifest even if the results identity is unchanged', async () => {
    const files = miniPackage({ docs: [{ ref: 'GT-001', path: 'source.pdf', bytes: original }], prose: ['[[ZZ-999]]'] });
    const first = await importCandidate({ files }, root);
    expect(first.verdict).toBe('report');
    expect(canActivate(first, null).ok).toBe(false);
    const ack = acknowledge(first, first.warningFingerprints);
    expect(canActivate(first, ack).ok).toBe(true);
    const renamed = editManifestOnly(files, (m) => { m.case.label = 'Changed display label'; });
    const second = await importCandidate({ files: renamed }, root);
    expect(second.candidate?.resultsVersion).toBe(first.candidate?.resultsVersion);
    const decision = canActivate(second, ack);
    expect(decision.ok).toBe(false);
    expect(decision.reasons).toEqual([{ code: 'ACK_STALE', message: 'the acknowledgement was made for different results or diagnostics; acknowledge again', fields: ['manifestSha256'] }]);
  });

  it('preserves immutable bytes after producer buffers are changed', async () => {
    const files = validFiles();
    const result = await importCandidate({ files }, root);
    expect(result.verdict).toBe('accept');
    if (!result.candidate) throw new Error('a valid package has no candidate');
    for (const b of files.values()) b.fill(0);
    expect(result.candidate.dataset('chronology')?.count).toBe(1);
    const stored = new Map([...result.candidate.snapshot()].map(({ path, bytes }): [string, Uint8Array] => [path, bytes]));
    expect(verifyCandidateBytes(stored, result.candidate.identity())).toEqual({ ok: true, problems: [] });
  });

  it('keeps input and results identities stable when only source names or producer metadata change', async () => {
    const files = validFiles();
    const first = await importCandidate({ files }, root);
    const renamed = editManifestOnly(files, (m) => {
      m.inputRevision.sources[0].name = 'renamed-source.html';
      m.producer.version = '99.1';
      m.created = '2001-01-02T00:00';
    });
    const second = await importCandidate({ files: renamed }, root);
    expect(second.verdict).toBe('accept');
    expect(second.candidate?.inputRevisionId).toBe(first.candidate?.inputRevisionId);
    expect(second.candidate?.resultsVersion).toBe(first.candidate?.resultsVersion);
    expect(second.candidate?.manifestSha256).not.toBe(first.candidate?.manifestSha256);
  });

  it('changes results identity when same-size original bytes change and rejects the stale original index', async () => {
    const caseFolder = await mkdtemp(path.join(root, 'identity-'));
    await writeFile(path.join(caseFolder, 'source.pdf'), original);
    const firstFiles = validFiles();
    const first = await importCandidate({ files: firstFiles }, caseFolder);
    const changed = new Uint8Array(original);
    changed[changed.length - 2] = 88;
    await writeFile(path.join(caseFolder, 'source.pdf'), changed);
    const stale = await importCandidate({ files: firstFiles }, caseFolder);
    expect(stale.verdict).toBe('reject');
    expect(stale.counts.ORIG_FINGERPRINT_MISMATCH).toBe(1);
    const secondFiles = miniPackage({ docs: [{ ref: 'GT-001', path: 'source.pdf', bytes: changed }] });
    const second = await importCandidate({ files: secondFiles }, caseFolder);
    expect(second.verdict).toBe('accept');
    expect(second.candidate?.resultsVersion).not.toBe(first.candidate?.resultsVersion);
  });

  it('renders markup as text and refuses a hostile citation resolver', () => {
    const output = renderNarrative('<img src=x onerror=alert(1)> [[GT-001]]', { resolveCitationHref: () => '//outside.invalid/x' });
    expect(output).toBe('<p>&lt;img src=x onerror=alert(1)&gt; <span class="cite-broken" title="Citation does not resolve">[[GT-001]]</span></p>');
    expect(renderNarrative('[[GT-001#p2]]', { resolveCitationHref: () => '/v/test/doc/GT-001?page=2' })).toBe('<p><a class="cite" href="/v/test/doc/GT-001?page=2">GT-001 p.2</a></p>');
  });

  it('rejects over-limit input through the real importer', async () => {
    const result = await importCandidate({ files: validFiles() }, root, { limits: { manifestBytes: 32 } });
    expect(result.verdict).toBe('reject');
    expect(result.diagnostics.map((d) => d.code)).toEqual(['PKG_TOO_LARGE']);
  });

  it('rejects duplicate JSON keys at the acceptance boundary', async () => {
    const files = validFiles();
    files.set('manifest.json', new TextEncoder().encode('{"format":"clearcase.results-package","formatVersion":1,"formatVersion":2}\n'));
    const result = await importCandidate({ files }, root);
    expect(result.verdict).toBe('reject');
    expect(result.diagnostics.map((d) => d.code)).toEqual(['JSON_DUPLICATE_KEY']);
  });
});
