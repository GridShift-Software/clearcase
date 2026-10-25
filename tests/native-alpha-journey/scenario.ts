// The native alpha user journey, as three phases against the deployed production-profile system:
//   1 upload-import      client A uploads the synthetic PDF; operator B reads the manifest and downloads the original;
//                        B imports the precomputed synthetic package; the private candidate is previewed. It stops there:
//                        the exact candidate identity is shown to a human and the run is AWAITING-HUMAN-SIGNOFF.
//   2 signoff-publish    after the human confirms that identity, the sign-off, publish, the client's chronology,
//                        citation and PDF, a note and an annotation, the refusal sweep and the export, then the readback.
//   3 after-restart      the same facts read again after the parent restarts or redeploys the same revision.
// Every request goes to the real origin with a real Clerk session. A failed check is recorded and the phase goes on where
// that is safe, so one run shows every failure; a check whose input is missing is a failure, never a skip.
import { PART, SHA, canon, isPlain, sha256Hex, randomHex } from './common.ts';
import type { Actor, Reply } from './http.ts';
import { tagsWith, visibleText } from './html.ts';
import { privateUntilPublished, refusal, sameRefusal } from './judge.ts';
import { compareReadbacks, sealReadback, type Readback, type ReadbackChronologyRow, type ReadbackNote, type ReadbackOriginal } from './readback.ts';
import { IDENTITY_KEYS, UNRESOLVED_PORTS, expand, pointer, portProblems, type Port, type PortName, type Var } from './routes.ts';
import { validateExport } from './export.ts';
import type { JourneyFixture } from './fixtures.ts';

export interface Obs { id: string; ok: boolean; status: number | null; detail: string }
export interface Actors { anon: Actor; clientA: Actor; operatorB: Actor; otherClient: Actor; revoked: Actor; reviewer: Actor | null }
export interface Plan { origin: string; expectedSha: string; caseId: string; foreignCaseId: string | null; ports: Partial<Record<PortName, Port>> }
export interface Ctx { plan: Plan; actors: Actors; fixture: JourneyFixture; newId: () => string }
export interface State {
  schema: 'clearcase.native-journey-state/1'; runId: string; deployedSha: string; caseId: string; operationId: string; assetId: string;
  resultsVersion: string; candidateId: string; identity: Record<string, string>; identityDigest: string; newWarnings: string[];
}
export const STATE_SCHEMA = 'clearcase.native-journey-state/1';

class Rec {
  obs: Obs[] = [];
  /** `false` and `detail` are always recorded; a thrown request is a failed check, never an abort of the whole run. */
  add(id: string, ok: boolean, detail: string, status: number | null = null) { this.obs.push({ id, ok, status, detail: detail.slice(0, 300) }); return ok; }
  get failed() { return this.obs.filter((o) => !o.ok); }
  async guard<T>(id: string, work: () => Promise<T>): Promise<T | null> {
    try { return await work(); } catch (e) { this.add(id, false, `the request failed: ${e instanceof Error ? e.message : String(e)}`); return null; }
  }
}

const json = (r: Reply): unknown => { try { return JSON.parse(r.text); } catch { return undefined; } };
const stripSha = (s: unknown) => (typeof s === 'string' ? s.replace(/^sha256:/, '') : s);
const opId = (ctx: Ctx) => `${ctx.newId()}`;

function port(ctx: Ctx, name: PortName): Port { const p = ctx.plan.ports[name]; if (!p) throw new Error(`route port ${name} is unresolved`); return p; }
async function call(ctx: Ctx, who: Actor, name: PortName, vars: Partial<Record<Var, string>>, init: Parameters<Actor['send']>[2] = {}, method?: string): Promise<Reply> {
  const p = port(ctx, name);
  return who.send(method ?? p.method, expand(p.path, vars), init);
}
const v = (ctx: Ctx, extra: Partial<Record<Var, string>> = {}): Partial<Record<Var, string>> => ({ caseId: ctx.plan.caseId, ...extra });
const jsonBody = (o: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
const form = (o: Record<string, string>) => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

const forbidden = (ctx: Ctx) => ({ text: ctx.fixture.markers, bytes: [ctx.fixture.pdf.bytes] });

/** The same request by each actor that must be refused; every refusal is judged for status and for leaked content. */
async function refusedBy(ctx: Ctx, rec: Rec, id: string, who: [string, Actor][], send: (a: Actor) => Promise<Reply>) {
  for (const [name, a] of who) {
    const r = await rec.guard(`${id}.${name}`, () => send(a));
    if (r) { const j = refusal(r, forbidden(ctx)); rec.add(`${id}.${name}`, j.ok, j.detail, r.status); }
  }
}
const outsiders = (ctx: Ctx): [string, Actor][] => [['anon', ctx.actors.anon], ['other-client', ctx.actors.otherClient], ['revoked', ctx.actors.revoked]];

/** Direct phase callers fail closed too; CLI configuration HOLDs before creating this context. */
function prerequisites(ctx: Ctx, rec: Rec, label: string): boolean {
  const problems: string[] = [];
  if (!ctx.plan.foreignCaseId || !PART.test(ctx.plan.foreignCaseId) || ctx.plan.foreignCaseId === ctx.plan.caseId) problems.push('a provisioned ungranted foreign case is required');
  for (const name of UNRESOLVED_PORTS) {
    const p = ctx.plan.ports[name];
    problems.push(...(p ? portProblems(name, p) : [`route port ${name} is unresolved`]));
  }
  return rec.add(`${label}.prerequisites`, problems.length === 0, problems.join('; ') || 'required case and owning route contracts supplied');
}

// ---- health and the exact deployed revision -------------------------------------------------------------------------
export async function checkHealth(ctx: Ctx, rec: Rec, label: string): Promise<boolean> {
  const r = await rec.guard(`${label}.health`, () => call(ctx, ctx.actors.anon, 'health', {}));
  if (!r) return false;
  const j = json(r), b = isPlain(j) && isPlain(j.build) ? j.build : null;
  const problems: string[] = [];
  if (r.status !== 200) problems.push(`status ${r.status}`);
  if (!isPlain(j) || j.ok !== true) problems.push('ok is not true');
  if (!b) problems.push('no build stamp');
  else {
    if (b.revision !== ctx.plan.expectedSha) problems.push('the build revision is not the expected commit');
    if (b.dirty !== false) problems.push('the build is dirty or unstated');
    if (b.profile !== 'production') problems.push('the build is not the production profile');
    if (b.target !== 'cloudflare') problems.push('the build target is not cloudflare');
  }
  if (isPlain(j) && j.gate !== null) problems.push('a hosted-gate run is reported');
  if (isPlain(j) && j.identityProvider !== null) problems.push('a test identity provider is reported');
  return rec.add(`${label}.health`, problems.length === 0, problems.join('; ') || 'production build at the exact expected commit', r.status);
}

// ---- readback of the published state, as the client sees it ---------------------------------------------------------
export interface Snapshot { readback: Readback; problems: string[] }
export async function readSnapshot(ctx: Ctx, who: Actor, rec: Rec, label: string, withExport: Readback['exportSha256'] = null): Promise<Snapshot | null> {
  const f = ctx.fixture, problems: string[] = [];
  const page = await rec.guard(`${label}.case-page`, () => call(ctx, who, 'case.page', v(ctx)));
  if (!page) return null;
  const overview = tagsWith(page.text, 'data-overview-state')[0];
  const publication: Readback['publication'] = page.status === 200 && overview?.['data-overview-state'] === 'published' && overview['data-results-version'] === f.resultsVersion ? { kind: 'published', resultsVersion: f.resultsVersion } : { kind: 'none' };
  if (page.status !== 200) problems.push(`case page ${page.status}`);
  if (publication.kind !== 'published') problems.push('the case page does not show the published results version');
  const links = tagsWith(page.text, 'data-action', 'open-original').filter((t) => t['data-asset-id'] && t.href);
  const originals: ReadbackOriginal[] = [];
  for (const l of links) {
    const bytes = await rec.guard(`${label}.original`, () => call(ctx, who, 'original.get', v(ctx, { assetId: l['data-asset-id'] })));
    if (!bytes) { problems.push('original request failed'); continue; }
    if (bytes.status !== 200) problems.push(`original ${l['data-asset-id']} answered ${bytes.status}`);
    originals.push({ assetId: l['data-asset-id'], sha256: bytes.sha256, size: bytes.bytes.byteLength || 1 });
  }
  const chrono = await rec.guard(`${label}.chronology`, () => call(ctx, who, 'case.chronology', v(ctx, { resultsVersion: f.resultsVersion })));
  const chronology: ReadbackChronologyRow[] = [];
  if (chrono) {
    if (chrono.status !== 200) problems.push(`chronology ${chrono.status}`);
    for (const m of chrono.text.matchAll(/<tr\b[^>]*\bdata-ref="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
      const open = tagsWith(m[2], 'data-action', 'open-original')[0];
      const href = open?.href;
      const last = href ? decodeURIComponent(href.split('/').pop() ?? '') : '';
      chronology.push({ ref: m[1], subject: visibleText(m[2]).includes(f.subject) ? f.subject : '(subject missing)', originalAssetId: PART.test(last) ? last : null });
    }
  }
  const notesPage = await rec.guard(`${label}.notes`, () => call(ctx, who, 'case.notes', v(ctx)));
  const notes: ReadbackNote[] = [];
  if (notesPage) {
    if (notesPage.status !== 200) problems.push(`notes ${notesPage.status}`);
    for (const m of notesPage.text.matchAll(/<li\b[^>]*\bdata-note-id="[^"]*"[^>]*>([\s\S]*?)<\/li>/g)) {
      const text = visibleText(m[1]);
      const body = text.match(new RegExp(`journey-(?:note|annotation)-${f.runId}(?: (?!on )[a-z-]+)*`))?.[0];
      if (body) notes.push({ body, annotation: text.includes(f.ref) && body.startsWith('journey-annotation') ? f.ref : null });
    }
  }
  if (!chrono) problems.push('chronology request failed');
  if (!notesPage) problems.push('notes request failed');
  rec.add(`${label}.snapshot`, problems.length === 0, problems.join('; ') || 'all snapshot requests succeeded and publication matches');
  if (problems.length) return null;
  return { readback: sealReadback({ deployedSha: ctx.plan.expectedSha, caseId: ctx.plan.caseId, resultsVersion: f.resultsVersion, publication, originals, chronology, notes, exportSha256: withExport }), problems };
}

// ---- phase 1 ------------------------------------------------------------------------------------------------------
export async function uploadImport(ctx: Ctx): Promise<{ obs: Obs[]; state: State | null }> {
  const rec = new Rec(), f = ctx.fixture, A = ctx.actors.clientA, B = ctx.actors.operatorB;
  if (!prerequisites(ctx, rec, 'p1') || !(await checkHealth(ctx, rec, 'p1'))) return { obs: rec.obs, state: null };

  const si = await rec.guard('p1.sign-in', () => call(ctx, ctx.actors.anon, 'page.sign-in', {}));
  if (si) rec.add('p1.sign-in', si.status === 200 && !/name="identity"/.test(si.text) && !/data-test-identity/.test(si.text), si.status === 200 ? 'the sign-in page offers no test identity' : `status ${si.status}`, si.status);
  await refusedBy(ctx, rec, 'p1.case-page-unsigned', [['anon', ctx.actors.anon]], (a) => call(ctx, a, 'case.page', v(ctx)));

  const list0 = await rec.guard('p1.fresh-case', () => call(ctx, A, 'intake.list', v(ctx)));
  const subs0 = list0 && isPlain(json(list0)) ? (json(list0) as { submissions?: unknown }).submissions : undefined;
  if (!rec.add('p1.fresh-case', !!list0 && list0.status === 200 && Array.isArray(subs0) && subs0.length === 0, list0 ? `status ${list0.status}; the case must have no earlier submission (a second PDF breaks the exact file-set rule)` : 'no answer', list0?.status ?? null)) return { obs: rec.obs, state: null };

  // client A uploads the synthetic PDF: declare, then the exact bytes
  const operationId = opId(ctx);
  const decl = { operationId, path: f.pdf.path, size: f.pdf.size, sha256: f.pdf.sha256, mediaType: 'application/pdf' };
  const d = await rec.guard('p1.declare', () => call(ctx, A, 'intake.declare', v(ctx), jsonBody(decl)));
  if (!d) return { obs: rec.obs, state: null };
  rec.add('p1.declare', d.status === 201, `status ${d.status}`, d.status);
  const up = await rec.guard('p1.upload', () => call(ctx, A, 'intake.upload', v(ctx, { operationId }), { headers: { 'content-type': 'application/pdf' }, body: f.pdf.bytes }));
  if (!up) return { obs: rec.obs, state: null };
  const uj = json(up) as { stage?: string; results?: string; manifest?: { revisionId?: string; files?: { path?: string; sha256?: string; size?: number }[] }; handoff?: { href?: string }[] } | undefined;
  const file = uj?.manifest?.files?.[0];
  const manifestOk = up.status === 201 && uj?.stage === 'finalized' && uj.results === 'none' && uj.manifest?.files?.length === 1 && file?.path === f.pdf.path && file?.sha256 === f.pdf.sha256 && file?.size === f.pdf.size;
  rec.add('p1.upload', manifestOk, manifestOk ? 'finalized with the exact path, sha256 and size; results none' : `status ${up.status}; stage ${uj?.stage}; manifest does not match the uploaded PDF`, up.status);
  const assetId = decodeURIComponent((uj?.handoff?.[0]?.href ?? '').split('/').pop() ?? '');
  if (!rec.add('p1.handoff', PART.test(assetId), 'the finalized submission names its original (asset id) through its handoff link')) return { obs: rec.obs, state: null };

  const rd = await rec.guard('p1.read-back', () => call(ctx, A, 'intake.read', v(ctx, { operationId })));
  if (rd) rec.add('p1.read-back', rd.status === 200 && canon(json(rd)) === canon(uj), 'a later read returns the immutable manifest exactly', rd.status);
  const replay = await rec.guard('p1.upload-replay', () => call(ctx, A, 'intake.upload', v(ctx, { operationId }), { headers: { 'content-type': 'application/pdf' }, body: f.pdf.bytes }));
  if (replay) rec.add('p1.upload-replay', replay.status === 200 && canon(json(replay)) === canon(uj), 'replaying the same upload returns the same manifest', replay.status);

  // adverse uploads: nothing may change
  const fresh = () => ({ operationId: opId(ctx), path: f.pdf.path, size: f.pdf.size, sha256: f.pdf.sha256, mediaType: 'application/pdf' });
  const reuse = await rec.guard('p1.operation-reused', () => call(ctx, A, 'intake.declare', v(ctx), jsonBody({ ...decl, sha256: sha256Hex('another file'), size: 99 })));
  if (reuse) rec.add('p1.operation-reused', reuse.status === 409, `an upload id reused for another file answered ${reuse.status}`, reuse.status);
  await refusedBy(ctx, rec, 'p1.declare-refused', [['operator-b', B], ...outsiders(ctx)], (a) => call(ctx, a, 'intake.declare', v(ctx), jsonBody(fresh())));
  const xo = await rec.guard('p1.cross-origin', () => call(ctx, A, 'intake.declare', v(ctx), { ...jsonBody(fresh()), origin: 'https://evil.example' }));
  if (xo) rec.add('p1.cross-origin', xo.status === 403, `a cross-origin upload declaration answered ${xo.status}`, xo.status);
  const unknownCase = `unknown-${randomHex(6)}`;
  const unk = await rec.guard('p1.unknown-case', () => call(ctx, A, 'intake.declare', { caseId: unknownCase }, jsonBody(fresh())));
  if (unk) { const j = refusal(unk, forbidden(ctx)); rec.add('p1.unknown-case', j.ok && unk.status === 403, `${j.detail}; an unknown case must give the uniform 403`, unk.status); }
  if (unk && ctx.plan.foreignCaseId) {
    const foreign = await rec.guard('p1.foreign-case', () => call(ctx, A, 'intake.declare', { caseId: ctx.plan.foreignCaseId! }, jsonBody(fresh())));
    if (foreign) { const j = sameRefusal(unk, foreign, [unknownCase, ctx.plan.foreignCaseId!]); rec.add('p1.foreign-case', j.ok, j.detail, foreign.status); }
  }
  const list1 = await rec.guard('p1.no-extra-upload', () => call(ctx, A, 'intake.list', v(ctx)));
  const subs1 = list1 && isPlain(json(list1)) ? (json(list1) as { submissions?: unknown }).submissions : undefined;
  if (list1) rec.add('p1.no-extra-upload', Array.isArray(subs1) && subs1.length === 1, `the case holds ${Array.isArray(subs1) ? subs1.length : '?'} submissions after the refusals; expected exactly 1`, list1.status);

  // operator B: the manifest and the original
  const mget = await rec.guard('p1.operator-manifest', () => call(ctx, B, 'operator.submission.get', v(ctx, { operationId, assetId })));
  let submissionRevisionId: string | null = null, submissionManifestSha256: string | null = null;
  if (mget) {
    const body = json(mget), caps = port(ctx, 'operator.submission.get').captures!;
    const files = pointer(body, caps.files);
    const revision = pointer(body, caps.revisionId), digest = stripSha(pointer(body, caps.manifestSha256));
    const encoded = pointer(body, caps.manifestBase64);
    let persisted: unknown;
    let exactDigest: string | null = null;
    if (typeof encoded === 'string' && encoded.length > 0) {
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') === encoded) {
        try { persisted = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); exactDigest = sha256Hex(bytes); } catch { /* failed observation below */ }
      }
    }
    const lineageOk = mget.status === 200 && manifestOk && pointer(body, caps.stage) === 'finalized' && typeof revision === 'string' && PART.test(revision) && revision === uj?.manifest?.revisionId && typeof digest === 'string' && SHA.test(digest) && digest === exactDigest && isPlain(persisted) && persisted.caseId === ctx.plan.caseId && persisted.operationId === operationId && canon(persisted) === canon(uj?.manifest ?? null);
    rec.add('p1.submission-lineage', lineageOk, lineageOk ? 'finalized revision and digest of exact persisted manifest bytes match the uploaded submission' : 'missing, unfinalized or mismatched authoritative submission identity', mget.status);
    if (lineageOk) { submissionRevisionId = revision as string; submissionManifestSha256 = digest as string; }
    const ok = mget.status === 200 && Array.isArray(files) && files.length === 1 && isPlain(files[0]) && files[0].path === f.pdf.path && files[0].sha256 === f.pdf.sha256 && files[0].size === f.pdf.size;
    rec.add('p1.operator-manifest', ok, ok ? 'the operator reads the same immutable manifest' : `status ${mget.status}; the manifest does not match the client's upload`, mget.status);
  }
  const dl = await rec.guard('p1.operator-download', () => call(ctx, B, 'operator.submission.download', v(ctx, { operationId, assetId })));
  if (dl) {
    const ok = dl.status === 200 && dl.sha256 === f.pdf.sha256 && dl.bytes.byteLength === f.pdf.size && dl.headers.get('x-content-type-options') === 'nosniff' && /^(application\/pdf|application\/octet-stream)/.test(dl.headers.get('content-type') ?? '');
    rec.add('p1.operator-download', ok, ok ? 'the complete original, exact bytes, safe headers' : `status ${dl.status}; sha256/size/headers do not match the uploaded PDF`, dl.status);
  }
  const opVars = v(ctx, { operationId, assetId });
  await refusedBy(ctx, rec, 'p1.manifest-refused', [['client-a', A], ...outsiders(ctx)], (a) => call(ctx, a, 'operator.submission.get', opVars));
  await refusedBy(ctx, rec, 'p1.download-refused', [['client-a', A], ...outsiders(ctx)], (a) => call(ctx, a, 'operator.submission.download', opVars));

  // Never import or present a human sign-off identity without authoritative finalized submission lineage.
  if (!submissionRevisionId || !submissionManifestSha256) return { obs: rec.obs, state: null };
  // import of the precomputed synthetic package, private
  const imp = await rec.guard('p1.import', () => call(ctx, B, 'operator.import', v(ctx, { operationId }), { headers: { 'content-type': port(ctx, 'operator.import').contentType ?? 'application/zip' }, body: f.packageZip }));
  let candidateId = '', identity: Record<string, string> = {}, newWarnings: string[] = [];
  if (imp) {
    const caps = port(ctx, 'operator.import').captures!, body = json(imp);
    const cid = pointer(body, caps.candidateId), idn = pointer(body, caps.identity), nw = pointer(body, caps.newWarnings);
    const problems: string[] = [];
    if (imp.status !== 200 && imp.status !== 201) problems.push(`status ${imp.status}`);
    if (typeof cid !== 'string' || !PART.test(cid)) problems.push('no candidate id');
    if (!isPlain(idn) || Object.keys(idn).sort().join() !== [...IDENTITY_KEYS].sort().join() || !Object.values(idn).every((x) => typeof x === 'string' && x.length > 0)) problems.push('the identity does not have exactly the nine sign-off keys');
    else {
      if (!submissionRevisionId || idn.submissionRevisionId !== submissionRevisionId) problems.push('the import is not linked to this finalized submission revision');
      if (!submissionManifestSha256 || stripSha(idn.submissionManifestSha256) !== submissionManifestSha256) problems.push('the import is not linked to the exact persisted submission manifest bytes');
      if (idn.resultsVersion !== f.resultsVersion) problems.push('the imported resultsVersion differs from the supplied package');
      if (stripSha(idn.manifestSha256) !== f.packageManifestSha256) problems.push('the package manifest sha256 differs from the supplied package');
      if (idn.packageInputRevisionId !== f.inputRevisionId) problems.push('the package inputRevision id differs from the supplied package');
    }
    if (!Array.isArray(nw) || !nw.every((x) => typeof x === 'string')) problems.push('newWarnings is not a list of fingerprints');
    rec.add('p1.import', problems.length === 0, problems.join('; ') || 'a private candidate linked to this exact package identity', imp.status);
    if (problems.length === 0) { candidateId = cid as string; identity = idn as Record<string, string>; newWarnings = nw as string[]; }
  }
  await refusedBy(ctx, rec, 'p1.import-refused', [['client-a', A], ...outsiders(ctx)], (a) => call(ctx, a, 'operator.import', v(ctx, { operationId }), { headers: { 'content-type': 'application/zip' }, body: f.packageZip }));
  if (!candidateId) return { obs: rec.obs, state: null };

  const pv = await rec.guard('p1.preview', () => call(ctx, B, 'operator.preview', v(ctx, { candidateId })));
  if (pv) rec.add('p1.preview', pv.status === 200 && pv.text.includes(f.subject), pv.status === 200 ? 'the operator previews the private candidate' : `status ${pv.status}`, pv.status);
  await refusedBy(ctx, rec, 'p1.preview-refused', [['client-a', A], ...outsiders(ctx)], (a) => call(ctx, a, 'operator.preview', v(ctx, { candidateId })));
  // private: the client sees nothing of the results before publication
  const cp = await rec.guard('p1.client-sees-no-results', () => call(ctx, A, 'case.page', v(ctx)));
  if (cp) { const j = privateUntilPublished(cp, f.markers); rec.add('p1.client-sees-no-results', j.ok, j.detail, cp.status); }
  const cc = await rec.guard('p1.client-no-chronology', () => call(ctx, A, 'case.chronology', v(ctx, { resultsVersion: f.resultsVersion })));
  if (cc) { const j = refusal(cc, forbidden(ctx)); rec.add('p1.client-no-chronology', j.ok && cc.status === 404, `${j.detail}; the unpublished version must be 404`, cc.status); }

  const identityDigest = sha256Hex(canon({ candidateId, identity }));
  const state: State = { schema: STATE_SCHEMA, runId: f.runId, deployedSha: ctx.plan.expectedSha, caseId: ctx.plan.caseId, operationId, assetId, resultsVersion: f.resultsVersion, candidateId, identity, identityDigest, newWarnings };
  return { obs: rec.obs, state: rec.failed.length ? null : state };
}

// ---- phase 2 ------------------------------------------------------------------------------------------------------
export async function signoffPublish(ctx: Ctx, state: State, human: { reviewerRef: string }): Promise<{ obs: Obs[]; readback: Readback | null }> {
  const rec = new Rec(), f = ctx.fixture, A = ctx.actors.clientA, B = ctx.actors.operatorB;
  if (!prerequisites(ctx, rec, 'p2') || !(await checkHealth(ctx, rec, 'p2'))) return { obs: rec.obs, readback: null };
  rec.add('p2.state', state.deployedSha === ctx.plan.expectedSha && state.caseId === ctx.plan.caseId && state.runId === f.runId && state.resultsVersion === f.resultsVersion, 'the phase 1 state names this commit, case and run');
  const rv = f.resultsVersion;
  const stillPrivate = async (id: string) => { const r = await rec.guard(id, () => call(ctx, A, 'case.chronology', v(ctx, { resultsVersion: rv }))); if (r) rec.add(id, r.status === 404 && !r.text.includes(f.subject), `the unpublished version answered ${r.status} to the client`, r.status); };
  await stillPrivate('p2.private-before-signoff');

  // sign-off: the adverse cases first, then the human's
  const signer = ctx.actors.reviewer ?? B, selfApproval = ctx.actors.reviewer === null;
  const acks = state.newWarnings.map((fingerprint) => ({ fingerprint, reason: `Reviewed by ${human.reviewerRef}` }));
  const so = (over: Record<string, unknown> = {}) => jsonBody({ operationId: opId(ctx), candidateId: state.candidateId, identity: state.identity, acknowledgements: acks, selfApproval, ...over });
  await refusedBy(ctx, rec, 'p2.signoff-refused', [['client-a', A], ...outsiders(ctx)], (a) => call(ctx, a, 'publication.signoff', v(ctx), so()));
  const stale = await rec.guard('p2.signoff-stale', () => call(ctx, signer, 'publication.signoff', v(ctx), so({ identity: { ...state.identity, snapshotRevision: `${state.identity.snapshotRevision}x` } })));
  if (stale) rec.add('p2.signoff-stale', stale.status === 409, `a sign-off naming a stale identity answered ${stale.status}`, stale.status);
  const ready = await rec.guard('p2.signoff-ready-flag', () => call(ctx, signer, 'publication.signoff', v(ctx), so({ ready: true })));
  if (ready) rec.add('p2.signoff-ready-flag', ready.status === 422, `a readiness flag in the request answered ${ready.status}`, ready.status);
  const wrongSelf = await rec.guard('p2.signoff-self-approval', () => call(ctx, signer, 'publication.signoff', v(ctx), so({ selfApproval: !selfApproval })));
  if (wrongSelf) rec.add('p2.signoff-self-approval', wrongSelf.status === 422, `a wrong self-approval claim answered ${wrongSelf.status}`, wrongSelf.status);
  if (state.newWarnings.length) {
    const noAck = await rec.guard('p2.signoff-unacknowledged', () => call(ctx, signer, 'publication.signoff', v(ctx), so({ acknowledgements: [] })));
    if (noAck) rec.add('p2.signoff-unacknowledged', noAck.status === 422, `a sign-off that skips the new warnings answered ${noAck.status}`, noAck.status);
  }
  await stillPrivate('p2.private-after-refused-signoff');

  const soOp = opId(ctx), soBody = jsonBody({ operationId: soOp, candidateId: state.candidateId, identity: state.identity, acknowledgements: acks, selfApproval });
  const signed = await rec.guard('p2.signoff', () => call(ctx, signer, 'publication.signoff', v(ctx), soBody));
  let signoffId = '';
  if (signed) {
    const j = json(signed) as { signoffId?: string; state?: string; resultsVersion?: string; selfApproval?: boolean } | undefined;
    const ok = signed.status === 201 && j?.state === 'signed-off' && j.resultsVersion === rv && j.selfApproval === selfApproval && typeof j.signoffId === 'string';
    rec.add('p2.signoff', ok, ok ? `signed off by the human reviewer (${human.reviewerRef}); self-approval ${selfApproval ? 'recorded' : 'not claimed'}` : `status ${signed.status}`, signed.status);
    if (ok) signoffId = j!.signoffId!;
  }
  if (signoffId) {
    const again = await rec.guard('p2.signoff-replay', () => call(ctx, signer, 'publication.signoff', v(ctx), soBody));
    if (again) rec.add('p2.signoff-replay', again.status === 200 && (json(again) as { signoffId?: string })?.signoffId === signoffId, 'replaying the same sign-off returns the same one', again.status);
  }
  await stillPrivate('p2.private-after-signoff');
  if (!signoffId) return { obs: rec.obs, readback: null };

  // publish: refusals and conflicts change nothing; then the real publication and its replay
  const pub = (over: Record<string, unknown> = {}) => jsonBody({ operationId: opId(ctx), signoffId, expected: { kind: 'none' }, ...over });
  await refusedBy(ctx, rec, 'p2.publish-refused', [['client-a', A], ...outsiders(ctx)], (a) => call(ctx, a, 'publication.publish', v(ctx), pub()));
  const unknownSo = await rec.guard('p2.publish-unknown-signoff', () => call(ctx, B, 'publication.publish', v(ctx), pub({ signoffId: `so-${randomHex(12)}` })));
  if (unknownSo) rec.add('p2.publish-unknown-signoff', unknownSo.status === 404, `an unknown sign-off answered ${unknownSo.status}`, unknownSo.status);
  const wrongExpect = await rec.guard('p2.publish-wrong-expectation', () => call(ctx, B, 'publication.publish', v(ctx), pub({ expected: { kind: 'published', resultsVersion: rv } })));
  if (wrongExpect) rec.add('p2.publish-wrong-expectation', wrongExpect.status === 409, `a publish expecting a state that is not current answered ${wrongExpect.status}`, wrongExpect.status);
  await stillPrivate('p2.private-after-refused-publish');

  const pubOp = opId(ctx), pubBody = jsonBody({ operationId: pubOp, signoffId, expected: { kind: 'none' } });
  const published = await rec.guard('p2.publish', () => call(ctx, B, 'publication.publish', v(ctx), pubBody));
  if (published) {
    const j = json(published) as { publication?: { kind?: string; resultsVersion?: string } } | undefined;
    rec.add('p2.publish', published.status === 200 && j?.publication?.kind === 'published' && j.publication.resultsVersion === rv, `status ${published.status}; the exact signed-off version is published`, published.status);
    const replay = await rec.guard('p2.publish-replay', () => call(ctx, B, 'publication.publish', v(ctx), pubBody));
    if (replay) rec.add('p2.publish-replay', replay.status === 200 && canon(json(replay)) === canon(json(published)), 'replaying the same publish returns the same answer', replay.status);
    const second = await rec.guard('p2.publish-conflict', () => call(ctx, B, 'publication.publish', v(ctx), pub()));
    if (second) rec.add('p2.publish-conflict', second.status === 409, `a second publish expecting no publication answered ${second.status}`, second.status);
  }

  // the client's view of the published results: overview, chronology, citation, PDF
  const before = await readSnapshot(ctx, A, rec, 'p2.client');
  if (before) {
    rec.add('p2.client-published', before.readback.publication.kind === 'published', before.problems.join('; ') || 'the client sees the published version');
    const row = before.readback.chronology.find((r) => r.ref === f.ref);
    rec.add('p2.client-chronology', !!row && row.subject === f.subject, row ? 'the chronology row carries the synthetic subject' : 'no chronology row for the synthetic document');
    const linked = row?.originalAssetId ?? null;
    rec.add('p2.client-citation-link', !!linked && before.readback.originals.some((o) => o.assetId === linked), linked ? 'the citation links to an original that the case lists' : 'the chronology row has no open-original link (a link is never guessed)');
    const orig = before.readback.originals.find((o) => o.assetId === linked);
    rec.add('p2.client-pdf-bytes', !!orig && orig.sha256 === f.pdf.sha256 && orig.size === f.pdf.size, orig ? 'the cited original is the uploaded PDF, byte for byte' : 'no cited original to compare');
    if (linked) await pdfChecks(ctx, rec, linked);
  }

  // note and annotation
  const notesAction = async (op: string, body: string, extra: Record<string, string> = {}) => call(ctx, A, 'case.notes.add', v(ctx), form({ operationId: op, body, ...extra }));
  const n1 = `journey-note-${f.runId} case`, n2 = `journey-annotation-${f.runId} document`, op1 = opId(ctx), op2 = opId(ctx);
  for (const [id, op, body, extra] of [['p2.note', op1, n1, {}], ['p2.annotation', op2, n2, { ref: f.ref, resultsVersion: rv }]] as [string, string, string, Record<string, string>][]) {
    const r = await rec.guard(id, () => notesAction(op, body, extra));
    if (r) rec.add(id, r.status === 303 && /[?&]saved=1/.test(r.location ?? ''), `status ${r.status}; saved through the server`, r.status);
  }
  const replayNote = await rec.guard('p2.note-replay', () => notesAction(op1, n1));
  if (replayNote) rec.add('p2.note-replay', replayNote.status === 303 && /[?&]saved=1/.test(replayNote.location ?? ''), `replaying the same note write answered ${replayNote.status}`, replayNote.status);
  const withNotes = await readSnapshot(ctx, A, rec, 'p2.notes');
  if (withNotes) {
    const have = (b: string) => withNotes.readback.notes.filter((n) => n.body === b).length;
    rec.add('p2.notes-present', have(n1) === 1 && have(n2) === 1 && withNotes.readback.notes.find((n) => n.body === n2)?.annotation === f.ref, `the note appears ${have(n1)} time(s) and the annotation ${have(n2)} time(s); each exactly once, the annotation on ${f.ref}`);
  }
  // a stale delete must change nothing; a note write by an outsider or from another origin must be refused
  const noteId = tagsWith((await A.send('GET', expand(port(ctx, 'case.notes').path, v(ctx)))).text, 'data-note-id')[0]?.['data-note-id'];
  if (noteId) {
    const stale = await rec.guard('p2.note-stale-delete', () => call(ctx, A, 'case.notes.delete', v(ctx), form({ id: noteId, version: 'stale-version-0', operationId: opId(ctx) })));
    if (stale) rec.add('p2.note-stale-delete', stale.status === 409, `deleting a note at a stale version answered ${stale.status}`, stale.status);
  } else rec.add('p2.note-stale-delete', false, 'no note to delete was found on the notes page');
  const xo = await rec.guard('p2.note-cross-origin', () => call(ctx, A, 'case.notes.add', v(ctx), { ...form({ operationId: opId(ctx), body: `journey-note-${f.runId} cross-origin` }), origin: 'https://evil.example' }));
  if (xo) rec.add('p2.note-cross-origin', xo.status === 403, `a cross-origin note write answered ${xo.status}`, xo.status);
  await refusedBy(ctx, rec, 'p2.note-refused', outsiders(ctx), (a) => call(ctx, a, 'case.notes.add', v(ctx), form({ operationId: opId(ctx), body: `journey-note-${f.runId} outsider` })));

  // the refusal sweep, with preservation: nothing the sweep touched may differ afterwards
  const assetId = state.assetId;
  const targets: [string, (a: Actor) => Promise<Reply>][] = [
    ['case-page', (a) => call(ctx, a, 'case.page', v(ctx))], ['chronology', (a) => call(ctx, a, 'case.chronology', v(ctx, { resultsVersion: rv }))],
    ['notes-page', (a) => call(ctx, a, 'case.notes', v(ctx))], ['original', (a) => call(ctx, a, 'original.get', v(ctx, { assetId }))],
    ['original-range', (a) => call(ctx, a, 'original.get', v(ctx, { assetId }), { headers: { range: 'bytes=0-9' } })],
    ['intake-read', (a) => call(ctx, a, 'intake.read', v(ctx, { operationId: state.operationId }))],
    ['intake-upload', (a) => call(ctx, a, 'intake.upload', v(ctx, { operationId: state.operationId }), { headers: { 'content-type': 'application/pdf' }, body: f.pdf.bytes })],
    ['operator-download', (a) => call(ctx, a, 'operator.submission.download', v(ctx, { operationId: state.operationId, assetId }))],
  ];
  for (const [name, send] of targets) await refusedBy(ctx, rec, `p2.sweep.${name}`, outsiders(ctx), send);
  const unknown = `unknown-${randomHex(6)}`;
  const unkPage = await rec.guard('p2.sweep.unknown-case', () => call(ctx, A, 'case.page', { caseId: unknown }));
  if (unkPage) { const j = refusal(unkPage, forbidden(ctx)); rec.add('p2.sweep.unknown-case', j.ok && (unkPage.status === 404 || unkPage.status === 403), j.detail, unkPage.status); }
  if (unkPage && ctx.plan.foreignCaseId) {
    const fp = await rec.guard('p2.sweep.foreign-case', () => call(ctx, A, 'case.page', { caseId: ctx.plan.foreignCaseId! }));
    if (fp) { const j = sameRefusal(unkPage, fp, [unknown, ctx.plan.foreignCaseId!]); rec.add('p2.sweep.foreign-case', j.ok, j.detail, fp.status); }
  }
  const exportSha = await exportChecks(ctx, rec, state.assetId);
  const post = await readSnapshot(ctx, A, rec, 'p2.post-sweep', exportSha);
  // `withNotes` was read after the last accepted write; the stale delete, the cross-origin and outsider note writes and the whole sweep sit between it and `post`
  if (withNotes && post) {
    const diff = compareReadbacks(withNotes.readback, post.readback, { exportMustMatch: false });
    rec.add('p2.preserved', diff.length === 0, diff.length ? `changed by refused requests: ${diff.join(', ')}` : 'originals, chronology, notes and publication are exactly as before the refusals');
  }
  await checkHealth(ctx, rec, 'p2.end');
  return { obs: rec.obs, readback: post && rec.failed.length === 0 ? post.readback : null };
}

/** The original served to the client: bytes, headers, range, a wrong-client refusal, and the optional document viewer. */
async function pdfChecks(ctx: Ctx, rec: Rec, assetId: string) {
  const f = ctx.fixture, A = ctx.actors.clientA, vars = v(ctx, { assetId });
  const get = await rec.guard('p2.pdf.get', () => call(ctx, A, 'original.get', vars));
  if (get) rec.add('p2.pdf.get', get.status === 200 && get.sha256 === f.pdf.sha256 && get.headers.get('x-content-type-options') === 'nosniff', `status ${get.status}; exact bytes with nosniff`, get.status);
  const head = await rec.guard('p2.pdf.head', () => call(ctx, A, 'original.get', vars, {}, 'HEAD'));
  if (head) rec.add('p2.pdf.head', head.status === 200 && Number(head.headers.get('content-length')) === f.pdf.size, `HEAD status ${head.status}; content-length ${head.headers.get('content-length')}`, head.status);
  const part = await rec.guard('p2.pdf.range', () => call(ctx, A, 'original.get', vars, { headers: { range: 'bytes=0-9' } }));
  if (part) rec.add('p2.pdf.range', part.status === 206 && part.headers.get('content-range') === `bytes 0-9/${f.pdf.size}` && Buffer.from(part.bytes).equals(Buffer.from(f.pdf.bytes.slice(0, 10))), `Range answered ${part.status} ${part.headers.get('content-range')}`, part.status);
  const viewer = ctx.plan.ports['viewer.pdf'];
  if (!viewer) rec.add('p2.pdf.viewer', true, 'NOT CHECKED: no viewer.pdf port was supplied (the original bytes route above is the PDF evidence)');
  else {
    const r = await rec.guard('p2.pdf.viewer', () => call(ctx, A, 'viewer.pdf', vars));
    if (r) {
      const external = [...r.text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => { try { return new URL(m[0]).origin; } catch { return m[0]; } }).filter((o) => o !== ctx.plan.origin);
      rec.add('p2.pdf.viewer', r.status === 200 && !!r.headers.get('content-security-policy') && external.length === 0, `viewer status ${r.status}; CSP ${r.headers.get('content-security-policy') ? 'present' : 'absent'}; ${external.length} external origin(s) referenced`, r.status);
    }
  }
}

/** Complete export, when its route is supplied (it always is: no HOLD-free run lacks it). Returns the export's sha256. */
async function exportChecks(ctx: Ctx, rec: Rec, assetId: string): Promise<string | null> {
  const p = port(ctx, 'recovery.export'), who = p.actor === 'operatorB' ? ctx.actors.operatorB : ctx.actors.clientA, f = ctx.fixture;
  const r = await rec.guard('p2.export', () => call(ctx, who, 'recovery.export', v(ctx)));
  let sha: string | null = null;
  if (r) {
    const problems = p.exportContract ? await validateExport(r.bytes, p.exportContract, { caseId: ctx.plan.caseId, assetId, fixture: f }) : ['owning export contract is missing'];
    const ok = r.status === 200 && problems.length === 0;
    rec.add('p2.export', ok, `status ${r.status}; ${problems.join('; ') || 'complete manifest, original identity and all archive bytes verified'}`, r.status);
    if (ok) sha = r.sha256;
  }
  await refusedBy(ctx, rec, 'p2.export-refused', outsiders(ctx), (a) => call(ctx, a, 'recovery.export', v(ctx)));
  return sha;
}

// ---- phase 3 ------------------------------------------------------------------------------------------------------
export async function afterRestart(ctx: Ctx, before: Readback): Promise<{ obs: Obs[]; readback: Readback | null }> {
  const rec = new Rec(), f = ctx.fixture;
  if (!prerequisites(ctx, rec, 'p3') || !(await checkHealth(ctx, rec, 'p3'))) return { obs: rec.obs, readback: null };
  rec.add('p3.same-revision', before.deployedSha === ctx.plan.expectedSha && before.caseId === ctx.plan.caseId && before.resultsVersion === f.resultsVersion, 'the phase 2 readback names this commit, case and version');
  const snap = await readSnapshot(ctx, ctx.actors.clientA, rec, 'p3.client');
  if (snap) {
    const diff = compareReadbacks(before, snap.readback, { exportMustMatch: false });
    rec.add('p3.readback-equal', diff.length === 0, diff.length ? `differs after the restart: ${diff.join(', ')}` : 'originals, chronology, notes and publication read back exactly as before the restart');
    const orig = snap.readback.originals.find((o) => o.sha256 === f.pdf.sha256);
    rec.add('p3.pdf-bytes', !!orig, 'the uploaded PDF still reads back byte for byte');
  }
  const exportSha = await exportChecks(ctx, rec, before.originals.find((o) => o.sha256 === f.pdf.sha256)?.assetId ?? 'missing');
  rec.add('p3.export-present', exportSha !== null, 'the export is available after the restart');
  await refusedBy(ctx, rec, 'p3.case-page-refused', outsiders(ctx), (a) => call(ctx, a, 'case.page', v(ctx)));
  await refusedBy(ctx, rec, 'p3.original-refused', outsiders(ctx), (a) => call(ctx, a, 'original.get', v(ctx, { assetId: before.originals[0]?.assetId ?? 'none' })));
  const { digest: _digest, schema: _schema, ...body } = snap?.readback ?? ({} as Readback);
  return { obs: rec.obs, readback: snap && rec.failed.length === 0 ? sealReadback({ ...body, exportSha256: exportSha }) : null };
}

export { Rec };
