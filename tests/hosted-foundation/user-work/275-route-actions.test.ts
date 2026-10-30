// GRS-275: the hosted user-work routes, driven one form action at a time by a call on the route's own module in this file, so
// the class suite's HOSTED_FORM_EVIDENCE can bind each route to a test that visibly reaches it (its checker follows a call on the
// imported module, not a module handed to a helper in another file). The wider adverse cases are in the 17a, 17b and 18 tests.
// Synthetic SQLite/D1 user-work double and invented values; not evidence of Cloudflare D1 or of a deployed save time.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: {} }));
import * as annotations from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/annotations_tab/+page.server.ts';
import * as authorities from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/authorities_tab/+page.server.ts';
import * as caselines from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/caselines_tab/+page.server.ts';
import * as courtBundle from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/+page.server.ts';
import * as crossexam from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/crossexam_tab/+page.server.ts';
import * as deadlines from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/deadlines_tab/+page.server.ts';
import * as disbursements from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/disbursements_tab/+page.server.ts';
import * as discovery from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/discovery_tab/+page.server.ts';
import * as enforcement from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/enforcement_tab/+page.server.ts';
import * as filings from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/filings_tab/+page.server.ts';
import * as heads from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/heads_tab/+page.server.ts';
import * as infoRequired from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/info_required_tab/+page.server.ts';
import * as payments from '../../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/payments_tab/+page.server.ts';
import * as popia from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/popia_tab/+page.server.ts';
import * as privilege from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/privilege_tab/+page.server.ts';
import * as timesheet from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/timesheet_tab/+page.server.ts';
import * as transcriptions from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/transcriptions_tab/+page.server.ts';
import { d1WorkRevision } from '../../../src/lib/user-work/hosted/index.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { SHARDS as LITIGATION_SHARDS } from '../../litigation/17b-world.ts';
import { CASE, RV1, fixture } from './helpers.ts';
import { CLIENT, LIMITS, d1 } from './world.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const SHARDS: Record<string, unknown> = {
  ...LITIGATION_SHARDS,
  'view/court_bundle_tab.json': { pathShard: { paths: {} }, bundles: [], links: [], header: {} },
  'view/caselines_tab.json': { pathShard: { paths: {} }, index: [] },
};

function world() {
  const f = fixture();
  f.db.exec(readFileSync('src/lib/user-work/hosted/migrations/0002_bundle_tables.sql', 'utf8'));
  const admitted = Object.fromEntries(Object.entries(SHARDS).map(([name, v]) => [name, encode(v).byteLength]));
  const locals = {
    userWork: f.make(), identity: f.auth.identity(), runtime: { now: () => new Date('2026-11-01T10:00:00Z') },
    store: {
      publication: async () => ({ versionId: RV1, publishedAt: null, previousVersionId: null, shardManifestSha256: 'a'.repeat(64), shards: admitted }),
      stateRevision: d1WorkRevision({ db: d1(f.db), config: { clientId: CLIENT, limits: LIMITS } }),
    },
    shards: { read: async (a: { name: string }) => new Response(encode(SHARDS[a.name])) },
  } as unknown as C.RequestServices;
  return { ...f, locals, params: { caseId: CASE, version: RV1 } };
}
type World = ReturnType<typeof world>;
const form = (fields: Record<string, string>) => { const body = new FormData(); Object.entries(fields).forEach(([k, v]) => body.set(k, v)); return body; };
/** The event SvelteKit hands a form action: the request services, the route's params and the POSTed fields. */
const post = (w: World, action: string, fields: Record<string, string>) =>
  ({ locals: w.locals, params: w.params, url: new URL('https://synthetic.invalid/'), request: new Request(`https://synthetic.invalid/?/${action}`, { method: 'POST', body: form(fields) }) }) as never;
const read = (w: World) => ({ locals: w.locals, params: w.params, url: new URL('https://synthetic.invalid/') }) as never;
const rowsIn = (w: World, store: string) => w.db.prepare('SELECT row_id, fields_json FROM uw_register_row WHERE store = ? ORDER BY rowid').all(store) as { row_id: string; fields_json: string }[];

describe('275 hosted registers, saved through each route file', () => {
  it('annotations: save stores a private note against a document and the route load lists it', async () => {
    const w = world();
    try {
      const entry = { ref: 'D-001', date: '2026-11-02', note: 'Synthetic annotation' };
      expect(await annotations.actions.save!(post(w, 'save', entry))).toMatchObject({ saved: true });
      expect(((await annotations.load!(read(w))) as any).rows).toMatchObject([{ values: entry }]);
    } finally { w.db.close(); }
  });

  it('deadlines: save stores a dated deadline and the route load lists it', async () => {
    const w = world();
    try {
      const entry = { title: 'Synthetic filing deadline', date: '2026-11-04', cat: 'Filing', note: 'Synthetic note' };
      expect(await deadlines.actions.save!(post(w, 'save', entry))).toMatchObject({ saved: true });
      expect(((await deadlines.load!(read(w))) as any).rows).toMatchObject([{ values: entry }]);
    } finally { w.db.close(); }
  });

  it('disbursements: save stores a payee amount and the route load lists it', async () => {
    const w = world();
    try {
      const entry = { date: '2026-11-02', desc: 'Synthetic disbursement', payee: 'Synthetic payee', amount: '120.50' };
      expect(await disbursements.actions.save!(post(w, 'save', entry))).toMatchObject({ saved: true });
      expect(((await disbursements.load!(read(w))) as any).rows).toMatchObject([{ values: { desc: entry.desc, payee: entry.payee } }]);
    } finally { w.db.close(); }
  });

  it('popia: save stores a processing record, and delete asks for the confirmation before it removes it', async () => {
    const w = world();
    try {
      const entry = { activity: 'Synthetic activity', category: 'Synthetic category', lawful: 'Synthetic basis', retention: 'Synthetic period' };
      expect(await popia.actions.save!(post(w, 'save', entry))).toMatchObject({ saved: true });
      const shown = ((await popia.load!(read(w))) as any).rows[0];
      expect(shown).toMatchObject({ values: entry });
      expect(await popia.actions.delete!(post(w, 'delete', { delete: shown.rowId, deleteVersion: shown.version }))).toMatchObject({ status: 400, data: { confirm: shown.rowId } });
      expect(await popia.actions.delete!(post(w, 'delete', { delete: shown.rowId, deleteVersion: shown.version, confirm: shown.rowId }))).toMatchObject({ op: 'delete', deleted: true });
      expect(((await popia.load!(read(w))) as any).rows).toEqual([]);
    } finally { w.db.close(); }
  });

  it('privilege: save stores a withheld document with its basis and the route load lists it', async () => {
    const w = world();
    try {
      const entry = { ref: 'D-001', date: '2026-11-02', desc: 'Synthetic withheld document', basis: 'Legal advice' };
      expect(await privilege.actions.save!(post(w, 'save', entry))).toMatchObject({ saved: true });
      expect(((await privilege.load!(read(w))) as any).rows).toMatchObject([{ values: entry }]);
    } finally { w.db.close(); }
  });

  it('timesheet: save stores a time entry and the route load lists it', async () => {
    const w = world();
    try {
      const entry = { date: '2026-11-02', fee_earner: 'Synthetic earner', activity: 'Synthetic activity', hours: '1.5', rate: '800', billed: 'no' };
      expect(await timesheet.actions.save!(post(w, 'save', entry))).toMatchObject({ saved: true });
      expect(((await timesheet.load!(read(w))) as any).rows).toMatchObject([{ values: { fee_earner: entry.fee_earner, activity: entry.activity } }]);
    } finally { w.db.close(); }
  });

  it('transcriptions: save stores a transcript and the route load lists it', async () => {
    const w = world();
    try {
      const entry = { title: 'Synthetic hearing', date: '2026-11-02', source: 'Synthetic recording', body: 'Synthetic transcript text' };
      expect(await transcriptions.actions.save!(post(w, 'save', entry))).toMatchObject({ saved: true });
      expect(((await transcriptions.load!(read(w))) as any).rows).toMatchObject([{ values: entry }]);
    } finally { w.db.close(); }
  });
});

describe('275 hosted litigation, quantum, evidence and analysis entry forms', () => {
  it('authorities: add stores an authority row', async () => {
    const w = world();
    try {
      expect(await authorities.actions.add!(post(w, 'add', { topic: 'Synthetic topic', authority: 'Synthetic v Synthetic', proposition: 'Synthetic proposition', addId: 'aaaaaaaa-1111-2222-3333-444444444444' }))).toMatchObject({ op: 'add' });
      expect(rowsIn(w, 'authorities')).toHaveLength(1);
    } finally { w.db.close(); }
  });

  it('heads: add stores a head row', async () => {
    const w = world();
    try {
      expect(await heads.actions.add!(post(w, 'add', { head: 'Synthetic heading', sub: 'Synthetic submission', auth: 'Synthetic authority', ref: '', addId: 'bbbbbbbb-1111-2222-3333-444444444444' }))).toMatchObject({ op: 'add' });
      expect(rowsIn(w, 'heads')).toHaveLength(1);
    } finally { w.db.close(); }
  });

  it('crossexam: add stores a question row, and delete removes it once confirmed', async () => {
    const w = world();
    try {
      expect(await crossexam.actions.add!(post(w, 'add', { witness: 'Synthetic witness', topic: 'Synthetic topic', put: 'Synthetic put', docs: '', addId: 'cccccccc-1111-2222-3333-444444444444' }))).toMatchObject({ op: 'add' });
      const mine = ((await crossexam.load!(read(w))) as any).rows.find((r: { target: { rowId?: string } }) => r.target.rowId);
      expect(mine).toBeTruthy();
      expect(await crossexam.actions.delete!(post(w, 'delete', { rowId: mine.del, confirm: mine.del }))).toMatchObject({ op: 'delete', deleted: mine.target.rowId });
    } finally { w.db.close(); }
  });

  it('enforcement: status stores the status of a step against the version it was shown', async () => {
    const w = world();
    try {
      expect(await enforcement.actions.status!(post(w, 'status', { stepKey: 'step-key-1', status: 'Done', version: 'none' }))).toMatchObject({ op: 'status', saved: 'step-key-1' });
    } finally { w.db.close(); }
  });

  it('payments: add stores a payment row', async () => {
    const w = world();
    try {
      expect(await payments.actions.add!(post(w, 'add', { date: '2026-03-01', amount: '1500.50', method: 'Synthetic EFT', note: 'Synthetic note', operationId: 'dddddddd-1111-2222-3333-444444444444' }))).toEqual({ op: 'add', added: true });
      expect(rowsIn(w, 'payments')).toHaveLength(1);
    } finally { w.db.close(); }
  });

  it('filings: add stores a filing row', async () => {
    const w = world();
    try {
      expect(await filings.actions.add!(post(w, 'add', { filing: 'Synthetic notice', fdate: '2026-02-01', fparty: 'Synthetic party', response: '', rdate: '', ref: '', operationId: 'eeeeeeee-1111-2222-3333-444444444444' }))).toEqual({ op: 'add', saved: true });
      expect(rowsIn(w, 'filings-register')).toHaveLength(1);
    } finally { w.db.close(); }
  });

  it('info required: toggle ticks an item of this results version and refuses one it does not list', async () => {
    const w = world();
    try {
      expect(await infoRequired.actions.toggle!(post(w, 'toggle', { key: 'info:one', done: 'true', version: 'none' }))).toMatchObject({ saved: 'info:one', done: true });
      expect(await infoRequired.actions.toggle!(post(w, 'toggle', { key: 'info:nope', done: 'true', version: 'none' }))).toMatchObject({ status: 400 });
      expect(rowsIn(w, 'info-required')).toMatchObject([{ row_id: 'info:one' }]);
    } finally { w.db.close(); }
  });
});

describe('275 hosted Caselines, Court Bundle and Discovery forms', () => {
  it('caselines: link stores a case-folder path, unlink removes it, and a path outside the case folder is refused', async () => {
    const w = world();
    try {
      expect(await caselines.actions.link!(post(w, 'link', { path: 'Synthetic/File-1.pdf' }))).toEqual({ saved: true });
      const shown = ((await caselines.load!(read(w))) as any).links;
      expect(shown).toMatchObject([{ path: 'Synthetic/File-1.pdf' }]);
      expect(await caselines.actions.unlink!(post(w, 'unlink', { id: shown[0].rowId }))).toEqual({ saved: true });
      expect(((await caselines.load!(read(w))) as any).links).toEqual([]);
      expect(await caselines.actions.link!(post(w, 'link', { path: '../outside.pdf' }))).toMatchObject({ status: 400 });
    } finally { w.db.close(); }
  });

  it('court bundle: header stores the header fields with the version it was shown, and clear needs its confirmation', async () => {
    const w = world();
    try {
      const shown = (await courtBundle.load!(read(w))) as any;
      expect(shown.headerStored).toBe(false);
      expect(await courtBundle.actions.header!(post(w, 'header', { version: shown.headerHash, court: 'Synthetic Court' }))).toMatchObject({ saved: true, stored: { court: 'Synthetic Court' } });
      expect(((await courtBundle.load!(read(w))) as any).headerStored).toBe(true);
      expect(await courtBundle.actions.clear!(post(w, 'clear', {}))).toMatchObject({ status: 400, data: { message: 'Confirmation is required.' } });
    } finally { w.db.close(); }
  });

  it('court bundle: save stores a custom bundle, a bad id is refused, and delete removes it', async () => {
    const w = world();
    try {
      const bundle = JSON.stringify({ name: 'Synthetic bundle', pages: 3, indexPages: 1, filePages: 2, note: '', rows: [] });
      expect(await courtBundle.actions.save!(post(w, 'save', { id: 'bundle-275', bundle }))).toMatchObject({ saved: true, id: 'bundle-275' });
      expect(((await courtBundle.load!(read(w))) as any).bundles).toMatchObject([{ id: 'bundle-275', name: 'Synthetic bundle' }]);
      expect(await courtBundle.actions.save!(post(w, 'save', { id: 'bad id!', bundle }))).toMatchObject({ status: 400 });
      expect(await courtBundle.actions.delete!(post(w, 'delete', { id: 'bundle-275' }))).toEqual({ deleted: true, id: 'bundle-275' });
      expect(((await courtBundle.load!(read(w))) as any).bundles).toEqual([]);
    } finally { w.db.close(); }
  });

  it('discovery: select and co mark files, a conflicting co is refused, and mode refuses an unknown schedule', async () => {
    const w = world();
    try {
      expect(await discovery.actions.select!(post(w, 'select', { key: 'Synthetic/File-1.pdf', on: '1' }))).toEqual({ saved: 1 });
      expect(await discovery.actions.co!(post(w, 'co', { key: 'Synthetic/File-1.pdf', val: 'C', base: '' }))).toEqual({ saved: 1 });
      expect(await discovery.actions.co!(post(w, 'co', { key: 'Synthetic/File-1.pdf', val: 'O', base: '' }))).toMatchObject({ status: 409 });
      expect(await discovery.actions.mode!(post(w, 'mode', { mode: 'supplementary' }))).toEqual({ saved: true });
      expect(await discovery.actions.mode!(post(w, 'mode', { mode: 'other' }))).toMatchObject({ status: 400 });
    } finally { w.db.close(); }
  });
});
