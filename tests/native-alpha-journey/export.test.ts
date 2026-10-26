import { describe, expect, it } from 'vitest';
import { CASE, fixtureOnce } from './harness.ts';
import { simExport, simExportContract } from './world.ts';
import { exportContractProblems, validateExport } from './export.ts';

const assetId = 'sub-op-0001';
async function check(change?: Parameters<typeof simExport>[3], level: 0 | 6 = 6) {
  const fixture = await fixtureOnce();
  return validateExport(simExport(fixture, CASE, assetId, change, level), simExportContract, { caseId: CASE, assetId, fixture });
}

describe('complete export validation, not raw original containment', () => {
  it.each([0, 6] as const)('decodes and verifies ZIP compression level %s', async (level) => {
    expect(await check(undefined, level)).toEqual([]);
    if (level === 6) {
      const f = await fixtureOnce();
      expect(Buffer.from(simExport(f, CASE, assetId)).includes(Buffer.from(f.pdf.bytes))).toBe(false);
    }
  });
  it.each(['caseId', 'resultsVersion', 'schema'])('rejects a well-formed manifest for the wrong %s', async (key) => {
    expect((await check((m) => { m[key] = 'wrong'; })).length).toBeGreaterThan(0);
  });
  it.each(['assetId', 'path', 'sha256', 'size', 'kind'])('rejects an original with the wrong %s even with intact PDF bytes', async (key) => {
    expect((await check((m) => {
      const rows = m.files as Record<string, unknown>[];
      rows[0][key] = key === 'size' ? 99 : key === 'sha256' ? 'f'.repeat(64) : 'wrong';
    })).length).toBeGreaterThan(0);
  });
  it('rejects a manifest with no original, or with an omitted archive entry', async () => {
    expect((await check((m) => { m.files = []; })).length).toBeGreaterThan(0);
    expect((await check((_m, entries) => { entries['unlisted.txt'] = new TextEncoder().encode('not listed'); })).length).toBeGreaterThan(0);
  });
  it('rejects a listed original absent from the archive', async () => {
    expect((await check((_m, entries) => { delete entries[Object.keys(entries)[0]]; })).length).toBeGreaterThan(0);
  });
  it('rejects corrupted original bytes and malformed archives', async () => {
    expect((await check((_m, entries) => { const key = Object.keys(entries)[0]; entries[key] = entries[key].slice(); entries[key][20] ^= 1; })).length).toBeGreaterThan(0);
    const fixture = await fixtureOnce();
    const bytes = simExport(fixture, CASE, assetId, undefined, 0);
    const offset = Buffer.from(bytes).indexOf(Buffer.from(fixture.pdf.bytes));
    expect(offset).toBeGreaterThan(0);
    bytes[offset + 20] ^= 1;
    expect((await validateExport(bytes, simExportContract, { caseId: CASE, assetId, fixture })).length).toBeGreaterThan(0);
    expect((await validateExport(new TextEncoder().encode('not an export'), simExportContract, { caseId: CASE, assetId, fixture })).length).toBeGreaterThan(0);
  });
  it('requires the owning document and every validation projection', () => {
    expect(exportContractProblems(undefined).length).toBeGreaterThan(0);
    for (const key of Object.keys(simExportContract)) {
      const c: Record<string, unknown> = { ...simExportContract };
      delete c[key];
      expect(exportContractProblems(c).length).toBeGreaterThan(0);
    }
  });
});
