import type { CaseId, HostedNote, HostedNoteSummary, RequestServices, Versioned } from '../server/runtime/contracts.ts';
import { contractError } from '../server/runtime/errors.ts';
import { id } from '../server/runtime/ids.ts';
import { sha256Hex } from '../audit/event.ts';
import { fastOriginals, registerFastOriginals } from '../viewer/hosted/fast-original.ts';
import type { requestCaseLookup } from './request-case.ts';

/** Install the page snapshot without changing mutation, upload or operator adapters. */
export function bindPageReads(services: RequestServices, lookup: ReturnType<typeof requestCaseLookup>) {
  const read = async (caseId: CaseId, operation: 'read' | 'read-original' = 'read') => {
    await services.identity.authorize({ caseId, operation });
    if (services.identity.kind !== 'verified') throw contractError('unauthenticated');
    return lookup({ caseId, principal: services.identity.principal });
  };
  services.caseRead = async ({ caseId }) => { const value = await read(caseId); return { caseId, info: value.info, published: value.published }; };
  services.store = { ...services.store,
    getCase: async ({ caseId }) => (await read(caseId)).info,
    publication: async ({ caseId }) => (await read(caseId)).published,
    activeVersionId: async ({ caseId }) => (await read(caseId)).published?.versionId ?? null,
  };
  const legacy = services.userWork;
  services.userWork = { ...legacy, summary: async ({ caseId, resultsVersion }) => {
    const snapshot = await read(caseId);
    if (!snapshot.workBound) throw contractError('storage-unavailable');
    if (resultsVersion && snapshot.published?.versionId !== resultsVersion) throw contractError('forbidden');
    const raw: (Omit<Versioned<HostedNote>, 'version' | 'intact' | 'status' | 'candidates'> & { version: string; bodySha256: string })[] = JSON.parse(snapshot.notesJson);
    const fingerprints: { ref: string; sha256: string | null }[] = JSON.parse(snapshot.fingerprintsJson);
    const result: HostedNoteSummary = { total: raw.length, here: 0, exact: 0, ambiguous: 0, missing: 0, unanchored: 0, byRef: [], detached: [] };
    for (const n of raw) {
      const { bodySha256, ...plain } = n;
      const note: Versioned<HostedNote> = { ...plain, version: id('row-version', n.version), intact: await sha256Hex(n.body) === bodySha256, status: 'here', candidates: [] };
      const target = note.target;
      let status: 'here' | 'exact' | 'ambiguous' | 'missing' | 'unanchored' = target.kind === 'case' ? 'here' : 'unanchored';
      let refs: string[] = [];
      if (target.kind === 'document' && resultsVersion) {
        if (target.anchor.resultsVersion === resultsVersion) { status = 'here'; refs = [target.anchor.refAtCreation]; }
        else if (target.anchor.sha256) {
          refs = fingerprints.filter(f => f.sha256 === target.anchor.sha256).map(f => f.ref).sort();
          status = refs.length === 0 ? 'missing' : refs.length === 1 ? 'exact' : 'ambiguous';
        }
      }
      result[status]++;
      for (const ref of refs) { const old = result.byRef.find(r => r.ref === ref); if (old) old.n++; else result.byRef.push({ ref, n: 1, status }); }
      if (!refs.length && target.kind !== 'case') { const { version: _, ...detached } = note; result.detached.push({ ...detached, status, candidates: refs }); }
    }
    return result;
  } };
  const fast = fastOriginals(services.assets);
  if (fast) registerFastOriginals(services.assets, { ...fast, locate: async asset => {
    const snapshot = await read(asset.caseId, 'read-original');
    if (asset.kind !== 'original' || snapshot.original?.assetId !== asset.assetId) throw contractError('not-found');
    return snapshot.original;
  } });
}
