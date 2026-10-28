// Sprint ticket 06, review finding M2: `register` verifies what D1 holds, not only what the build wrote. It reads the
// persisted projection back and recomputes its digest with loadVerifiedModel; a conflicting existing row is refused, never
// ignored; a version is stored only once its rows verify; a stored or published model is never changed.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { register } from '../../../scripts/publish/publish.ts';
import { signoff } from '../../../scripts/publish/signoff.ts';
import type { BuildRecord } from '../../../scripts/publish/types.ts';
import { publicationRow } from '../../../src/lib/results/hosted/versions.ts';
import { acksFor, AT, builtCase, caseId, client, manifestOf, missing, published, SIGNER, type BuiltCase, type Deployment } from './world.ts';

let b: BuiltCase;
beforeAll(async () => { b = await builtCase(); }, 120_000);
afterAll(() => b?.cleanup());
const opts = () => ({ at: AT, acknowledgedMissing: missing(b.built), manifest: manifestOf(b) });
const documents = (dep: Deployment) => dep.db.sqlite.prepare('SELECT * FROM rs_document ORDER BY ord').all();
/** The build's record with its first document's list row changed: counts and the claimed digest still match. */
const tampered = (): BuildRecord => ({ ...b.built.record, rows: { ...b.built.record.rows, documents: b.built.record.rows.documents.map((d, i) => (i === 0 ? { ...d, list_json: '{}' } : d)) } });

describe('06 register verifies the persisted read model', () => {
  test('a changed existing document row makes register fail (review probe 3)', async () => {
    const dep = client(), r = b.built.record;
    await register(dep.d1, r, opts());
    dep.db.sqlite.exec("UPDATE rs_document SET list_json = '{}' WHERE ord = 0");
    await expect(register(dep.d1, r, opts())).rejects.toThrow(/do not reproduce its read-model digest/);
  });

  test('rows that do not reproduce the digest are never stored, and a later register refuses the conflicting row instead of ignoring it', async () => {
    const dep = client(), r = b.built.record;
    await expect(register(dep.d1, tampered(), opts())).rejects.toThrow(/do not reproduce its read-model digest/);
    expect(dep.db.sqlite.prepare('SELECT state FROM rs_results_version').get()).toEqual({ state: 'staging' });
    await expect(signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT })).rejects.toThrow(/register first/);
    const held = documents(dep);
    await expect(register(dep.d1, r, opts())).rejects.toThrow(/already holds rs_document .* with other content/);
    expect(documents(dep)).toEqual(held);
  });

  test('register never changes a published model', async () => {
    const dep = await published(b);
    const held = documents(dep), publication = await publicationRow(dep.db, caseId);
    await expect(register(dep.d1, tampered(), opts())).rejects.toThrow(/do not reproduce|other content/);
    expect([documents(dep), await publicationRow(dep.db, caseId)]).toEqual([held, publication]);
    await register(dep.d1, b.built.record, opts());
  });

  test('refuses a manifest.json that is not the one this build wrote', async () => {
    const dep = client();
    await expect(register(dep.d1, b.built.record, { ...opts(), manifest: new TextEncoder().encode('{}') })).rejects.toThrow(/manifest\.json .* not the one this build wrote/);
  });
});
