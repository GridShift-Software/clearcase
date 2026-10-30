import type { CaseId, RequestServices } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import { fastOriginals, registerFastOriginals } from '../viewer/hosted/fast-original.ts';
import type { requestCaseLookup } from './request-case.ts';
import { effective, permits } from './grants.ts';

/** Install the page snapshot without changing mutation, upload or operator adapters. */
export function bindPageReads(services: RequestServices, lookup: ReturnType<typeof requestCaseLookup>) {
  const read = async (caseId: CaseId, operation: 'read' | 'read-original' = 'read') => {
    await services.identity.authorize({ caseId, operation });
    if (services.identity.kind !== 'verified') throw contractError('unauthenticated');
    return lookup({ caseId, principal: services.identity.principal });
  };
  services.caseRead = async ({ caseId }) => { const value = await read(caseId); return { caseId, info: value.info, published: value.published }; };
  // The page's own read has already looked the case up for this person, so this is the memoized snapshot: no query.
  services.canWriteWork = async ({ caseId }) => {
    const who = services.identity;
    if (who.kind !== 'verified') return false;
    const { grants } = await lookup({ caseId, principal: who.principal });
    const now = new Date();
    return grants.some((g) => permits(g.role, 'write-user-work') && effective(g, { clientId: who.clientId, principal: who.principal, scope: { kind: 'case', caseId }, now }));
  };
  services.store = { ...services.store,
    getCase: async ({ caseId }) => (await read(caseId)).info,
    publication: async ({ caseId }) => (await read(caseId)).published,
    activeVersionId: async ({ caseId }) => (await read(caseId)).published?.versionId ?? null,
  };
  const legacy = services.userWork;
  services.userWork = { ...legacy, summary: async a => {
    const snapshot = await read(a.caseId);
    if (!snapshot.workBound) throw contractError('storage-unavailable');
    if (a.resultsVersion && snapshot.published?.versionId !== a.resultsVersion) throw contractError('forbidden');
    return legacy.summary(a);
  } };
  if (lookup.profile === 'overview') services.overviewNoteSummary = async ({ caseId, resultsVersion }) => {
    const snapshot = await read(caseId);
    if (!snapshot.workBound) throw contractError('storage-unavailable');
    if (snapshot.published?.versionId !== resultsVersion) throw contractError('forbidden');
    if (!snapshot.overviewNotes) throw contractError('storage-unavailable');
    return snapshot.overviewNotes;
  };
  const fast = fastOriginals(services.assets);
  if (fast) registerFastOriginals(services.assets, { ...fast, locate: async asset => {
    const snapshot = await read(asset.caseId, 'read-original');
    if (asset.kind !== 'original' || snapshot.original?.assetId !== asset.assetId) throw contractError('not-found');
    const original = snapshot.original;
    if (!original.etag || !original.mediaFamily) return fast.locate(asset);
    return { ...original, etag: original.etag, mediaFamily: original.mediaFamily };
  } });
}
