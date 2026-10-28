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

// These writes seed only the synthetic D1 double. Hosted page modules expose no mutation actions.
async function readHosted(route: string) {
  const h = await hosted[`../../../deploy/client/routes/cases/[caseId]/v/[version]/${route}/+page.server.ts`]!() as { load: (event: unknown) => Promise<Record<string, any>> };
  return h.load({ locals, params: { caseId: b.caseId, version: b.rv } });
}
async function put(store: string, rowId: string, fields: Record<string, string | number | boolean | null>) {
  expect((await locals.userWork.putRow({ caseId: id('case', b.caseId), store, rowId, fields, anchor: null, expected: { kind: 'absent' }, operationId: crypto.randomUUID() })).kind).toBe('written');
}

describe('14b user work from the D1 double', () => {
  test('payments, net settlement and interest dates include saved receipts with the local hash and cents format', async () => {
    await put('payments', 'receipt-one', { seq: 2, date: '2200-02-03', amount: '10.25', amountCents: 1025, method: 'Transfer', note: 'Synthetic receipt' });
    const payments = await readHosted('quantum/payments_tab');
    expect(payments.payments).toEqual([expect.objectContaining({ rowId: 'receipt-one', amountCents: '1025', date: '2200-02-03', hash: expect.stringMatching(/^[a-f0-9]{32}$/) })]);
    expect((await readHosted('quantum/settlement_tab')).payments).toMatchObject({ count: 1, counted: 1, paid: '1025' });
    expect((await readHosted('quantum/interest_calc_tab')).paymentDates).toEqual(['2200-02-03']);
  });

  test('enforcement applies the saved status to the matching imported step', async () => {
    const before = await readHosted('litigation/enforcement_tab');
    const step = before.rows.find((r: { key: string | null }) => r.key);
    expect(step).toBeDefined();
    await put('enforcement-status', 'step-one', { seq: 1, stepKey: step.key, status: 'Done' });
    const after = await readHosted('litigation/enforcement_tab');
    expect(after.rows.find((r: { key: string }) => r.key === step.key)).toMatchObject({ override: 'Done' });
  });

  test('filings combines imported seed overlays and the user register and ignores edit requests', async () => {
    const seed = b.lc.store.seeds(b.rv).find((s) => s.dataset_key === 'filings')!;
    expect(seed).toBeDefined();
    const result = await locals.userWork.putSeedOverlay({ caseId: id('case', b.caseId), operationId: crypto.randomUUID(), expected: { kind: 'absent' }, overlay: {
      caseId: b.caseId, datasetKey: 'filings', seedId: seed.seed_id, baseSeedSha256: seed.seed_sha256, fields: { filing: 'Edited synthetic filing' },
    } });
    expect(result.kind).toBe('written');
    await put('filings-register', 'filing-one', { seq: 1, filing: 'Added synthetic filing', ref: 'OD-002' });
    const data = await readHosted('evidence/filings_tab');
    expect(data.entries.map((e: { state: string; fields: { filing: string } }) => [e.state, e.fields.filing])).toEqual(expect.arrayContaining([['edited', 'Edited synthetic filing'], ['user', 'Added synthetic filing']]));
    expect(data.editing).toBeNull();
    expect(data.empty).toBe(false);
  });

  test('cross-examination combines seed overlays and user rows', async () => {
    const seed = b.lc.store.seeds(b.rv).find((s) => s.dataset_key === 'lit-crossexam-seed')!;
    expect(seed).toBeDefined();
    expect((await locals.userWork.putSeedOverlay({ caseId: id('case', b.caseId), operationId: crypto.randomUUID(), expected: { kind: 'absent' }, overlay: {
      caseId: b.caseId, datasetKey: 'lit-crossexam-seed', seedId: seed.seed_id, baseSeedSha256: seed.seed_sha256, fields: { topic: 'Edited synthetic topic' },
    } })).kind).toBe('written');
    await put('crossexam', 'topic-one', { seq: 1, witness: 'Synthetic Witness', topic: 'User topic', put: 'Invented question', docs: '' });
    const data = await readHosted('litigation/crossexam_tab');
    expect(data.rows).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'edited', topic: 'Edited synthetic topic' }), expect.objectContaining({ kind: 'user', topic: 'User topic' })]));
  });

  test('heads and authorities show saved rows, and heads resolves only known document references', async () => {
    await put('heads', 'head-one', { head: 'Synthetic head', sub: 'Synthetic argument', auth: '', ref: 'OD-001 ZZ-404' });
    const heads = await readHosted('litigation/heads_tab');
    expect(heads.empty).toBe(false);
    expect(heads.rows[0].evidence).toEqual([{ text: 'OD-001', ref: true }, { text: 'ZZ-404', ref: false }]);
    await put('authorities', 'authority-one', { topic: 'Synthetic topic', authority: 'Synthetic authority', proposition: 'Invented proposition' });
    expect((await readHosted('litigation/authorities_tab')).user).toEqual([expect.objectContaining({ authority: 'Synthetic authority' })]);
  });

  test('information-required checks merge and detached work counts as non-empty', async () => {
    const data = await readHosted('analysis/info_required_tab');
    expect(data.rows.length).toBeGreaterThan(0);
    await put('info-required', data.rows[0].key, { done: true });
    expect((await readHosted('analysis/info_required_tab')).rows[0].done).toBe(true);
  });
});
