// GRS-266: the three staging overruns of the RC journeys (J7 case-notes-list, J9 bundle-save, J1 discovery), over the
// real hostedServices composition (./266-world.ts). Counts include the deferred read-audit insert. `sequential` is the
// elapsed time over a fixed per-call D1 delay, with an R2 put held as long as six D1 calls: the round trips on the
// critical path, rounded, so its ceiling keeps one of slack. Before GRS-266 (base 68480080 sources): notes list 35 D1
// (about 29 sequential), each bundle page 7 (4), bundle save 20 in 2 batches (22).
import { expect, it } from 'vitest';
import { rcWorld, show, type RcWorld } from './266-world.ts';
import { load as notesLoad } from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import { load as courtLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/+page.server.ts';
import { load as discoveryLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/discovery_tab/+page.server.ts';
import { POST as assembledPost } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/assembled/+server.ts';
import { bundleUploadHeaders } from '../../../src/lib/views/bundles/upload.ts';

const pdf = new TextEncoder().encode('%PDF-1.7\nsynthetic rc bundle\n%%EOF\n');
const bundle = { name: 'Synthetic RC bundle', pages: 3, indexPages: 1, filePages: 2, note: '', rows: [] };
const params = (w: RcWorld) => ({ caseId: 'case-a', version: w.rv });
const version = (w: RcWorld) => `/v/${encodeURIComponent(w.rv)}`;
const save = (id: string) => ({ method: 'POST', body: pdf, headers: { ...bundleUploadHeaders(id, bundle), 'content-length': String(pdf.byteLength) } });

it('266 the case notes list reads through the one lookup: 3 D1 calls, 2 on the critical path', async () => {
  const w = await rcWorld();
  try {
    const r = await w.timed('/notes', { method: 'GET' }, (locals, _r, url) => notesLoad({ locals, params: params(w), url } as never));
    expect(r.thrown).toBeUndefined(); show('notes list', r);
    expect(r.value?.notes.state).toBe('available');
    expect(r.counts).toMatchObject({ d1: 3, clerk: 0, otherFetch: 0 }); expect(r.sequential).toBeLessThanOrEqual(3);
  } finally { await w.cleanup(); }
});

it('266 the Court Bundle and Discovery pages each read their work in one query per table: 4 D1 calls, 2 sequential', async () => {
  const w = await rcWorld();
  try {
    for (const [label, load, path] of [['court load', courtLoad, 'court_bundle_tab'], ['discovery load', discoveryLoad, 'discovery_tab']] as const) {
      const r = await w.timed(`${version(w)}/bundles/${path}`, { method: 'GET' }, (locals, _r, url) => load({ locals, params: params(w), url } as never));
      expect(r.thrown).toBeUndefined(); show(label, r);
      expect(r.counts).toMatchObject({ d1: 4, r2: 1, clerk: 0, otherFetch: 0 }); expect(r.sequential).toBeLessThanOrEqual(3);
    }
  } finally { await w.cleanup(); }
});

it('266 a bundle save is one batch, its audit included, and its row work runs beside the PDF write', async () => {
  const w = await rcWorld();
  try {
    const r = await w.timed(`${version(w)}/bundles/court_bundle_tab/assembled`, save('rc-bundle'), (locals, request, url) => assembledPost({ locals, params: params(w), request, url } as never));
    expect(r.thrown).toBeUndefined(); expect(r.value?.status).toBe(200); show('bundle save POST', r);
    expect(r.counts).toMatchObject({ d1: 15, clerk: 0, otherFetch: 0 }); expect(r.batches).toBe(1);
    // Serial, the held put would add its six round trips to the row's: 17 or more.
    expect(r.sequential).toBeLessThanOrEqual(13);
    expect(w.db.rows<{ action: string }>("SELECT action FROM native_audit_events WHERE action = 'user-work.table-row-put'")).toHaveLength(1);
    expect(w.db.rows('SELECT audited_at FROM uw_operation WHERE audited_at IS NULL')).toEqual([]);
  } finally { await w.cleanup(); }
});

it('266 a bundle row commits only after its PDF is stored, with every other D1 call made while the PDF is in flight', async () => {
  const w = await rcWorld();
  try {
    const hold = w.holdPut(), before = w.batches();
    const saving = w.request(`${version(w)}/bundles/court_bundle_tab/assembled`, save('rc-held'), (locals, request, url) => assembledPost({ locals, params: params(w), request, url } as never));
    await hold.reached;
    await new Promise(r => setTimeout(r, 50));
    // Authorization, the table read, the write authorization and the preflight reads are done; nothing is committed.
    expect(w.counters.d1).toBe(14); expect(w.batches() - before).toBe(0);
    expect(w.db.rows("SELECT row_key FROM uw_table_row WHERE table_name = 'bundles_custom'")).toEqual([]);
    hold.release();
    const r = await saving;
    expect(r.value?.status).toBe(200); expect(r.counts.d1).toBe(15); expect(w.batches() - before).toBe(1);
    expect(w.db.rows("SELECT row_key FROM uw_table_row WHERE table_name = 'bundles_custom'")).toHaveLength(1);
  } finally { await w.cleanup(); }
});
