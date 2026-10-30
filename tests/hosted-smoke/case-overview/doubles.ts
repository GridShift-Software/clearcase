// UNIT TEST DOUBLES ONLY. A scripted RequestServices for the hosted case overview, chronology and notes routes: every
// call is recorded in order, and each port answers from the synthetic case below. These are not the hosted-gate doubles,
// not D1, R2 or workerd and not the GRS-117/118 adapters, so nothing here is evidence of a real storage or identity
// boundary. No production path can reach them.
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id, resultsVersion } from '../../../src/lib/server/runtime/ids.ts';

export const RV = resultsVersion(`sha256:${'a'.repeat(64)}`);
export const OLD_RV = resultsVersion(`sha256:${'b'.repeat(64)}`);
export const CASE = id('case', 'case-a1');
const HOSTILE = '<img src=x onerror=alert(1)>';

export type Publication = C.Publication;
export interface Script {
  publication: Publication;
  active?: C.ResultsVersion | null;
  verify?: C.Verification;
  /** a code thrown by the named ports, e.g. storage-unavailable or forbidden */
  fail?: Partial<Record<'getCase' | 'store' | 'originals' | 'notesFor' | 'addNote' | 'deleteNote', string>>;
  /** getCase answers null: the case does not exist for this client */
  missingCase?: boolean;
}

export const listRow = (ref: string, ord: number, over: Partial<C.DocumentRow['list']> = {}): C.DocumentRow['list'] => ({
  ref, ord, date: `2024-01-0${ord}`, dateType: null, dateSource: null, docType: 'letter', bundle: 'B1', subject: `Subject ${ref}`, filename: `${ref}.pdf`, sender: 'Sender', to: 'To', excerpt: '', amount: '', alsoIn: [], url: '', textStatus: 'extracted', parentRef: null, file: 'present', preview: 'inline-isolated', attachments: 0, ...over,
});

export const ROWS = [
  listRow('DOC-001', 1, { subject: `Letter ${HOSTILE}`, filename: `${HOSTILE}.pdf` }),
  listRow('DOC-002', 2, { docType: 'invoice', subject: 'Invoice for repairs', amount: '120.00' }),
  listRow('DOC-003', 3, { subject: 'Email about the roof', textStatus: 'none', file: 'missing' }),
];

export const OVERVIEW = {
  caseId: CASE, caseLabel: 'Synthetic matter', resultsVersion: RV, inputRevisionId: 'rev-1', inputKind: 'folder', created: '2026-10-01T00:00:00Z', producer: 'synthetic',
  counts: { documents: 3, byBundle: { B1: 3, ['__proto__']: 1 }, byTextStatus: { extracted: 2, none: 1 }, byDocType: { letter: 2, invoice: 1 }, emails: 0, invoices: 1, people: null, attachments: 0 },
  dates: { min: '2024-01-01', max: '2024-01-03', undated: 0 },
  originals: { verified: 2, caseMismatch: 0, missing: 1, embedded: 0, downloadOnly: 0 },
  sourceClaims: {}, diagnostics: {}, matter: { title: `Matter ${HOSTILE}`, short: '', forum: '', storyline: [], strategy: [] }, quantum: null, contradictions: null,
};

const viewContent = (subtitle: string): C.ViewContentReader => ({
  views: () => ['overview'], fields: () => ['subtitle'], value: () => null, text: () => null, number: () => null, list: () => null, params: () => [],
  fill: (view, field, params = {}) => (view === 'overview' && field === 'subtitle' ? { text: subtitle.replace('{docCount}', String(params.docCount)), missing: [] } : null),
});

export interface Fake { services: C.RequestServices; calls: string[]; notes: Map<string, C.Versioned<C.HostedNote>>; rows: C.Versioned<C.WorkRegisterRow>[]; writes: unknown[] }

export function fake(script: Script): Fake {
  const calls: string[] = [], writes: unknown[] = [];
  const notes = new Map<string, C.Versioned<C.HostedNote>>();
  const rows: C.Versioned<C.WorkRegisterRow>[] = [];
  let n = 0;
  const fail = (port: keyof NonNullable<Script['fail']>) => { const code = script.fail?.[port]; if (code) throw contractError(code, code === 'storage-unavailable'); };
  const rec = (name: string, a?: unknown) => { calls.push(name); if (a && typeof a === 'object' && 'caseId' in a && (a as { caseId: unknown }).caseId !== CASE) throw contractError('forbidden'); };
  const storeCall = (name: string) => async (a: unknown) => { rec(name, a); fail('store'); return answer(name, a); };
  function answer(name: string, a: unknown): unknown {
    switch (name) {
      case 'activeVersionId': return script.active === undefined ? (script.publication.kind === 'published' ? script.publication.resultsVersion : null) : script.active;
      case 'verifyVersion': return script.verify ?? { ok: true, ms: 1 };
      // Preserve the existing integrity-failure scenario at the new cheap port; no UI caller invokes verifyVersion.
      case 'publishedReadiness': {
        if (script.verify && !script.verify.ok) throw contractError(script.verify.reason === 'busy' || script.verify.reason === 'over-budget' ? script.verify.reason : 'integrity');
        return;
      }
      // Explicit scripted immutable attributions, not a ref-membership inference. Real mapping SQL has separate tests.
      case 'originalAttributions': return [{ ref: 'DOC-001', assetId: 'DOC-001' }, { ref: 'DOC-002', assetId: 'DOC-002' }];
      case 'getVersion': return (a as { resultsVersion: string }).resultsVersion === RV ? { id: RV, case_id: CASE, overview: JSON.stringify(OVERVIEW) } : null;
      case 'documentCounts': return { total: 3, imported: 3, provided: 0, failed: [] };
      case 'viewContentOf': return viewContent('{docCount} documents in a synthetic matter');
      case 'listJson': return { json: JSON.stringify(ROWS), etag: '"e"', failed: [] };
      default: throw new Error(`unexpected store call ${name}`);
    }
  }
  const store = new Proxy({} as C.CaseReader, {
    get(_t, prop: string) {
      if (prop === 'getCase') return async (a: C.Scope) => {
        calls.push('getCase'); fail('getCase');
        if (a.caseId !== CASE || script.missingCase) return null;
        return { caseId: CASE, caseLabel: `Case ${HOSTILE}`, publication: script.publication, href: `/cases/${CASE}`, documents: null } satisfies C.CaseInfo;
      };
      if (prop === 'then') return undefined;
      return storeCall(prop);
    },
  });
  const assets: C.AssetsAccess = {
    async originals(a) { rec('originals', a); fail('originals'); return [{ assetId: 'DOC-001', filename: `${HOSTILE}.pdf`, mediaType: 'application/pdf', size: 10 }, { assetId: 'DOC-002', filename: 'invoice.pdf', mediaType: 'application/pdf', size: 20 }]; },
    availability: async () => { throw new Error('unexpected'); }, metadata: async () => { throw new Error('unexpected'); }, links: async () => { throw new Error('unexpected'); }, get: async () => { throw new Error('unexpected'); },
  };
  const userWork = new Proxy({} as C.AsyncUserWork, {
    get(_t, prop: string) {
      if (prop === 'then') return undefined;
      if (prop === 'notesFor') return async (a: C.Scope & { target: C.NoteTarget | null }) => { rec('notesFor', a); fail('notesFor'); return [...notes.values()].filter((x) => a.target === null || JSON.stringify(x.target) === JSON.stringify(a.target)); };
      // The notes read and one register's rows together; a notes fault fails both, as the one D1 read does.
      if (prop === 'readNoteWork') return async (a: C.Scope & { target: C.NoteTarget | null; store: string; rowsWhere?: { field: string; equals: string } }) => {
        rec('readNoteWork', a); fail('notesFor');
        return { notes: [...notes.values()].filter((x) => a.target === null || JSON.stringify(x.target) === JSON.stringify(a.target)),
          rows: rows.filter((r) => r.store === a.store && (!a.rowsWhere || r.fields[a.rowsWhere.field] === a.rowsWhere.equals)) };
      };
      if (prop === 'anchorFor') return async (a: C.VersionScope & { ref: string }) => { rec('anchorFor', a); return { caseId: a.caseId, resultsVersion: a.resultsVersion, refAtCreation: a.ref, sha256: null } satisfies C.Anchor; };
      if (prop === 'addNote') return async (a: C.CreateScope & { target: C.NoteTarget; body: string }): Promise<C.Written<C.HostedNote>> => {
        rec('addNote', a); fail('addNote'); writes.push(structuredClone(a));
        const note: C.HostedNote = { id: `note-${++n}`, body: a.body, createdAt: '2026-10-25T00:00:00Z', target: a.target, status: 'here', candidates: [], intact: true };
        const version = id('row-version', `v${n}`);
        notes.set(note.id, { ...note, version });
        return { kind: 'written', value: note, version, caseRevision: id('case-revision', `r${n}`) };
      };
      if (prop === 'deleteNote') return async (a: C.UpdateScope & { id: string }): Promise<C.Written<boolean>> => {
        rec('deleteNote', a); fail('deleteNote'); writes.push(structuredClone(a));
        const cur = notes.get(a.id);
        if (!cur) return { kind: 'gone' };
        if (cur.version !== a.expected.version) return { kind: 'stale' };
        notes.delete(a.id);
        return { kind: 'written', value: true, version: id('row-version', `d${++n}`), caseRevision: id('case-revision', `r${n}`) };
      };
      return async () => { throw new Error(`unexpected userWork call ${prop}`); };
    },
  });
  const identity: C.Identity = { kind: 'anonymous', principal: null, sessionId: null, clientId: id('client', 'client-a'), checkRevocation: async () => {}, authorize: async () => { calls.push('identity.authorize'); } };
  const services: C.RequestServices = { identity, store, assets, userWork, audit: { append: async (e) => ({ eventId: e.eventId }) }, runtime: { now: () => new Date('2026-10-25T00:00:00Z'), probe: async () => ({ ok: false, bindings: { DB: false, BUCKET: false, ASSETS: false }, probes: { d1: false, r2: false } }), build: undefined as never, gate: null, testIdentity: null }, shards: { read: async () => { calls.push('shards.read'); return null; } } };
  return { services, calls, notes, rows, writes };
}

/** A note already stored for the case, at the given version. */
export function seedNote(f: Fake, noteId: string, version: string, body = 'existing note') {
  f.notes.set(noteId, { id: noteId, body, createdAt: '2026-10-24T00:00:00Z', target: { kind: 'case' }, status: 'here', candidates: [], intact: true, version: id('row-version', version) });
}

export const event = (services: C.RequestServices, params: Record<string, string>, url = 'https://client-a.example.invalid/cases/case-a1', init?: RequestInit) =>
  ({ locals: services, params, url: new URL(url), request: new Request(url, init) }) as never;

export function form(fields: Record<string, string>, url = 'https://client-a.example.invalid/cases/case-a1/notes') {
  const body = new URLSearchParams(fields);
  return { url, init: { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } } satisfies RequestInit };
}

/** What a Kit `error()` or `redirect()` throws, or the value returned. */
export async function outcome<T>(p: Promise<T> | T): Promise<{ thrown: { status: number; body?: unknown; location?: string } } | { value: T }> {
  try { return { value: await p }; } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) return { thrown: e as { status: number } };
    throw e;
  }
}
