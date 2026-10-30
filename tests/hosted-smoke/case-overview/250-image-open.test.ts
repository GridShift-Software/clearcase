// GRS-250 follow-up: an image's Open button on the hosted document page goes to its viewer page, not the raw
// `originals/<assetId>` route, whose bytes a browser may download on navigation. Synthetic shard and links.
import { expect, it } from 'vitest';
import { load } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import type { RequestServices } from '../../../src/lib/server/runtime/contracts.ts';

const RV = `sha256:${'a'.repeat(64)}`, CASE = 'case-a', ASSET = 'asset-1';
const ORIGINAL = `/cases/${CASE}/originals/${ASSET}`, VIEWER = `${ORIGINAL}/view`;

async function open(mediaType: string, viewerHref: string | null) {
  const doc = { ref: 'D-001', source: 'results', fields: {}, state: { original: { sha256: 'b'.repeat(64) }, flags: [] }, attachments: [],
    assetIds: { own: ASSET }, mediaType, originalState: 'available' };
  const locals = {
    store: { publication: async () => ({ versionId: RV, shardManifestSha256: 'c'.repeat(64), shards: { 'doc/D-001.json': 100 } }) },
    shards: { read: async () => Response.json(doc) },
    assets: { links: async () => ({ originalHref: ORIGINAL, downloadHref: `${ORIGINAL}?download=1`, viewerHref }) },
    userWork: { notesFor: async () => [], readNoteWork: async () => ({ notes: [], rows: [] }) },
  } as unknown as RequestServices;
  const page = await load({ locals, params: { caseId: CASE, version: RV, ref: 'D-001' }, url: new URL('https://synthetic.invalid/') } as never);
  return page.links;
}

it('250 an image opens in its viewer page', async () => {
  expect(await open('image/png', VIEWER)).toEqual({ presentation: 'inline', open: VIEWER, download: `${ORIGINAL}?download=1`, viewer: VIEWER });
});

it('250 an image without a viewer page keeps the original route, and a PDF still opens the original', async () => {
  expect((await open('image/jpeg', null))).toMatchObject({ presentation: 'inline', open: ORIGINAL });
  expect((await open('application/pdf', VIEWER))).toMatchObject({ presentation: 'viewer', open: ORIGINAL, viewer: VIEWER });
});
