import type { AsyncRegisterStore, AsyncSeedStore, AsyncUserWork, CaseReader, ClientId, RequestServices, Runtime } from './contracts.ts';
import { contractError, rejectUnavailable } from './errors.ts';
const storage = rejectUnavailable('storage-unavailable');
const asset = rejectUnavailable('asset-unavailable');
const register: AsyncRegisterStore = { rows: storage, add: storage, replace: storage, remove: storage, apply: storage };
const seeds: AsyncSeedStore = { views: storage, remove: storage };
function unavailableStore(): CaseReader {
  return {
    listCases: storage, getCase: storage, getVersion: storage, versionsOf: storage, verifyVersion: storage,
    activeVersionId: storage, previousVersion: storage, trustedFor: storage, stateRevision: storage,
    packageFile: storage, packageFilePaths: storage, datasetOf: storage, datasetKeys: storage, viewContentOf: storage,
    seeds: storage, documentRows: storage, documentRow: storage, documentCounts: storage, existingRefs: storage,
    childDocuments: storage, fingerprints: storage, anyDateBasis: storage, listJson: storage, activeDocumentRows: storage, publication: storage,
    providers: { register: () => { throw contractError('storage-unavailable', true); }, list: () => { throw contractError('storage-unavailable', true); } },
  };
}
function unavailableWork(): AsyncUserWork {
  return {
    anchorFor: storage, resolve: storage, notesFor: storage, summary: storage, addNote: storage, deleteNote: storage,
    seedRows: storage, overlays: storage, seedViews: storage, putSeedOverlay: storage, listRows: storage, readViewWork: storage, readNoteWork: storage, putRow: storage,
    deleteRow: storage, tables: storage, defineTable: storage, registerStores: storage, listTableRows: storage,
    putTableRow: storage, putTableRows: storage, deleteTableRow: storage, exportAll: storage, importAll: storage,
    snapshots: { put: rejectUnavailable('snapshot-failed'), get: storage },
    registers: { open: () => register, seeds: () => seeds },
  };
}
export function createUnavailableServices(a: { clientId: ClientId; now: () => Date }): RequestServices {
  const runtime: Runtime = {
    get build(): never { throw contractError('invalid-build'); }, gate: null, testIdentity: null,
    now: () => new Date(a.now()), probe: rejectUnavailable('missing-binding'),
  };
  return {
    identity: { kind: 'anonymous', principal: null, sessionId: null, clientId: a.clientId, checkRevocation: rejectUnavailable('identity-unavailable'), authorize: rejectUnavailable('identity-unavailable') },
    store: unavailableStore(), assets: { originals: asset, availability: asset, metadata: asset, links: asset, get: asset },
    userWork: unavailableWork(), audit: { append: rejectUnavailable('audit-unavailable') }, runtime, shards: { read: storage },
  };
}
