// GRS-277: under the hosted case layout a viewer's pages render no Add, Edit, Delete, Save or Build control, an editor's
// render them all, and the local pilot (no hosted layout) keeps them. Server renders over synthetic data only; the
// refusal of the writes themselves is tests/hosted-foundation/user-work/277-viewer-refused.test.ts.
import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), beforeNavigate: () => {}, afterNavigate: () => {}, invalidateAll: () => Promise.resolve() }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }), applyAction: async () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://synthetic.invalid/cases/c/v/x/registers/deadlines_tab'), route: { id: null }, params: {} } }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
import WithAccess from './WithAccess.svelte';
import RegisterPage from '../../../src/lib/views/registers/RegisterPage.svelte';
import { REGISTERS } from '../../../src/lib/views/registers/defs';
import { registerHead, type ShownRow } from '../../../src/lib/views/registers/shown';
import HeadsPage from '../../../src/routes/v/[vid]/litigation/heads_tab/+page.svelte';
import DocPage from '../../../src/routes/v/[vid]/doc/[ref]/+page.svelte';
import CourtBundlePage from '../../../src/routes/v/[vid]/bundles/court_bundle_tab/+page.svelte';
import NotesPage from '../../../deploy/client/routes/cases/[caseId]/notes/+page.svelte';
import * as courtBundle from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/+page.server.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { CASE, RV1, fixture } from '../../hosted-foundation/user-work/helpers.ts';

type Access = 'viewer' | 'editor' | 'local';
const ACCESS: Access[] = ['viewer', 'editor', 'local'];
/** The page as the hosted layout renders it for a viewer or an editor, or as the local pilot renders it (no hosted layout). */
const html = (page: unknown, props: Record<string, unknown>, access: Access) =>
  access === 'local' ? render(page as never, { props } as never).body : render(WithAccess, { props: { canWrite: access === 'editor', page: page as never, props } }).body;
const VERSION = { id: RV1, titleName: 'Synthetic matter' };

describe('277 registers', () => {
  const row: ShownRow = { rowId: 'row-1', values: { title: 'Synthetic deadline', date: '2026-11-04', cat: 'Filing', note: '' }, cells: ['2026-11-04', 'in 3d', 'Synthetic deadline', 'Filing', ''].map((text) => ({ kind: 'text' as const, text })), version: 'v1', intact: true };
  const props = { form: null, data: { version: VERSION, register: registerHead('deadlines_tab', REGISTERS.deadlines_tab), rows: [row], exportRows: [], exportName: { name: 'deadlines.ics', note: null }, icsProductId: null } };
  for (const access of ACCESS) {
    it(`deadlines for ${access === 'local' ? 'the local pilot' : `a hosted ${access}`}: Add, Edit and Delete ${access === 'viewer' ? 'are hidden' : 'are shown'}, and the export stays`, () => {
      const body = html(RegisterPage, props, access), writes = access !== 'viewer';
      expect(body).toContain('id="register-export"');
      expect(body).toContain('Synthetic deadline');
      for (const control of ['id="register-save"', 'id="register-form"', 'data-edit', 'data-delete']) expect(body.includes(control), control).toBe(writes);
    });
  }
});

describe('277 litigation entry pages', () => {
  const props = { form: null, data: { version: VERSION, rows: [{ rowId: 'h-1', del: 'h-1 v1', head: 'Synthetic heading', sub: 'Synthetic submission', auth: '', evidence: [] }], caption: null, exportName: { name: 'heads.txt', note: null }, addId: 'add-1', known: [] } };
  for (const access of ACCESS) {
    it(`heads of argument for ${access}: the add form and each row's Delete ${access === 'viewer' ? 'are hidden' : 'are shown'}`, () => {
      const body = html(HeadsPage, props, access), writes = access !== 'viewer';
      expect(body).toContain('Synthetic heading');
      expect(body.includes('id="hd-add"')).toBe(writes);
      expect(body.includes('data-delete')).toBe(writes);
    });
  }
  it('the hosted note says rows are saved on the server; the local one keeps "kept on this computer"', () => {
    expect(html(HeadsPage, props, 'editor')).toContain('saved on the server');
    expect(html(HeadsPage, props, 'editor')).not.toContain('kept on this computer');
    expect(html(HeadsPage, props, 'local')).toContain('kept on this computer');
  });
});

describe('277 notes', () => {
  const doc = {
    ref: 'D-001', source: 'results', version: VERSION,
    fields: { date: '', dateType: null, dateSource: null, subject: 'Synthetic document', filename: 'synthetic.pdf', docType: '', bundle: '', sender: '', to: '', cc: '', amount: '', invoiceNo: '', size: null, textStatus: '', alsoIn: [], attachmentNames: [], excerpt: '' },
    state: { file: 'missing', original: null, self: null, flags: [] }, links: { presentation: null, open: null, download: null, viewer: null }, onDisk: null, page: null,
    attachments: [], children: [], related: [], parent: null, operationId: 'op-1', base: '/cases/synthetic/v',
    notes: [{ id: 'n-1', body: 'Synthetic note body', createdAt: '2026-11-01', status: 'here', refAtCreation: 'D-001', candidates: [], intact: true, version: 'v1' }],
  };
  for (const access of ACCESS) {
    it(`the document page for ${access}: the note list stays, Add note and Delete ${access === 'viewer' ? 'are hidden' : 'are shown'}`, () => {
      const body = html(DocPage, { data: doc, form: null }, access), writes = access !== 'viewer';
      expect(body).toContain('Synthetic note body');
      expect(body.includes('id="note-form"')).toBe(writes);
      expect(body.includes('action="?/delnote"')).toBe(writes);
      expect(body).not.toContain('id="note-unavailable"');
    });
  }
  for (const canWrite of [false, true]) {
    it(`the case notes page ${canWrite ? 'for an editor shows' : 'for a viewer hides'} the add and delete forms`, () => {
      const data = { caseId: CASE, label: 'Synthetic case', caseHref: '/cases/c', chronologyHref: null, resultsVersion: null, notes: { state: 'available', items: [{ id: 'n-1', version: 'v1', body: 'Synthetic case note', createdAt: '2026-11-01', target: { kind: 'case' } }] }, operationId: 'op-1', saved: false, deleted: false, canWrite };
      const body = render(NotesPage, { props: { data, form: null } as never }).body;
      expect(body).toContain('Synthetic case note');
      expect(body).toContain('saved on the server');
      expect(body.includes('id="note-form"')).toBe(canWrite);
      expect(body.includes('data-action="delete-note"')).toBe(canWrite);
    });
  }
});

describe('277 court bundle', () => {
  /** The hosted route's own load over the synthetic user-work double, with one saved custom bundle. */
  async function data() {
    const f = fixture();
    f.db.exec(readFileSync('src/lib/user-work/hosted/migrations/0002_bundle_tables.sql', 'utf8'));
    const shard = { pathShard: { paths: {} }, bundles: [], links: [], header: {}, present: true, content: { examples: {} } };
    const bytes = new TextEncoder().encode(JSON.stringify(shard)).byteLength;
    const locals = {
      userWork: f.make(), identity: f.auth.identity(), runtime: { now: () => new Date('2026-11-01T10:00:00Z') },
      store: { publication: async () => ({ versionId: RV1, publishedAt: null, previousVersionId: null, shardManifestSha256: 'a'.repeat(64), shards: { 'view/court_bundle_tab.json': bytes } }) },
      shards: { read: async () => Response.json(shard) },
    } as unknown as C.RequestServices;
    const event = (fields?: Record<string, string>) => {
      const body = new FormData(); Object.entries(fields ?? {}).forEach(([k, v]) => body.set(k, v));
      return { locals, params: { caseId: CASE, version: RV1 }, url: new URL('https://synthetic.invalid/'), request: new Request('https://synthetic.invalid/?/save', { method: 'POST', body }) } as never;
    };
    await courtBundle.actions.save!(event({ id: 'custom-1', bundle: JSON.stringify({ name: 'Synthetic custom bundle', pages: 1, indexPages: 1, filePages: 0, note: '', rows: [] }) }));
    try { return { ...((await courtBundle.load!(event())) as object), version: VERSION }; } finally { f.db.close(); }
  }
  for (const access of ACCESS) {
    it(`for ${access}: Build, the header editor and a custom bundle's Delete ${access === 'viewer' ? 'are hidden' : 'are shown'}; the list and Word exports stay`, async () => {
      const body = html(CourtBundlePage, { data: await data() }, access), writes = access !== 'viewer';
      expect(body).toContain('Synthetic custom bundle');
      expect(body).toContain('id="cb-word-all"');
      for (const control of ['id="cb-build"', 'id="cb-header"', 'id="cb-save"', 'data-delete=']) expect(body.includes(control), control).toBe(writes);
    });
  }
});
