// GRS-277: a principal granted viewer on the case is refused every hosted user-work write, server-side. Each form action
// and each user-work JSON endpoint is called on its own route module with a viewer identity whose authorize() is the real
// case authorizer (createCaseAuthorizer over the tenant grants migration). Each case shows the refusal (403), that no
// user-work table changed, and the authorizer's `denied` event for the viewer; then the same request from an editor writes,
// so the refusal is the role's and not a malformed form's. Synthetic SQLite/D1 doubles and invented values only: not
// evidence of Cloudflare D1, Clerk or a deployed Worker.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: {} }));
import * as notes from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import * as pageNotes from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/notes/+server.ts';
import * as infoRequired from '../../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/info_required_tab/+page.server.ts';
import * as caselines from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/caselines_tab/+page.server.ts';
import * as assembled from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/assembled/+server.ts';
import * as courtBundle from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/+page.server.ts';
import * as discovery from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/discovery_tab/+page.server.ts';
import * as doc from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import * as filings from '../../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/filings_tab/+page.server.ts';
import * as authorities from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/authorities_tab/+page.server.ts';
import * as crossexam from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/crossexam_tab/+page.server.ts';
import * as enforcement from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/enforcement_tab/+page.server.ts';
import * as heads from '../../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/heads_tab/+page.server.ts';
import * as payments from '../../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/payments_tab/+page.server.ts';
import * as annotations from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/annotations_tab/+page.server.ts';
import * as deadlines from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/deadlines_tab/+page.server.ts';
import * as disbursements from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/disbursements_tab/+page.server.ts';
import * as popia from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/popia_tab/+page.server.ts';
import * as privilege from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/privilege_tab/+page.server.ts';
import * as timesheet from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/timesheet_tab/+page.server.ts';
import * as transcriptions from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/transcriptions_tab/+page.server.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { rowVersion } from '../../../src/lib/views/evidence/filings.ts';
import { createD1UserWork, d1WorkRevision } from '../../../src/lib/user-work/hosted/index.ts';
import { SHARDS as LITIGATION_SHARDS } from '../../litigation/17b-world.ts';
import { client, world as grantWorld } from '../provisioning/world.ts';
import { CASE, RV1, fixture } from './helpers.ts';
import { CLIENT, LIMITS, SHA_A, d1 } from './world.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const SHARDS: Record<string, unknown> = {
  ...LITIGATION_SHARDS,
  'view/court_bundle_tab.json': { pathShard: { paths: {} }, bundles: [], links: [], header: { court: 'Synthetic imported court' } },
  'view/caselines_tab.json': { pathShard: { paths: {} }, index: [] },
};
const ORIGIN = 'https://synthetic.invalid';

/** One case, two people: `viewer` holds a viewer grant on it and `editor` an editor grant, both checked by the real authorizer. */
function world() {
  const f = fixture();
  f.db.exec(readFileSync('src/lib/user-work/hosted/migrations/0002_bundle_tables.sql', 'utf8'));
  const grants = grantWorld({ cases: [CASE] });
  grants.seed(client('viewer'), 'viewer', CASE);
  grants.seed(client('editor'), 'editor', CASE);
  const identity = (subject: string): C.Identity => {
    const principal = client(subject), sessionId = id('session', `session-${subject}`);
    return { kind: 'verified', principal, sessionId, clientId: CLIENT, checkRevocation: async () => {}, authorize: (s) => grants.authorizeCase({ principal, sessionId, caseId: s.caseId, operation: s.operation }) };
  };
  const admitted = Object.fromEntries(Object.entries(SHARDS).map(([name, v]) => [name, encode(v).byteLength]));
  const store = {
    publication: async () => ({ versionId: RV1, publishedAt: null, previousVersionId: null, shardManifestSha256: 'a'.repeat(64), shards: admitted }),
    stateRevision: d1WorkRevision({ db: d1(f.db), config: { clientId: CLIENT, limits: LIMITS } }),
    getCase: async () => ({ caseId: CASE, caseLabel: 'Synthetic case', publication: { kind: 'none' }, href: `/cases/${CASE}`, documents: null }),
  };
  const localsFor = (subject: string) => {
    const who = identity(subject);
    const userWork = createD1UserWork({ db: d1(f.db), config: { clientId: CLIENT, limits: LIMITS }, identity: who, audit: f.audit.sink, store: f.reader.reader, now: () => new Date('2026-11-01T10:00:00Z') });
    return {
      userWork, identity: who, runtime: { now: () => new Date('2026-11-01T10:00:00Z') }, store,
      shards: { read: async (a: { name: string }) => new Response(encode(SHARDS[a.name])) },
      assets: { metadata: async () => ({ sha256: SHA_A, size: 1, mediaType: 'application/pdf' }) },
    } as unknown as C.RequestServices;
  };
  return { db: f.db, events: grants.events, viewer: localsFor('viewer'), editor: localsFor('editor') };
}
type World = ReturnType<typeof world>;
const PARAMS = { caseId: CASE, version: RV1 };

/** Every row of every table: the "nothing written" check compares the whole store, not one register. */
function snapshot(w: World) {
  const tables = (w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, w.db.prepare(`SELECT * FROM "${t}"`).all()]));
}
const form = (fields: Record<string, string>) => { const body = new FormData(); Object.entries(fields).forEach(([k, v]) => body.set(k, v)); return body; };
const post = (locals: C.RequestServices, params: Record<string, string>, action: string, fields: Record<string, string>) =>
  ({ locals, params, url: new URL(`${ORIGIN}/`), request: new Request(`${ORIGIN}/?/${action}`, { method: 'POST', body: form(fields) }) }) as never;
const read = (locals: C.RequestServices, params: Record<string, string> = PARAMS) => ({ locals, params, url: new URL(`${ORIGIN}/`) }) as never;

/** The HTTP status an action or handler answered with: a returned failure, a thrown error or redirect, a Response, or 200. */
async function statusOf(run: () => unknown): Promise<number> {
  try {
    const value = await run();
    if (isActionFailure(value)) return value.status;
    if (value instanceof Response) return value.status;
    return 200;
  } catch (e) {
    if (isHttpError(e) || isRedirect(e)) return e.status;
    throw e;
  }
}
const deniedWrites = (w: World) => w.events.filter((e) => 'actor' in e && e.action === 'case.write-user-work' && e.outcome === 'denied');

/**
 * The refusal, then the control: a viewer's request answers 403, leaves every table as it was and adds the authorizer's
 * `denied` event for the viewer on this case; the editor's identical request is not refused and changes the store.
 */
async function refusesViewerThenEditorWrites(w: World, call: (locals: C.RequestServices) => unknown) {
  const before = snapshot(w), denials = deniedWrites(w).length;
  expect(await statusOf(() => call(w.viewer))).toBe(403);
  expect(snapshot(w)).toEqual(before);
  const added = deniedWrites(w).slice(denials);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ actor: { kind: 'verified', principal: { subject: 'viewer', kind: 'client' } }, object: { kind: 'case', caseId: CASE }, outcome: 'denied' });
  expect(await statusOf(() => call(w.editor))).not.toBe(403);
  expect(snapshot(w)).not.toEqual(before);
}

type Act = { actions: Record<string, ((e: never) => unknown) | undefined> };
/** One form action: the fields it is posted with, prepared (as the editor) where it needs an existing row. */
type FormCase = { action: string; params?: Record<string, string>; fields: (w: World) => Record<string, string> | Promise<Record<string, string>> };
const run = (mod: Act, c: FormCase, fields: Record<string, string>) => (locals: C.RequestServices) => mod.actions[c.action]!(post(locals, c.params ?? PARAMS, c.action, fields));

const REGISTERS: [string, Act & { load: (e: never) => unknown }, Record<string, string>][] = [
  ['annotations_tab', annotations, { ref: 'D-001', date: '2026-11-02', note: 'Synthetic annotation' }],
  ['deadlines_tab', deadlines, { title: 'Synthetic filing deadline', date: '2026-11-04', cat: 'Filing', note: 'Synthetic note' }],
  ['disbursements_tab', disbursements, { date: '2026-11-02', desc: 'Synthetic disbursement', payee: 'Synthetic payee', amount: '120.50' }],
  ['popia_tab', popia, { activity: 'Synthetic activity', category: 'Synthetic category', lawful: 'Synthetic basis', retention: 'Synthetic period' }],
  ['privilege_tab', privilege, { ref: 'D-001', date: '2026-11-02', desc: 'Synthetic withheld document', basis: 'Legal advice' }],
  ['timesheet_tab', timesheet, { date: '2026-11-02', fee_earner: 'Synthetic earner', activity: 'Synthetic activity', hours: '1.5', rate: '800', billed: 'no' }],
  ['transcriptions_tab', transcriptions, { title: 'Synthetic hearing', date: '2026-11-02', source: 'Synthetic recording', body: 'Synthetic transcript text' }],
];
/** The register's first row as its page shows it, after the editor saved one. */
async function savedRow(w: World, mod: Act & { load: (e: never) => unknown }, entry: Record<string, string>) {
  expect(await mod.actions.save!(post(w.editor, PARAMS, 'save', entry))).toMatchObject({ saved: true });
  return ((await mod.load(read(w.editor))) as { rows: { rowId: string; version: string }[] }).rows[0]!;
}
const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`;

const LITIGATION: [string, Act, FormCase[]][] = [
  ['litigation/authorities_tab', authorities, [
    { action: 'add', fields: () => ({ topic: 'Synthetic topic', authority: 'Synthetic v Synthetic', proposition: 'Synthetic proposition', addId: uuid(1) }) },
  ]],
  ['litigation/heads_tab', heads, [
    { action: 'add', fields: () => ({ head: 'Synthetic heading', sub: 'Synthetic submission', auth: 'Synthetic authority', ref: '', addId: uuid(2) }) },
    { action: 'delete', fields: async (w) => {
      await heads.actions.add!(post(w.editor, PARAMS, 'add', { head: 'Synthetic heading', sub: 'Synthetic submission', auth: '', ref: '', addId: uuid(3) }));
      const row = ((await heads.load!(read(w.editor))) as any).rows.find((r: { del?: string }) => r.del);
      return { rowId: row.del, confirm: row.del };
    } },
  ]],
  ['litigation/crossexam_tab', crossexam, [
    { action: 'add', fields: () => ({ witness: 'Synthetic witness', topic: 'Synthetic topic', put: 'Synthetic put', docs: '', addId: uuid(4) }) },
    { action: 'delete', fields: async (w) => {
      await crossexam.actions.add!(post(w.editor, PARAMS, 'add', { witness: 'Synthetic witness', topic: 'Synthetic topic', put: 'Synthetic put', docs: '', addId: uuid(5) }));
      const row = ((await crossexam.load!(read(w.editor))) as any).rows.find((r: { target: { rowId?: string } }) => r.target.rowId);
      return { rowId: row.del, confirm: row.del };
    } },
  ]],
  ['litigation/enforcement_tab', enforcement, [
    { action: 'status', fields: () => ({ stepKey: 'step-key-1', status: 'Done', version: 'none' }) },
  ]],
  ['quantum/payments_tab', payments, [
    { action: 'add', fields: () => ({ date: '2026-03-01', amount: '1500.50', method: 'Synthetic EFT', note: 'Synthetic note', operationId: uuid(6) }) },
    { action: 'delete', fields: async (w) => {
      await payments.actions.add!(post(w.editor, PARAMS, 'add', { date: '2026-03-02', amount: '10.00', method: 'Synthetic EFT', note: '', operationId: uuid(7) }));
      const p = ((await payments.load!(read(w.editor))) as any).payments[0];
      return { rowId: p.rowId, hash: p.hash };
    } },
  ]],
  ['evidence/filings_tab', filings, [
    { action: 'add', fields: () => ({ filing: 'Synthetic notice', fdate: '2026-02-01', fparty: 'Synthetic party', response: '', rdate: '', ref: '', operationId: uuid(8) }) },
    { action: 'save', fields: async (w) => {
      const entry = await filingRow(w, uuid(9));
      return { key: entry.key, version: rowVersion(entry.fields), filing: 'Synthetic notice, amended', fdate: '2026-02-01', fparty: 'Synthetic party', response: '', rdate: '', ref: '' };
    } },
    { action: 'delete', fields: async (w) => {
      const entry = await filingRow(w, uuid(10));
      const shown = ((await filings.load!(read(w.editor))) as any).deleteVersions[entry.key];
      return { delete: entry.key, confirm: entry.key, [`deleteVersion.${entry.key}`]: shown };
    } },
  ]],
  ['analysis/info_required_tab', infoRequired, [
    { action: 'toggle', fields: () => ({ key: 'info:one', done: 'true', version: 'none' }) },
  ]],
];
/** A filing row the editor added, as the filings page lists it. */
async function filingRow(w: World, addId: string): Promise<{ key: string; fields: Record<string, string> }> {
  await filings.actions.add!(post(w.editor, PARAMS, 'add', { filing: 'Synthetic notice', fdate: '2026-02-01', fparty: 'Synthetic party', response: '', rdate: '', ref: '', operationId: addId }));
  return ((await filings.load!(read(w.editor))) as any).entries.find((e: { key: string }) => e.key.startsWith('row:'));
}

const BUNDLES: [string, Act, FormCase[]][] = [
  ['bundles/caselines_tab', caselines, [
    { action: 'link', fields: () => ({ path: 'Synthetic/File-1.pdf' }) },
    { action: 'unlink', fields: async (w) => {
      await caselines.actions.link!(post(w.editor, PARAMS, 'link', { path: 'Synthetic/File-2.pdf' }));
      return { id: ((await caselines.load!(read(w.editor))) as any).links[0].rowId };
    } },
  ]],
  ['bundles/court_bundle_tab', courtBundle, [
    { action: 'header', fields: async (w) => ({ version: ((await courtBundle.load!(read(w.editor))) as any).headerHash, court: 'Synthetic Court' }) },
    { action: 'restore', fields: async (w) => ({ version: ((await courtBundle.load!(read(w.editor))) as any).headerHash, confirm: 'restore' }) },
    { action: 'clear', fields: async (w) => ({ version: ((await courtBundle.load!(read(w.editor))) as any).headerHash, confirm: 'clear' }) },
    { action: 'save', fields: () => ({ id: 'bundle-277', bundle: JSON.stringify({ name: 'Synthetic bundle', pages: 3, indexPages: 1, filePages: 2, note: '', rows: [] }) }) },
    { action: 'delete', fields: async (w) => {
      await courtBundle.actions.save!(post(w.editor, PARAMS, 'save', { id: 'bundle-del', bundle: JSON.stringify({ name: 'Synthetic bundle', pages: 1, indexPages: 1, filePages: 0, note: '', rows: [] }) }));
      return { id: 'bundle-del' };
    } },
  ]],
  ['bundles/discovery_tab', discovery, [
    { action: 'select', fields: () => ({ key: 'Synthetic/File-1.pdf', on: '1' }) },
    { action: 'co', fields: () => ({ key: 'Synthetic/File-1.pdf', val: 'C', base: '' }) },
    { action: 'mode', fields: () => ({ mode: 'supplementary' }) },
  ]],
];

const NOTES: [string, Act, FormCase[]][] = [
  ['notes (case notes)', notes, [
    { action: 'add', params: { caseId: CASE }, fields: () => ({ body: 'Synthetic case note', operationId: 'op-277-case-add' }) },
    { action: 'delete', params: { caseId: CASE }, fields: async (w) => {
      // a saved note redirects to the notes list
      expect(await statusOf(() => notes.actions.add!(post(w.editor, { caseId: CASE }, 'add', { body: 'Synthetic note to delete', operationId: 'op-277-case-seed' })))).toBe(303);
      const item = ((await notes.load(read(w.editor, { caseId: CASE }))) as any).notes.items[0];
      return { id: item.id, version: item.version, operationId: 'op-277-case-delete', confirm: item.id };
    } },
  ]],
  ['doc/[ref] (document notes)', doc, [
    { action: 'note', params: { ...PARAMS, ref: 'D-001' }, fields: () => ({ body: 'Synthetic document note', operationId: 'op-277-doc-add' }) },
    { action: 'delnote', params: { ...PARAMS, ref: 'D-001' }, fields: async (w) => {
      const saved = (await doc.actions.note!(post(w.editor, { ...PARAMS, ref: 'D-001' }, 'note', { body: 'Synthetic document note to delete', operationId: 'op-277-doc-seed' }))) as any;
      return { id: saved.note.id, version: saved.note.version, operationId: 'op-277-doc-delete', confirm: saved.note.id };
    } },
  ]],
];

const FORM_ROUTES = [
  ...REGISTERS.map(([name, mod]) => [`registers/${name}`, mod, ['save', 'delete']] as const),
  ...[...LITIGATION, ...BUNDLES, ...NOTES].map(([name, mod, cases]) => [name, mod, cases.map((c) => c.action)] as const),
];

describe('277 the inventory is complete', () => {
  it('every hosted case route that exports form actions is driven here, with every one of its actions', () => {
    const found: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = path.join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (name === '+page.server.ts' && /export const actions/.test(readFileSync(p, 'utf8'))) found.push(p); } };
    walk('deploy/client/routes/cases');
    expect(found).toHaveLength(FORM_ROUTES.length);
    for (const [name, mod, actions] of FORM_ROUTES) expect(Object.keys(mod.actions).sort(), name).toEqual([...actions].sort());
  });
  it('the user-work JSON endpoints under a case are the page-notes API and the assembled bundle upload, both driven here', () => {
    const found: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = path.join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (name === '+server.ts' && /export (async function|const) (POST|PUT|PATCH|DELETE)\b/.test(readFileSync(p, 'utf8'))) found.push(p.split(path.sep).join('/')); } };
    walk('deploy/client/routes/cases');
    // The chronology pane's POST reads an original's viewer model (read-original); it writes no user work.
    expect(found.sort()).toEqual([
      'deploy/client/routes/cases/[caseId]/originals/[assetId]/notes/+server.ts',
      'deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/assembled/+server.ts',
      'deploy/client/routes/cases/[caseId]/v/[version]/chronology/original/[ref]/+server.ts',
    ]);
  });
});

describe('277 a viewer is refused every register write', () => {
  for (const [name, mod, entry] of REGISTERS) {
    it(`registers/${name}: save is refused for a viewer and writes nothing`, async () => {
      const w = world();
      try { await refusesViewerThenEditorWrites(w, run(mod, { action: 'save', fields: () => entry }, entry)); } finally { w.db.close(); }
    });
    it(`registers/${name}: delete is refused for a viewer and writes nothing`, async () => {
      const w = world();
      try {
        const row = await savedRow(w, mod, entry);
        const fields = { delete: row.rowId, deleteVersion: row.version, confirm: row.rowId };
        await refusesViewerThenEditorWrites(w, run(mod, { action: 'delete', fields: () => fields }, fields));
      } finally { w.db.close(); }
    });
  }
});

for (const [title, group] of [['litigation, quantum, evidence and analysis', LITIGATION], ['bundle', BUNDLES], ['note', NOTES]] as const) {
  describe(`277 a viewer is refused every ${title} write`, () => {
    for (const [name, mod, cases] of group) for (const c of cases) {
      it(`${name}: ${c.action} is refused for a viewer and writes nothing`, async () => {
        const w = world();
        try { await refusesViewerThenEditorWrites(w, run(mod, c, await c.fields(w))); } finally { w.db.close(); }
      });
    }
  });
}

describe('277 a viewer is refused the user-work JSON endpoints', () => {
  const NOTES_PATH = `${ORIGIN}/cases/${CASE}/originals/D-001/notes`;
  const json = (locals: C.RequestServices, method: 'POST' | 'DELETE', body: unknown) => {
    const text = JSON.stringify(body);
    return { locals, params: { caseId: CASE, assetId: 'D-001' }, url: new URL(NOTES_PATH),
      request: new Request(NOTES_PATH, { method, headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': String(text.length) }, body: text }) } as never;
  };
  it('originals/[assetId]/notes: POST (add a page note) is refused for a viewer and writes nothing', async () => {
    const w = world();
    try { await refusesViewerThenEditorWrites(w, (locals) => pageNotes.POST(json(locals, 'POST', { page: 1, body: 'Synthetic page note', operationId: 'op-277-page-add' }))); } finally { w.db.close(); }
  });
  it('originals/[assetId]/notes: DELETE (remove a page note) is refused for a viewer and writes nothing', async () => {
    const w = world();
    try {
      const added = await (await pageNotes.POST(json(w.editor, 'POST', { page: 2, body: 'Synthetic page note to delete', operationId: 'op-277-page-seed' }))).json();
      await refusesViewerThenEditorWrites(w, (locals) => pageNotes.DELETE(json(locals, 'DELETE', { rowId: added.note.rowId, version: added.note.version, operationId: 'op-277-page-delete', confirm: added.note.rowId })));
    } finally { w.db.close(); }
  });
  it('court_bundle_tab/assembled: POST (store an assembled bundle PDF) is refused for a viewer before its body is read', async () => {
    const w = world();
    try {
      const upload = (locals: C.RequestServices) => {
        const request = new Request(`${ORIGIN}/cases/${CASE}/v/${RV1}/bundles/court_bundle_tab/assembled`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'content-length': '8' }, body: '%PDF-1.7' });
        return { request, call: () => assembled.POST({ locals, params: PARAMS, request, url: new URL(request.url) } as never) };
      };
      const before = snapshot(w), denials = deniedWrites(w).length;
      const viewer = upload(w.viewer);
      expect(await statusOf(viewer.call)).toBe(403);
      expect(viewer.request.bodyUsed).toBe(false);
      expect(snapshot(w)).toEqual(before);
      expect(deniedWrites(w).slice(denials)).toMatchObject([{ actor: { principal: { subject: 'viewer' } }, object: { caseId: CASE } }]);
      // The editor passes authorization and reaches the bundle checks (this request carries no bundle metadata: 400).
      expect(await statusOf(upload(w.editor).call)).toBe(400);
    } finally { w.db.close(); }
  });
});
