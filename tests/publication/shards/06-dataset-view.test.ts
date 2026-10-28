// Sprint ticket 06 (for 14a): `datasetView` takes an optional request-time post-step over the shard's props, run with the
// request clock; without it the loader returns the shard as before.
import { describe, expect, test } from 'vitest';
import type { RequestServices } from '../../../src/lib/server/runtime/contracts.ts';
import { datasetView } from '../../../src/lib/views/hosted/payloads.server.ts';

const RV = `sha256:${'a'.repeat(64)}`, NOW = new Date('2031-03-04T05:06:07.000Z');
const NAME = 'view/matter.json', SHARD = { rows: [1, 2], asOf: 'build date' };
function event() {
  const locals = {
    store: { publication: async () => ({ versionId: RV, publishedAt: null, previousVersionId: null, shardManifestSha256: 'b'.repeat(64), shards: { [NAME]: 1 } }) },
    shards: { read: async () => new Response(JSON.stringify(SHARD)) },
    runtime: { now: () => NOW },
  } as unknown as RequestServices;
  return { locals, params: { caseId: 'synth-case', version: RV } };
}

describe('06 datasetView', () => {
  test('without a post-step it returns the shard, the route base and isEmpty of the shard', async () => {
    const load = datasetView('matter', (d) => (d as unknown as typeof SHARD).rows.length === 0);
    expect(await load(event())).toEqual({ ...SHARD, base: '/cases/synth-case/v', empty: false });
  });

  test('a post-step runs once with the request clock; its result is what the page and isEmpty get', async () => {
    const calls: unknown[] = [];
    const load = datasetView('matter', (d) => (d as unknown as typeof SHARD).rows.length === 0, {
      post: (props, { now }) => { calls.push([props, now]); return { ...props, asOf: now.toISOString(), rows: [] } as typeof props; },
    });
    expect(await load(event())).toEqual({ asOf: NOW.toISOString(), rows: [], base: '/cases/synth-case/v', empty: true });
    expect(calls).toEqual([[SHARD, NOW]]);
  });
});
