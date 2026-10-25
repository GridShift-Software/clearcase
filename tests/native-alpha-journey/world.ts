// HARNESS SELF-TEST ONLY. A small in-process stand-in for the deployed routes, used by this directory's unit tests to
// prove that the scenario's judgements work: a faithful world must pass, and each seeded defect must be caught. It is
// NOT the acceptance boundary and proves nothing about the deployed system; run.ts never imports it (static.test.ts
// enforces that), and a test that passes here is a statement about the runner only.
import { canon, sha256Hex, isPlain } from './common.ts';
import type { FetchFn } from './http.ts';
import type { JourneyFixture } from './fixtures.ts';
import { IDENTITY_KEYS } from './routes.ts';

export type Defect =
  | 'leakWrongClientOriginal' | 'previewPublic' | 'crossOriginAccepted' | 'refusalDeletesNotes' | 'unknownDiffersFromForeign' | 'revokedAccepted'
  | 'staleSignoffAccepted' | 'wrongSha' | 'testIdentity' | 'publishAnySignoff' | 'notesLostOnRestart' | 'wrongOriginalBytes' | 'noCitationLink'
  | 'operatorDownloadOpen' | 'extraUploadAccepted' | 'uploadMutatesOnRefusal' | 'dirtyBuild';

export const SIM_COOKIE = 'simactor';
const html = (body: string, status = 200) => new Response(`<!doctype html><html><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html' } });
const j = (o: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
const refuse = (status: number) => j({ code: 'refused', message: 'Not available.' }, status);

export function createWorld(f: JourneyFixture, o: { sha: string; caseId: string; foreignCaseId?: string; origin: string; defects?: Defect[] }) {
  const d = new Set(o.defects ?? []);
  const st = { submissions: [] as { operationId: string; declared: boolean; finalized: boolean }[], opSha: new Map<string, string>(), candidate: null as null | { id: string }, signoffs: new Map<string, { op: string }>(), pubOps: new Map<string, unknown>(), published: false, notes: [] as { id: string; version: number; body: string; ref: string | null }[], noteOps: new Set<string>(), seq: 0 };
  const identity = (): Record<string, string> => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, `${k}-value`])) as Record<string, string>;
  const asset = 'sub-op-0001';
  const fileFacts = { path: f.pdf.path, sha256: f.pdf.sha256, size: f.pdf.size };
  const manifest = () => ({ caseId: o.caseId, files: [{ ...fileFacts, assetId: asset }] });
  const view = (op: string) => ({ operationId: op, path: f.pdf.path, size: f.pdf.size, results: 'none', stage: 'finalized', manifest: manifest(), handoff: [{ path: f.pdf.path, href: `/cases/${o.caseId}/originals/${asset}` }] });

  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input), method = init.method ?? 'GET', headers = new Headers(init.headers);
    const cookie = /simactor=(\w+)/.exec(headers.get('cookie') ?? '')?.[1] ?? null;
    const actor = d.has('revokedAccepted') && cookie === 'revoked' ? 'clientA' : cookie;
    const write = method !== 'GET' && method !== 'HEAD';
    const origin = headers.get('origin');
    const body = init.body === undefined ? new Uint8Array() : typeof init.body === 'string' ? new TextEncoder().encode(init.body) : (init.body as Uint8Array);
    const text = new TextDecoder().decode(body);
    const path = decodeURIComponent(url.pathname);
    const caseOf = (m: RegExpMatchArray | null) => (m ? m[1] : null);
    const knownCase = (c: string | null) => c === o.caseId;

    if (path === '/health') return j({ ok: true, build: { revision: d.has('wrongSha') ? 'f'.repeat(40) : o.sha, dirty: d.has('dirtyBuild'), exported: false, profile: 'production', target: 'cloudflare' }, gate: null, identityProvider: d.has('testIdentity') ? 'double' : null });
    if (path === '/sign-in') return html(d.has('testIdentity') ? '<select name="identity"></select>' : '<a href="https://clerk.example.invalid/sign-in">Sign in</a>');

    const clientAuth = (needGrant: boolean, c: string | null): Response | null => {
      if (!actor) return write || needGrant ? j({ code: 'unauthenticated' }, 401) : new Response(null, { status: 303, headers: { location: '/sign-in' } });
      if (actor === 'otherClient' || actor === 'revoked') return j({ code: actor === 'otherClient' ? 'wrong-client' : 'unauthenticated' }, 401);
      if (actor !== 'clientA') return needGrant ? refuse(403) : refuse(404);
      if (write && !d.has('crossOriginAccepted') && origin !== o.origin) return j({ code: 'cross-origin' }, 403);
      if (!knownCase(c)) { if (c === o.foreignCaseId && d.has('unknownDiffersFromForeign')) return refuse(404); return needGrant ? refuse(403) : refuse(d.has('unknownDiffersFromForeign') ? 403 : 404); }
      return null;
    };
    const operatorAuth = (): Response | null => {
      if (d.has('operatorDownloadOpen')) return null;
      if (!actor) return j({ code: 'unauthenticated' }, 401);
      if (actor === 'otherClient' || actor === 'revoked') return j({ code: 'unauthenticated' }, 401);
      return actor === 'operatorB' || actor === 'reviewer' ? (write && origin !== o.origin ? j({ code: 'cross-origin' }, 403) : null) : refuse(403);
    };

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/client\/intake\/([^/]+)\/submissions$/))) {
      const deny = clientAuth(method === 'POST', m[1]);
      if (deny) { if (d.has('uploadMutatesOnRefusal') && method === 'POST') st.submissions.push({ operationId: 'junk', declared: true, finalized: true }); return deny; }
      if (method === 'GET') return j({ submissions: st.submissions.filter((s) => s.finalized).map((s) => view(s.operationId)) });
      const decl = JSON.parse(text) as { operationId: string; sha256: string };
      const prior = st.opSha.get(decl.operationId);
      if (prior && prior !== decl.sha256) return j({ code: 'operation-reused' }, 409);
      if (!prior) { st.opSha.set(decl.operationId, decl.sha256); st.submissions.push({ operationId: decl.operationId, declared: true, finalized: false }); }
      return j({ operationId: decl.operationId, stage: 'received' }, prior ? 200 : 201);
    }
    if ((m = path.match(/^\/client\/intake\/([^/]+)\/submissions\/([^/]+)$/))) {
      const deny = clientAuth(method === 'PUT', m[1]);
      if (deny) return deny;
      const s = st.submissions.find((x) => x.operationId === m![2]);
      if (!s) return j({ code: 'not-found' }, 404);
      if (method === 'PUT') { const again = s.finalized; s.finalized = true; if (d.has('extraUploadAccepted') && again) st.submissions.push({ operationId: 'dup', declared: true, finalized: true }); return j(view(s.operationId), again ? 200 : 201); }
      return j(view(s.operationId));
    }
    if ((m = path.match(/^\/operator\/submissions\/([^/]+)\/([^/]+)$/))) { const deny = operatorAuth(); if (deny) return deny; return j({ files: [fileFacts] }); }
    if ((m = path.match(/^\/operator\/submissions\/([^/]+)\/([^/]+)\/download\/([^/]+)$/))) {
      const deny = operatorAuth(); if (deny) return deny;
      return new Response(f.pdf.bytes as BodyInit, { status: 200, headers: { 'content-type': 'application/pdf', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' } });
    }
    if ((m = path.match(/^\/operator\/results\/([^/]+)\/import$/))) {
      const deny = operatorAuth(); if (deny) return deny;
      if (sha256Hex(body) !== sha256Hex(f.packageZip)) return j({ code: 'invalid-package' }, 422);
      st.candidate = { id: 'cand-0001' };
      return j({ candidateId: 'cand-0001', identity: { ...identity(), resultsVersion: f.resultsVersion, manifestSha256: f.packageManifestSha256, packageInputRevisionId: f.inputRevisionId }, newWarnings: [] }, 201);
    }
    if ((m = path.match(/^\/operator\/results\/([^/]+)\/candidates\/([^/]+)$/))) { const deny = operatorAuth(); if (deny) return deny; return html(`<h1>Private preview</h1><p>${f.subject}</p>`); }
    if ((m = path.match(/^\/operator\/recovery\/([^/]+)\/export$/))) {
      const deny = operatorAuth(); if (deny) return deny;
      return new Response(new Uint8Array([...new TextEncoder().encode('ARCHIVE:'), ...f.pdf.bytes]) as BodyInit, { status: 200 });
    }
    if ((m = path.match(/^\/operator\/publication\/([^/]+)\/(signoffs|publish)$/))) {
      const deny = operatorAuth(); if (deny) return deny;
      let b: Record<string, unknown>;
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { return j({ code: 'invalid-request' }, 422); }
      if (m[2] === 'signoffs') {
        if ('ready' in b) return j({ code: 'invalid-request' }, 422);
        const idn = b.identity as Record<string, string>;
        if (!d.has('staleSignoffAccepted') && (!isPlain(idn) || idn.snapshotRevision !== 'snapshotRevision-value')) return j({ code: 'stale-candidate' }, 409);
        if (b.selfApproval !== (actor === 'operatorB')) return j({ code: 'self-approval-mismatch' }, 422);
        const id = `so-${b.operationId}`, existed = st.signoffs.has(id);
        st.signoffs.set(id, { op: String(b.operationId) });
        return j({ signoffId: id, state: 'signed-off', resultsVersion: f.resultsVersion, selfApproval: b.selfApproval }, existed ? 200 : 201);
      }
      const exp = b.expected as { kind: string };
      if (st.pubOps.has(String(b.operationId))) return j(st.pubOps.get(String(b.operationId)));
      if (!d.has('publishAnySignoff') && !st.signoffs.has(String(b.signoffId))) return j({ code: 'not-found' }, 404);
      if (exp.kind !== (st.published ? 'published' : 'none')) return j({ code: 'publication-conflict' }, 409);
      st.published = true;
      const out = { operationId: b.operationId, publication: { kind: 'published', resultsVersion: f.resultsVersion } };
      st.pubOps.set(String(b.operationId), out);
      return j(out);
    }

    if ((m = path.match(/^\/cases\/([^/]+)$/))) {
      const deny = clientAuth(false, m[1]); if (deny) return deny;
      const links = st.published || st.submissions.some((s) => s.finalized) ? `<a data-action="open-original" data-asset-id="${asset}" href="/cases/${o.caseId}/originals/${asset}">file</a>` : '';
      return html(`<h1 data-case-id="${o.caseId}">Case</h1>${st.published ? `<section data-overview-state="published" data-results-version="${f.resultsVersion}"></section>` : '<section data-results-state="pending"></section>'}${links}`);
    }
    if ((m = path.match(/^\/cases\/([^/]+)\/views\/([^/]+)\/chronology$/))) {
      const deny = clientAuth(false, m[1]); if (deny) return deny;
      if (!st.published && !d.has('previewPublic')) return refuse(404);
      const link = d.has('noCitationLink') ? '' : `<a data-action="open-original" data-asset-id="${f.ref}" href="/cases/${o.caseId}/originals/${asset}">open</a>`;
      return html(`<main data-view="chronology"><table><tr data-ref="${f.ref}"><td>${f.subject}</td><td>${link}</td></tr></table></main>`);
    }
    if ((m = path.match(/^\/cases\/([^/]+)\/originals\/([^/]+)$/))) {
      const outsider = actor === 'otherClient' && d.has('leakWrongClientOriginal');
      const deny = outsider ? null : clientAuth(false, m[1]); if (deny) return deny;
      let bytes = d.has('wrongOriginalBytes') ? new Uint8Array([...f.pdf.bytes.slice(0, -1), 33]) : f.pdf.bytes;
      const hdr: Record<string, string> = { 'content-type': 'application/pdf', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' };
      const range = headers.get('range');
      if (range && method === 'GET') { bytes = bytes.slice(0, 10); return new Response(bytes as BodyInit, { status: 206, headers: { ...hdr, 'content-range': `bytes 0-9/${f.pdf.size}` } }); }
      return new Response(method === 'HEAD' ? null : (bytes as BodyInit), { status: 200, headers: { ...hdr, 'content-length': String(f.pdf.size) } });
    }
    if ((m = path.match(/^\/cases\/([^/]+)\/notes$/))) {
      if (method === 'GET') {
        const deny = clientAuth(false, m[1]); if (deny) return deny;
        return html(`<main data-view="notes"><ul>${st.notes.map((n) => `<li data-note-id="${n.id}" data-note-version="${n.version}">${n.body}${n.ref ? ` on ${n.ref}` : ''}</li>`).join('')}</ul></main>`);
      }
      const deny = clientAuth(true, m[1]);
      if (deny) { if (d.has('refusalDeletesNotes')) st.notes = []; return deny; }
      const form = new URLSearchParams(text), op = form.get('operationId') ?? '';
      if (url.search === '?/delete') {
        const n = st.notes.find((x) => x.id === form.get('id'));
        if (!n || String(n.version) !== form.get('version')) return refuse(409);
        st.notes = st.notes.filter((x) => x !== n);
        return new Response(null, { status: 303, headers: { location: `/cases/${o.caseId}/notes?deleted=1` } });
      }
      if (!st.noteOps.has(op)) { st.noteOps.add(op); st.notes.push({ id: `n${++st.seq}`, version: 1, body: form.get('body') ?? '', ref: form.get('ref') || null }); }
      return new Response(null, { status: 303, headers: { location: `/cases/${o.caseId}/notes?saved=1` } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetchFn, state: st, restart() { if (d.has('notesLostOnRestart')) st.notes = []; } };
}

export const simRoutes = {
  schema: 'clearcase.native-journey-routes/1',
  ports: {
    'operator.submission.get': { method: 'GET', path: '/operator/submissions/{caseId}/{operationId}', captures: { files: '/files' } },
    'operator.submission.download': { method: 'GET', path: '/operator/submissions/{caseId}/{operationId}/download/{assetId}' },
    'operator.import': { method: 'POST', path: '/operator/results/{caseId}/import', contentType: 'application/zip', captures: { candidateId: '/candidateId', identity: '/identity', newWarnings: '/newWarnings' } },
    'operator.preview': { method: 'GET', path: '/operator/results/{caseId}/candidates/{candidateId}' },
    'recovery.export': { method: 'GET', path: '/operator/recovery/{caseId}/export', actor: 'operatorB', containsOriginal: true },
  },
};
void canon;
