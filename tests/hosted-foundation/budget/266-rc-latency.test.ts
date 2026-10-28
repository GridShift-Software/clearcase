// GRS-266: the three staging overruns of the RC journeys, over the real hostedServices composition (./266-world.ts).
import { expect, it } from 'vitest';
import { rcWorld, show } from './266-world.ts';
import { load as notesLoad } from '../../../deploy/client/routes/cases/[caseId]/notes/+page.server.ts';
import { load as courtLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/+page.server.ts';
import { load as discoveryLoad } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/discovery_tab/+page.server.ts';
import { POST as assembledPost } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/assembled/+server.ts';
import { bundleUploadHeaders } from '../../../src/lib/views/bundles/upload.ts';

const pdf = new TextEncoder().encode('%PDF-1.7\nsynthetic rc bundle\n%%EOF\n');
const bundle = { name: 'Synthetic RC bundle', pages: 3, indexPages: 1, filePages: 2, note: '', rows: [] };

it('266 measure', async () => {
  const w = await rcWorld();
  try {
    const params = { caseId: 'case-a', version: w.rv };
    const v = `/v/${encodeURIComponent(w.rv)}`;
    const notes = await w.timed('/notes', { method: 'GET' }, (locals, _r, url) => notesLoad({ locals, params, url } as never));
    expect(notes.thrown).toBeUndefined(); show('notes list', notes);
    const court = await w.timed(`${v}/bundles/court_bundle_tab`, { method: 'GET' }, (locals, _r, url) => courtLoad({ locals, params, url } as never));
    expect(court.thrown).toBeUndefined(); show('court load', court);
    const discovery = await w.timed(`${v}/bundles/discovery_tab`, { method: 'GET' }, (locals, _r, url) => discoveryLoad({ locals, params, url } as never));
    expect(discovery.thrown).toBeUndefined(); show('discovery load', discovery);
    const save = await w.timed(`${v}/bundles/court_bundle_tab/assembled`, { method: 'POST', body: pdf, headers: { ...bundleUploadHeaders('rc-bundle', bundle), 'content-length': String(pdf.byteLength) } },
      (locals, request, url) => assembledPost({ locals, params, request, url } as never));
    expect(save.thrown).toBeUndefined(); expect(save.value?.status).toBe(200); show('bundle save POST', save);
    const after = await w.timed(`${v}/bundles/court_bundle_tab`, { method: 'GET' }, (locals, _r, url) => courtLoad({ locals, params, url } as never));
    show('court load after save', after);
  } finally { await w.cleanup(); }
});
