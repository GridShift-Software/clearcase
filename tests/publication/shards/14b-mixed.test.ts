// Seam 1: real local loaders versus the built JSON shards and the real D1 user-work adapter with empty work.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import family from '../../../scripts/publish/shards/views-mixed';
import { bootCase, type Booted } from '../../registers/04-harness';
import { fixture } from '../../hosted-foundation/user-work/helpers';
import { CLIENT, LIMITS, d1 } from '../../hosted-foundation/user-work/world';
import { createD1UserWork } from '../../../src/lib/user-work/hosted';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids';
import type { CaseReader, RequestServices } from '../../../src/lib/server/runtime/contracts';

const routes = [
  'evidence/filings_tab', 'quantum/payments_tab', 'quantum/interest_calc_tab', 'quantum/settlement_tab',
  'litigation/enforcement_tab', 'litigation/crossexam_tab', 'litigation/authorities_tab', 'litigation/heads_tab',
  'analysis/info_required_tab',
];
const local = import.meta.glob('../../../src/routes/**/+page.server.ts');
const hosted = import.meta.glob('../../../deploy/client/routes/**/+page.server.ts');
let b: Booted;
let f: ReturnType<typeof fixture>;
let locals: RequestServices;
let files: Map<string, Uint8Array>;

beforeAll(async () => {
  b = await bootCase('14b-mixed');
  f = fixture();
  const caseId = id('case', b.caseId), rv = resultsVersion(b.rv);
  f.auth.grant('editor', caseId, 'editor');
  files = new Map((await family.build({ caseId, resultsVersion: rv, store: b.lc.store, vc: b.input().vc, pure: b.input(),
    json: (name, data) => ({ name, bytes: new TextEncoder().encode(JSON.stringify(data)) }),
  })).map((s) => [s.name, s.bytes]));
  const store: CaseReader = new Proxy(f.reader.reader, { get(target, key) {
    if (key === 'publication') return async () => ({ versionId: rv, publishedAt: null, previousVersionId: null, shardManifestSha256: 'a'.repeat(64), shards: Object.fromEntries([...files].map(([n, v]) => [n, v.byteLength])) });
    if (key === 'seeds') return async () => b.lc.store.seeds(b.rv).map((s) => ({ datasetKey: s.dataset_key, seedId: s.seed_id, seedSha256: s.seed_sha256, record: JSON.parse(s.record_json) }));
    return Reflect.get(target, key);
  } });
  const userWork = createD1UserWork({ db: d1(f.db), config: { clientId: CLIENT, limits: LIMITS }, identity: f.auth.identity(), audit: f.audit.sink, store, now: () => new Date('2200-01-01T00:00:00Z') });
  locals = { store, userWork, shards: { read: async ({ name }) => new Response(new TextDecoder().decode(files.get(name))) } } as RequestServices;
}, 180_000);
afterAll(async () => { f?.db.close(); await b?.stop(); });

describe('14b mixed shard seam', () => {
  test.each(routes)('%s: hosted merged props equal the local load with no user work', async (route) => {
    const fixed = '00000000-0000-4000-8000-000000000001' as const;
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(fixed);
    try {
      const module = await local[`../../../src/routes/v/[vid]/${route}/+page.server.ts`]!();
      const expected = await b.load(module);
      // Local loaders import node:crypto.randomUUID; its id has the same role but is minted independently.
      if ('addId' in expected) expected.addId = fixed;
      const h = await hosted[`../../../deploy/client/routes/cases/[caseId]/v/[version]/${route}/+page.server.ts`]!() as { load: (event: unknown) => Promise<Record<string, unknown>> };
      const result = await h.load({ locals, params: { caseId: b.caseId, version: b.rv } });
      const { base, empty, ...actual } = result;
      expect(base).toBe(`/cases/${b.caseId}/v`);
      expect(typeof empty).toBe('boolean');
      expect(actual).toEqual(expected);
    } finally { uuid.mockRestore(); }
  });

  test('all nine shard names are unique and parse, and hosted routes export no actions', async () => {
    expect(files.size).toBe(9);
    for (const route of routes) {
      expect(() => JSON.parse(new TextDecoder().decode(files.get(`view/${route.split('/')[1]}.json`)))).not.toThrow();
      const module = await hosted[`../../../deploy/client/routes/cases/[caseId]/v/[version]/${route}/+page.server.ts`]!();
      expect(module).not.toHaveProperty('actions');
    }
  });
});
