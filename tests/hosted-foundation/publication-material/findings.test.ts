// Regression seams from the independent review: real SQL/byte/validator/SSR component paths, labelled transport doubles.
import { afterEach, expect, it } from 'vitest';
import { world, CASE } from './fixture.ts';
import { createPublicationMaterialReader } from '../../../src/lib/server/runtime/hosted/publication-material.ts';
import { d1PublicationSnapshotRevision } from '../../../src/lib/publication/hosted/d1-publisher.ts';
import { signoffBlocker } from '../../../src/lib/publication/hosted/rules.ts';

const worlds: Awaited<ReturnType<typeof world>>[] = [];
async function setup(o?: Parameters<typeof world>[0]) { const w = await world(o); worlds.push(w); return w; }
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });

it('refuses changed original provenance during awaited checker work', async () => {
  const w = await setup(), before = await d1PublicationSnapshotRevision(w.db, w.scope);
  w.options.renderChecker = { async verify() {
    w.db.exec("UPDATE rs_original_upload SET state = 'stored' WHERE case_id = ?", CASE);
    return { state: 'rendered', rendererVersion: 'EXPLICIT UNIT DOUBLE', pages: 1, reason: null };
  } };
  await expect(w.read()).rejects.toMatchObject({ code: 'integrity' });
  expect(await d1PublicationSnapshotRevision(w.db, w.scope)).not.toBe(before);
});

it('holds an unmatched supplied file-level reference without changing canonical warnings', async () => {
  const w = await setup({ excerpt: 'See [[OD-999]]', refs: ['OD-999'] });
  const snapshot = await w.read();
  if (!snapshot) throw new Error('fixture snapshot');
  expect(snapshot.validation.warningFingerprints).toEqual(w.validation.result.warningFingerprints);
  expect(snapshot.validation.errorFingerprints).toEqual([]);
  expect(w.validation.result.counts.CITE_UNRESOLVED).toBeGreaterThan(0);
  expect(signoffBlocker(snapshot)).not.toBeNull();
});

it('audits an initial revision-fence storage refusal', async () => {
  const w = await setup(), reader = createPublicationMaterialReader(w.options)!;
  w.db.withSession = () => { throw new Error('synthetic initial revision read failure'); };
  await expect(reader.read(w.scope)).rejects.toThrow('synthetic initial revision read failure');
  expect(w.events.some((e) => e.outcome === 'failed')).toBe(true);
});
