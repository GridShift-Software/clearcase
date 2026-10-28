// Ticket 17a: the seven registers over the hosted user-work adapter, on the synthetic SQLite/D1 double. Not evidence of
// Cloudflare D1 or of a deployed save time; every case, ref and value is invented.
import { describe, expect, it } from 'vitest';
import { actions as deadlineActions } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/deadlines_tab/+page.server.ts';
import { load as privilegeLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/registers/privilege_tab/+page.server.ts';
import { hostedRegisterActions, hostedRegisterLoad } from '../../../src/lib/views/registers/hosted.server.ts';
import { REGISTER_VIEWS, REGISTERS, type RegisterView } from '../../../src/lib/views/registers/defs.ts';
import { deadlineCalendar } from '../../../src/lib/views/registers/logic.ts';
import { GONE, STALE, STALE_DELETE } from '../../../src/lib/views/registers/shown.ts';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { CASE, RV1, fixture } from './helpers.ts';

const NOW = new Date('2026-11-01T10:00:00Z');

function world(subject = 'editor') {
  const f = fixture();
  if (subject !== 'editor') f.auth.grant(subject, CASE, 'viewer');
  const userWork = f.make(subject);
  const locals = {
    userWork, runtime: { now: () => NOW },
    store: { publication: async () => ({ versionId: RV1, publishedAt: null, previousVersionId: null, shardManifestSha256: 'a'.repeat(64), shards: { 'doc/D-001.json': 100 } }) },
  } as unknown as C.RequestServices;
  const params = { caseId: CASE, version: RV1 };
  const post = (name: string, view: RegisterView, fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const actions = hostedRegisterActions(view) as Record<string, (e: never) => Promise<unknown>>;
    return actions[name]!({ locals, params, request: new Request(`https://synthetic.invalid/?/${name}`, { method: 'POST', body: form }) } as never) as Promise<any>;
  };
  const list = (view: RegisterView) => hostedRegisterLoad(view)({ locals, params } as never);
  return { ...f, locals, params, post, list };
}
const deadline = { title: 'Synthetic filing deadline', date: '2026-11-04', cat: 'Filing', note: 'Synthetic note' };

describe('17a hosted registers: deadlines', () => {
  it('adds a deadline, lists it with its exact title and a countdown, and the calendar carries its title and date', async () => {
    const w = world();
    try {
      expect(await w.post('save', 'deadlines_tab', deadline)).toMatchObject({ saved: true });
      const page = await w.list('deadlines_tab');
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({ values: deadline, intact: true });
      expect(page.rows[0].cells.map((c: { text: string }) => c.text)).toEqual(['2026-11-04', 'in 3d', 'Synthetic filing deadline', 'Filing', 'Synthetic note']);
      const ics = deadlineCalendar(page.exportRows, { now: NOW, productId: page.icsProductId }).replace(/\r\n /g, '');
      expect(ics).toContain('SUMMARY:Synthetic filing deadline');
      expect(ics).toContain('DTSTART:20261104T090000');
    } finally { w.db.close(); }
  });

  it('lists deadlines by date and runs through the route files, which only bind the view', async () => {
    const w = world();
    try {
      const form = (d: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(d)) f.set(k, v); return f; };
      for (const d of [{ ...deadline, title: 'Later', date: '2026-12-01' }, { ...deadline, title: 'Sooner', date: '2026-11-02' }])
        await (deadlineActions.save as (e: never) => Promise<unknown>)({ locals: w.locals, params: w.params, request: new Request('https://synthetic.invalid/?/save', { method: 'POST', body: form(d) }) } as never);
      expect((await w.list('deadlines_tab')).rows.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Sooner', 'Later']);
    } finally { w.db.close(); }
  });

  it('edits with the version it was shown; a stale edit answers the local conflict message and changes nothing', async () => {
    const w = world();
    try {
      await w.post('save', 'deadlines_tab', deadline);
      const shown = (await w.list('deadlines_tab')).rows[0];
      expect(await w.post('save', 'deadlines_tab', { ...deadline, title: 'Edited once', rowId: shown.rowId, version: shown.version })).toMatchObject({ saved: true });
      const stale = await w.post('save', 'deadlines_tab', { ...deadline, title: 'Edited from a stale page', rowId: shown.rowId, version: shown.version });
      expect(stale).toMatchObject({ status: 409, data: { op: 'save', message: STALE, rowId: shown.rowId, values: { title: 'Edited from a stale page' } } });
      expect((await w.list('deadlines_tab')).rows.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Edited once']);
    } finally { w.db.close(); }
  });

  it('an edit without its version is refused as changed elsewhere, never written', async () => {
    const w = world();
    try {
      await w.post('save', 'deadlines_tab', deadline);
      const shown = (await w.list('deadlines_tab')).rows[0];
      expect(await w.post('save', 'deadlines_tab', { ...deadline, title: 'No version', rowId: shown.rowId })).toMatchObject({ status: 409, data: { message: STALE } });
      expect((await w.list('deadlines_tab')).rows[0].values.title).toBe(deadline.title);
    } finally { w.db.close(); }
  });

  it('an edit of a row deleted elsewhere answers the deleted message with 404', async () => {
    const w = world();
    try {
      await w.post('save', 'deadlines_tab', deadline);
      const shown = (await w.list('deadlines_tab')).rows[0];
      await w.post('delete', 'deadlines_tab', { delete: shown.rowId, deleteVersion: shown.version, confirm: shown.rowId });
      expect(await w.post('save', 'deadlines_tab', { ...deadline, rowId: shown.rowId, version: shown.version })).toMatchObject({ status: 404, data: { message: GONE } });
    } finally { w.db.close(); }
  });

  it('two saves with the same operation id make one deadline', async () => {
    const w = world();
    try {
      await w.post('save', 'deadlines_tab', { ...deadline, operationId: 'retry-after-lost-answer' });
      await w.post('save', 'deadlines_tab', { ...deadline, operationId: 'retry-after-lost-answer' });
      expect((await w.list('deadlines_tab')).rows).toHaveLength(1);
      expect(w.db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 1 });
    } finally { w.db.close(); }
  });

  it('a save with nothing in it is skipped, and a missing title or date is refused with the entry kept', async () => {
    const w = world();
    try {
      expect(await w.post('save', 'deadlines_tab', { title: '', date: '', cat: 'Filing', note: '' })).toEqual({ saved: false });
      expect(await w.post('save', 'deadlines_tab', { title: 'Only a title', date: '', cat: 'Filing', note: '' })).toMatchObject({ status: 400, data: { values: { title: 'Only a title' } } });
      expect((await w.list('deadlines_tab')).rows).toEqual([]);
    } finally { w.db.close(); }
  });

  describe('delete', () => {
    it('asks for the confirmation first and deletes nothing until it is given', async () => {
      const w = world();
      try {
        await w.post('save', 'deadlines_tab', deadline);
        const shown = (await w.list('deadlines_tab')).rows[0];
        expect(await w.post('delete', 'deadlines_tab', { delete: shown.rowId, deleteVersion: shown.version })).toMatchObject({ status: 400, data: { confirm: shown.rowId } });
        expect((await w.list('deadlines_tab')).rows).toHaveLength(1);
        expect(await w.post('delete', 'deadlines_tab', { delete: shown.rowId, deleteVersion: shown.version, confirm: shown.rowId })).toMatchObject({ op: 'delete', deleted: true });
        expect((await w.list('deadlines_tab')).rows).toEqual([]);
      } finally { w.db.close(); }
    });

    it('a delete with a stale version answers the changed-elsewhere message and keeps the row', async () => {
      const w = world();
      try {
        await w.post('save', 'deadlines_tab', deadline);
        const shown = (await w.list('deadlines_tab')).rows[0];
        await w.post('save', 'deadlines_tab', { ...deadline, title: 'Changed in another tab', rowId: shown.rowId, version: shown.version });
        const refused = await w.post('delete', 'deadlines_tab', { delete: shown.rowId, deleteVersion: shown.version, confirm: shown.rowId });
        expect(refused).toMatchObject({ status: 409, data: { op: 'delete', rowId: shown.rowId, message: STALE_DELETE } });
        expect((await w.list('deadlines_tab')).rows.map((r: { values: { title: string } }) => r.values.title)).toEqual(['Changed in another tab']);
      } finally { w.db.close(); }
    });

    it('a post without a version deletes the row as it is now; a row already gone is deleted:false, as locally', async () => {
      const w = world();
      try {
        await w.post('save', 'deadlines_tab', deadline);
        const shown = (await w.list('deadlines_tab')).rows[0];
        const gone = { delete: shown.rowId, confirm: shown.rowId };
        expect(await w.post('delete', 'deadlines_tab', gone)).toMatchObject({ deleted: true });
        expect(await w.post('delete', 'deadlines_tab', gone)).toMatchObject({ deleted: false });
        expect(await w.post('delete', 'deadlines_tab', { delete: shown.rowId, deleteVersion: shown.version, confirm: shown.rowId })).toMatchObject({ deleted: false });
      } finally { w.db.close(); }
    });
  });

  it('a viewer reads the register but cannot save or delete', async () => {
    const w = world('viewer');
    try {
      expect((await w.list('deadlines_tab')).rows).toEqual([]);
      await expect(w.post('save', 'deadlines_tab', deadline)).rejects.toMatchObject({ status: 403 });
    } finally { w.db.close(); }
  });
});

describe('17a hosted registers: the other six', () => {
  const synthetic: Record<string, Record<string, string>> = {
    timesheet_tab: { date: '2026-11-02', fee_earner: 'Synthetic Earner', activity: 'Synthetic drafting', hours: '1.5', rate: '1000', billed: 'no' },
    disbursements_tab: { date: '2026-11-02', desc: 'Synthetic courier', payee: 'Synthetic Payee', amount: '250.00' },
    privilege_tab: { ref: 'D-001', date: '2026-11-02', desc: 'Synthetic advice', basis: 'Legal advice' },
    popia_tab: { activity: 'Synthetic processing', category: 'Synthetic category', lawful: 'Consent', retention: '5 years' },
    annotations_tab: { ref: 'D-001', date: '2026-11-02', note: 'Synthetic annotation\nover two lines' },
    transcriptions_tab: { title: 'Synthetic hearing', date: '2026-11-02', source: 'Synthetic recording', body: 'Synthetic transcript text' },
  };
  it.each(Object.entries(synthetic))('%s saves one row and lists it', async (view, fields) => {
    const w = world();
    try {
      expect(await w.post('save', view as RegisterView, fields)).toMatchObject({ saved: true });
      const page = await w.list(view as RegisterView);
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0].values).toEqual(fields);
      expect(page.register.view).toBe(view);
      // the other registers of the case are not touched
      for (const other of REGISTER_VIEWS.filter((v) => v !== view)) expect((await w.list(other)).rows).toEqual([]);
    } finally { w.db.close(); }
  });

  it('covers every register the hosted app lists', () => {
    expect(Object.keys(synthetic).sort()).toEqual(REGISTER_VIEWS.filter((v) => v !== 'deadlines_tab').sort());
    expect(REGISTER_VIEWS.map((v) => REGISTERS[v].store).sort()).toEqual(['annotations', 'deadlines', 'disbursements', 'popia', 'privilege', 'timesheet', 'transcripts']);
  });

  it('an entry with an invalid amount is refused with the entry kept', async () => {
    const w = world();
    try {
      expect(await w.post('save', 'timesheet_tab', { ...synthetic.timesheet_tab!, hours: 'lots' })).toMatchObject({ status: 400, data: { values: { hours: 'lots' } } });
    } finally { w.db.close(); }
  });
});

describe('17a hosted registers: documents refs', () => {
  it('anchors a ref the publication holds, links it, and leaves an unknown ref as text', async () => {
    const w = world();
    try {
      await w.post('save', 'privilege_tab', { ref: 'D-001', date: '2026-11-02', desc: 'Held', basis: 'Litigation' });
      await w.post('save', 'privilege_tab', { ref: 'D-404', date: '2026-11-02', desc: 'Unknown', basis: 'Litigation' });
      const rows = (await privilegeLoad({ locals: w.locals, params: w.params } as never) as { rows: { values: { ref: string }; cells: { kind: string; target?: string | null }[] }[] }).rows;
      // the fixture's clock is fixed, so both rows share a creation time: compare by ref, not by list order
      expect(rows.map((r) => [r.values.ref, r.cells[0]]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([['D-001', { kind: 'ref', text: 'D-001', target: 'D-001' }], ['D-404', { kind: 'ref', text: 'D-404', target: null }]]);
      const stored = w.db.prepare("SELECT anchor_json FROM uw_register_row ORDER BY json_extract(fields_json, '$.ref')").all() as { anchor_json: string | null }[];
      expect(JSON.parse(stored[0]!.anchor_json!)).toMatchObject({ refAtCreation: 'D-001', resultsVersion: RV1 });
      expect(stored[1]!.anchor_json).toBeNull();
    } finally { w.db.close(); }
  });

  it('editing an entry whose ref is unchanged keeps it anchored', async () => {
    const w = world();
    try {
      await w.post('save', 'annotations_tab', { ref: 'D-001', date: '2026-11-02', note: 'First' });
      const shown = (await w.list('annotations_tab')).rows[0];
      expect(await w.post('save', 'annotations_tab', { ref: 'D-001', date: '2026-11-02', note: 'Second', rowId: shown.rowId, version: shown.version })).toMatchObject({ saved: true });
      const row = w.db.prepare('SELECT anchor_json, fields_json FROM uw_register_row').get() as { anchor_json: string; fields_json: string };
      expect(JSON.parse(row.anchor_json)).toMatchObject({ refAtCreation: 'D-001' });
      expect(JSON.parse(row.fields_json)).toMatchObject({ note: 'Second' });
    } finally { w.db.close(); }
  });
});
