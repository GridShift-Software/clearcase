// Focused component checks of the intake module: the D1 schema's immutability, the repository's idempotence, the budget
// parser, path normalization, the bounded readers and the module's hosted-safe imports. Unit doubles only.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { d1SubmissionRepository, intakeBudget, safePath, type IntakeD1 } from '../../../src/lib/submissions/index.ts';
import { readAtMost, readExactly, looksLikePdf } from '../../../src/lib/submissions/body.ts';
import { CASE_A, CASE_B, CLIENT, SqliteD1, hex, syntheticPdf, trackedBody } from './doubles.ts';
import { MIGRATIONS } from './harness.ts';

const AT = '2026-10-24T12:00:00.000Z';
function repo() {
  const db = new SqliteD1(MIGRATIONS);
  return { db, r: d1SubmissionRepository(db as unknown as IntakeD1) };
}
const decl = (operationId: string, bytes = syntheticPdf(), caseId = CASE_A) => ({
  clientId: CLIENT, caseId, operationId, assetId: `sub-${operationId}`, path: 'a/claim.pdf', filename: 'claim.pdf', mediaType: 'application/pdf' as const,
  size: bytes.byteLength, sha256: hex(bytes), principal: { issuer: 'https://issuer.test', subject: 'user-a' }, at: AT,
});

describe('submission repository over the submissions_* migration', () => {
  it('commits once, returns the same frozen manifest on every retry, and refuses an unstored upload', async () => {
    const { r } = repo(), s = { clientId: CLIENT, caseId: CASE_A, operationId: 'op-aaaaaaaaaaaaaaaa' };
    expect(await r.declare(decl(s.operationId))).toEqual({ kind: 'declared', repeated: false });
    expect(await r.declare(decl(s.operationId))).toEqual({ kind: 'declared', repeated: true });
    expect(await r.declare(decl(s.operationId, syntheticPdf('two')))).toEqual({ kind: 'operation-reused' });
    await expect(r.commitRevision({ ...s, at: AT })).rejects.toMatchObject({ code: 'storage-unavailable' });
    await r.markStored({ ...s, at: AT });
    const m = await r.commitRevision({ ...s, at: AT });
    expect(Object.isFrozen(m) && Object.isFrozen(m.files)).toBe(true);
    expect(await r.commitRevision({ ...s, at: '2027-01-01T00:00:00.000Z' })).toEqual(m);
    expect(m).toMatchObject({ format: 'clearcase.submission-manifest/1', revisionId: 'subrev-op-aaaaaaaaaaaaaaaa', sequence: 1, finalizedAt: AT });
  });

  it('keeps cases apart: the same operation id in another case is its own upload with its own sequence', async () => {
    const { r } = repo(), op = 'op-bbbbbbbbbbbbbbbb';
    for (const caseId of [CASE_A, CASE_B]) {
      await r.declare(decl(op, syntheticPdf(), caseId));
      await r.markStored({ clientId: CLIENT, caseId, operationId: op, at: AT });
      expect((await r.commitRevision({ clientId: CLIENT, caseId, operationId: op, at: AT })).sequence).toBe(1);
    }
    expect(await r.revision({ clientId: CLIENT, caseId: CASE_B, operationId: 'op-cccccccccccccccc' })).toBeNull();
  });

  it('refuses any update or delete of a finalized revision or file, any change to a declaration, and any state rollback', async () => {
    const { db, r } = repo(), s = { clientId: CLIENT, caseId: CASE_A, operationId: 'op-dddddddddddddddd' };
    await r.declare(decl(s.operationId));
    await r.markStored({ ...s, at: AT });
    await r.commitRevision({ ...s, at: AT });
    expect(() => db.exec("UPDATE submissions_revision SET sequence = 9")).toThrow(/immutable/);
    expect(() => db.exec('DELETE FROM submissions_revision')).toThrow(/immutable/);
    expect(() => db.exec("UPDATE submissions_file SET sha256 = 'x'")).toThrow(/immutable/);
    expect(() => db.exec('DELETE FROM submissions_file')).toThrow(/immutable/);
    expect(() => db.exec("UPDATE submissions_upload SET path = 'b/other.pdf'")).toThrow(/fixed/);
    expect(() => db.exec("UPDATE submissions_upload SET state = 'received'")).toThrow(/fixed/);
    expect(() => db.exec('DELETE FROM submissions_upload')).toThrow(/retained/);
  });
});

describe('trusted budget', () => {
  it('has no default and refuses anything but the two positive bounds', () => {
    expect(intakeBudget(undefined)).toBeNull();
    expect(intakeBudget('{"maxFileBytes":10}')).toBeNull();
    expect(intakeBudget({ maxFileBytes: 10, maxMetadataBytes: 10, extra: 1 })).toBeNull();
    expect(intakeBudget({ maxFileBytes: 0, maxMetadataBytes: 10 })).toBeNull();
    expect(intakeBudget({ maxFileBytes: 10, maxMetadataBytes: 10 }, { maxOriginalBytes: 9 })).toBeNull();
    expect(intakeBudget('{"maxFileBytes":10,"maxMetadataBytes":10}', { maxOriginalBytes: 10 })).toEqual({ maxFileBytes: 10, maxMetadataBytes: 10 });
  });
});

describe('path normalization', () => {
  it('normalizes to NFC and folds the collision key; keeps the original spelling for display', () => {
    expect(safePath('Letters/Cafe\u0301.PDF')).toEqual({ path: 'Letters/Caf\u00e9.PDF', filename: 'Caf\u00e9.PDF', key: 'letters/caf\u00e9.pdf' });
    expect(safePath('a/claim.pdf')?.key).toBe(safePath('A/CLAIM.pdf')?.key);
    expect(safePath('x'.repeat(256) + '.pdf')).toBeNull();
    expect(safePath(Array(17).fill('a').join('/') + '.pdf')).toBeNull();
    expect(safePath('a/\ud800.pdf')).toBeNull();
  });
});

describe('bounded readers and the PDF check', () => {
  it('reads exactly, refuses more without pulling far past the bound, and reports a short body as incomplete', async () => {
    const bytes = syntheticPdf();
    expect(await readExactly(trackedBody(bytes).stream, bytes.byteLength)).toEqual({ kind: 'ok', bytes });
    expect(await readExactly(trackedBody(bytes, { cutAt: 10 }).stream, bytes.byteLength)).toEqual({ kind: 'incomplete' });
    const t = trackedBody(new Uint8Array(10_000), { chunk: 100 });
    expect(await readAtMost(t.stream, 1000)).toEqual({ kind: 'too-large' });
    expect(t.state.pulled).toBeLessThanOrEqual(1100);
    expect(await readAtMost(null, 10)).toEqual({ kind: 'ok', bytes: new Uint8Array(0) });
  });

  it('wants a PDF header and an end marker', () => {
    expect(looksLikePdf(syntheticPdf())).toBe(true);
    expect(looksLikePdf(syntheticPdf().subarray(0, 40))).toBe(false);
    expect(looksLikePdf(new TextEncoder().encode('%PDX-1.7 %%EOF'))).toBe(false);
  });
});

describe('hosted safety of the module', () => {
  it('imports no Node built-in, no filesystem and no local-case module', () => {
    const dir = path.join(import.meta.dirname, '../../../src/lib/submissions');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/from '([^']+)'/g)) {
        expect(m[1], `${f} imports ${m[1]}`).not.toMatch(/^node:|^(fs|path|os|child_process)$|local-case|case-package\/index/);
      }
    }
  });
});
