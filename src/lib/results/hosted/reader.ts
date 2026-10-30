import type * as C from '../../server/runtime/contracts.ts';
import { codeOf, contractError, isDenial } from '../../server/runtime/errors.ts';
import { freeze } from '../../server/runtime/data.ts';
import { sha256 } from '../../server/runtime/ids.ts';
import { providerProblem, validOriginal } from '../../server/runtime/provider-row.ts';
import { parseStrictJson, decodeUtf8Strict } from '../../case-package/strict-json.ts';
import { KNOWN_SCHEMAS } from '../../case-package/registry.ts';
import { readViewContent } from '../../case-package/view-content.ts';
import { verifyCandidateBytes } from '../../case-package/verify-bytes.ts';
import type { OpenStorage } from '../../storage/cloud/access.ts';
import { verifiedRead } from '../../storage/cloud/objects.ts';
import { caseFolder, checkClaims, originalClaims } from '../../storage/cloud/original-facts.ts';
import { admitVerification } from '../../storage/cloud/verification.ts';
import { loadVerifiedModel, type DocRow, type LoadedModel } from './model.ts';
import { preparePackage } from './project.ts';
import { readModelDigest } from './read-model.ts';
import type { PublishedCaseReader } from './published-reads.ts';
import { resolveOriginalAttributions } from './original-attribution.ts';
import type { StorageEvent } from './index.ts';
import { caseOfVersion, caseRow, caseRows, publicationRow, requirePublished, unavailable, versionInfo } from './versions.ts';

type FileRow = { path: string; sha256: string; size: number; object_key: string };

/**
 * CaseReader over one client's D1 read model and R2 package files. Every version-scoped read authorizes the case,
 * requires the exact published version (a candidate, a staging version and a withdrawn one, Keep-marked or not, are
 * refused alike), and authorizes and rechecks publication again before it hands back what an awaited read produced.
 */
export function createCloudReader(a: { open: () => Promise<OpenStorage>; identity: C.Identity; record(e: StorageEvent): Promise<void>; stateRevision(s: C.Scope): Promise<C.CaseRevision>; now(): Date }): PublishedCaseReader {
  const { identity, open } = a;
  const providers = new Map<string, C.DocumentProvider>();
  // A version's read model, loaded and checked against its stored digest once per reader. The rows are immutable once a
  // version is stored, so one verified load serves every later read; publication and authority are rechecked on every call.
  const models = new Map<string, Promise<LoadedModel>>();
  const docs = new Map<string, Promise<Pick<DocRow, 'ref' | 'ord' | 'row_json' | 'state_json' | 'list_json'> | null>>();
  function model(s: OpenStorage, rv: C.ResultsVersion): Promise<LoadedModel> {
    let m = models.get(rv);
    if (!m) { m = loadVerifiedModel(s.db, rv); models.set(rv, m); m.catch(() => models.delete(rv)); }
    return m;
  }
  async function authorized(scope: C.Scope) {
    try { await identity.authorize({ ...scope, operation: 'read' }); }
    catch (e) {
      if (isDenial(e)) await a.record({ action: 'case.read', object: { kind: 'case', id: scope.caseId, caseId: scope.caseId }, version: null, outcome: 'denied' }).catch(() => undefined);
      throw e;
    }
  }
  async function guard(scope: C.Scope) { const s = await open(); await authorized(scope); return s; }
  async function version(scope: C.VersionScope) { const s = await guard(scope); await requirePublished(s.db, scope.caseId, scope.resultsVersion); return s; }
  async function release<T>(s: OpenStorage, scope: C.VersionScope, value: T): Promise<T> {
    await identity.authorize({ ...scope, operation: 'read' });
    await requirePublished(s.db, scope.caseId, scope.resultsVersion);
    return value;
  }
  async function file(s: OpenStorage, scope: C.VersionScope, f: FileRow): Promise<Uint8Array> {
    const r = await verifiedRead(s.bucket, f.object_key, f, s.budgets.maxPackageFileBytes);
    if (r.kind === 'missing' || r.kind === 'changed') throw contractError('integrity');
    if (r.kind !== 'ok') unavailable();
    return (r as { bytes: Uint8Array }).bytes;
  }
  const fileRows = (s: OpenStorage, rv: C.ResultsVersion) => s.db.prepare('SELECT path, sha256, size, object_key FROM rs_package_file WHERE version_id = ? ORDER BY path').bind(rv).all<FileRow>().catch(unavailable);
  async function collect(scope: C.VersionScope) {
    const s = await version(scope);
    const rows: C.DocumentRow[] = (await model(s, scope.resultsVersion)).docs.map((d) => ({ ref: d.ref, ord: d.ord, source: 'results', row: JSON.parse(d.row_json), list: JSON.parse(d.list_json), state: JSON.parse(d.state_json) }));
    const failed: C.DocumentRowsResult['failed'] = [], dropped: C.DocumentRowsResult['dropped'] = [], revisions: string[] = [];
    // Providers: the same rules as the memory reader (server/runtime/memory-reader.ts).
    for (const p of providers.values()) {
      const source = `provider:${p.id}` as const;
      try {
        const revision = await p.revision(scope);
        if (!/^[A-Za-z0-9._:+/=-]{1,128}$/.test(revision)) throw contractError('invalid-package');
        const incoming = await p.rows(scope);
        if (!Array.isArray(incoming)) throw contractError('invalid-package');
        const added: C.DocumentRow[] = [], drops: typeof dropped = [];
        for (const item of incoming) {
          let parsed: unknown;
          try { parsed = parseStrictJson(JSON.stringify({ ref: item.ref, row: item.row, list: item.list, state: item.state })); }
          catch { drops.push({ source, ref: '#invalid', reason: 'malformed row: not JSON data' }); continue; }
          const problem = providerProblem(parsed);
          if (problem) {
            const ref = parsed && typeof parsed === 'object' && 'ref' in parsed && typeof parsed.ref === 'string' && parsed.ref.isWellFormed() ? parsed.ref : '#invalid';
            drops.push({ source, ref, reason: problem === 'the list entry names another ref' ? problem : `malformed row: ${problem}` }); continue;
          }
          const x = parsed as C.ProviderRow;
          if (x.state.original && !validOriginal(x.state.original)) {
            x.state.original = null;
            drops.push({ source, ref: x.ref, reason: 'the original was left out: a present original needs a path, size, sha256 and media type' });
          }
          if (rows.some((d) => d.ref === x.ref) || added.some((d) => d.ref === x.ref)) { drops.push({ source, ref: x.ref, reason: 'the ref already names a document of this version' }); continue; }
          if (x.list.ref !== x.ref) { drops.push({ source, ref: x.ref, reason: 'the list entry names another ref' }); continue; }
          const ord = rows.length + added.length;
          added.push({ ...x, ord, source, list: { ...x.list, ord } });
        }
        rows.push(...added); dropped.push(...drops); revisions.push(`${p.id}=${revision}`);
      } catch { failed.push({ source, owner: p.owner, reason: 'provider-unavailable' }); revisions.push(`${p.id}=!`); }
    }
    return release(s, scope, { rows: freeze(rows), failed, dropped, revisions });
  }
  const store: PublishedCaseReader = {
    async publishedReadiness(scope) {
      const s = await version(scope);
      await model(s, scope.resultsVersion);
      await release(s, scope, undefined);
    },
    async originalAttributions(scope) {
      const s = await version(scope);
      const authorizeOriginals = async () => {
        try { await identity.authorize({ caseId: scope.caseId, operation: 'read-original' }); }
        catch (e) {
          if (isDenial(e)) await a.record({ action: 'asset.list', object: { kind: 'case', id: scope.caseId, caseId: scope.caseId }, version: null, outcome: 'denied' }).catch(() => undefined);
          throw e;
        }
      };
      await authorizeOriginals();
      const loaded = await model(s, scope.resultsVersion);
      const folder = await caseFolder(s.db, s.clientId, scope.caseId);
      const links = resolveOriginalAttributions(loaded, folder);
      await authorizeOriginals();
      return release(s, scope, freeze(links));
    },
    async listCases() {
      const s = await open();
      await identity.checkRevocation();
      const rows = caseRows(s.db);
      if (identity.authorizeCases) {
        // The grant read runs beside the case rows; a case is returned only once it is allowed and recorded.
        const allowed = await identity.authorizeCases({ operation: 'read', caseIds: rows.then((r) => r.map((c) => c.caseId)) });
        return freeze((await rows).filter((c) => allowed.has(c.caseId)));
      }
      const out: C.CaseInfo[] = [];
      for (const c of await rows) {
        try { await identity.authorize({ caseId: c.caseId, operation: 'read' }); out.push(c); }
        catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'forbidden')) throw e; }
      }
      return freeze(out);
    },
    async getCase(scope) { const s = await guard(scope); return freeze(await caseRow(s.db, scope.caseId)); },
    async getVersion(q) {
      const s = await open();
      await identity.checkRevocation();
      // An unknown version answers as a version the caller may not read, so the answer does not tell the two apart.
      const caseId = await caseOfVersion(s.db, q.resultsVersion);
      if (!caseId) throw contractError('forbidden');
      await version({ caseId, resultsVersion: q.resultsVersion });
      return release(s, { caseId, resultsVersion: q.resultsVersion }, freeze(await versionInfo(s.db, q.resultsVersion)));
    },
    async versionsOf(scope) { const rv = await store.activeVersionId(scope); const v = rv ? await store.getVersion({ resultsVersion: rv }) : null; return v ? [v] : []; },
    async verifyVersion(scope) {
      const s = await version(scope), started = Date.now();
      const done = (ok: boolean, reason: string | null, checked?: Record<string, number>) => release(s, scope, { ok, ms: Date.now() - started, ...(reason ? { reason } : {}), ...(checked ? { checked } : {}) });
      const v = await s.db.prepare('SELECT manifest_sha256, read_model_sha256 FROM rs_results_version WHERE version_id = ?').bind(scope.resultsVersion).first<{ manifest_sha256: string; read_model_sha256: string }>().catch(unavailable);
      if (!v) return done(false, 'integrity');
      // D1 only so far: the stored model (counts and digest), its claims about originals, and the package file rows. A model
      // that does not load fails here, before any object is read.
      let loaded: LoadedModel;
      try { loaded = await model(s, scope.resultsVersion); } catch (e) { if (codeOf(e) === 'integrity') return done(false, 'integrity'); throw e; }
      const claims = originalClaims(loaded.assets);
      if (!claims) return done(false, 'integrity');
      const rows = (await fileRows(s, scope.resultsVersion)).results;
      // The work is planned and admitted before any R2 read: every package file and each distinct claimed original, against the
      // per-call bounds and the case's atomic work window. A refused plan reads nothing and reports no verdict on the bytes.
      const originals = new Map(claims.map((c) => [c.sha256, c.size]));
      const plan = { objects: rows.length + originals.size, bytes: rows.reduce((n, f) => n + f.size, 0) + [...originals.values()].reduce((n, x) => n + x, 0) };
      const admitted = await admitVerification(s, scope.caseId, plan, a.now().getTime());
      if (admitted !== 'admitted') return done(false, admitted, plan);
      const files = new Map<string, Uint8Array>();
      for (const f of rows) {
        try { files.set(f.path, await file(s, scope, f)); } catch (e) { if (e instanceof Error && 'code' in e && e.code === 'integrity') return done(false, 'integrity', plan); throw e; }
      }
      if (!verifyCandidateBytes(files, { resultsVersion: scope.resultsVersion, manifestSha256: v.manifest_sha256 }).ok) return done(false, 'integrity', plan);
      // The authoritative check: the rows in D1 are the read model of these package bytes. Rows rewritten together with the stored
      // digest pass the load check above; they do not pass this one. Every original the stored model calls verified must still be
      // a finalized original of this case with those bytes, hashed now (an original that was unavailable stays as stored). The
      // model is then derived from the bytes under exactly those facts.
      const prepared = preparePackage(files);
      if (!prepared.ok) return done(false, 'integrity', plan);
      const facts = await checkClaims(s, scope.caseId, prepared.fileAssets, claims);
      if (!facts) return done(false, 'integrity', plan);
      const derived = prepared.project(facts);
      const ok = derived.ok && (await readModelDigest(derived.projection)) === v.read_model_sha256;
      return done(ok, ok ? null : 'integrity', plan);
    },
    async activeVersionId(scope) {
      const s = await guard(scope);
      const c = await caseRow(s.db, scope.caseId);
      await identity.authorize({ ...scope, operation: 'read' }); // authority read again after the read
      return c?.publication.kind === 'published' ? c.publication.resultsVersion : null;
    },
    async previousVersion(scope) {
      const s = await guard(scope);
      const r = await s.db.prepare(`SELECT p.previous_version_id AS v FROM rs_publication p JOIN rs_results_version v ON v.version_id = p.previous_version_id AND v.case_id = p.case_id AND v.state = 'stored'
        WHERE p.case_id = ? AND NOT EXISTS (SELECT 1 FROM rs_version_withdrawal w WHERE w.version_id = p.previous_version_id)`).bind(scope.caseId).first<{ v: string }>().catch(unavailable);
      return r ? (r.v as C.ResultsVersion) : null;
    },
    async trustedFor(scope) {
      const s = await guard(scope);
      const { results } = await s.db.prepare('SELECT fingerprint FROM rs_trusted_fingerprint WHERE case_id = ?').bind(scope.caseId).all<{ fingerprint: string }>().catch(unavailable);
      return new Set(results.map((r) => r.fingerprint));
    },
    async stateRevision(scope) { await guard(scope); return a.stateRevision(scope); },
    async packageFile(q) {
      const s = await version(q);
      const f = await s.db.prepare('SELECT path, sha256, size, object_key FROM rs_package_file WHERE version_id = ? AND path = ?').bind(q.resultsVersion, q.path).first<FileRow>().catch(unavailable);
      return f ? release(s, q, await file(s, q, f)) : null;
    },
    async packageFilePaths(scope) { const s = await version(scope); return release(s, scope, (await fileRows(s, scope.resultsVersion)).results.map((f) => f.path)); },
    async datasetOf(q) {
      const bytes = await store.packageFile({ ...q, path: `datasets/${q.key}.json` });
      if (!bytes) return null;
      try {
        const envelope = parseStrictJson(decodeUtf8Strict(bytes));
        return envelope && typeof envelope === 'object' && !Array.isArray(envelope) && envelope.key === q.key && typeof envelope.schema === 'string' && KNOWN_SCHEMAS.has(envelope.schema) && 'data' in envelope ? freeze(envelope.data!) : null;
      } catch { throw contractError('invalid-package'); }
    },
    async datasetKeys(scope) { return (await store.packageFilePaths(scope)).filter((p) => /^datasets\/[a-z0-9-]+\.json$/.test(p)).map((p) => p.slice(9, -5)); },
    async viewContentOf(scope) { return readViewContent(await store.datasetOf({ ...scope, key: 'view-content' })); },
    async seeds(scope) {
      const s = await version(scope);
      const { seeds: results } = await model(s, scope.resultsVersion);
      return release(s, scope, freeze(results.map((r) => ({ datasetKey: r.dataset_key, seedId: r.seed_id, seedSha256: r.seed_sha256, record: JSON.parse(r.record_json) }))));
    },
    async documentRows(scope) { const { rows, failed, dropped } = await collect(scope); return { rows, failed, dropped }; },
    async documentRow(q) {
      if (providers.size) return (await collect(q)).rows.find((d) => d.ref === q.ref) ?? null;
      // One stored row by its key, not the version's whole read model: a note's anchor needs only this document. The
      // version's rows were checked when it was stored (sprint decision of 28 October), so no per-request digest. The
      // publication is checked once, after the read, by release(): its fence decides what an awaited read hands back,
      // a null answer included, so a withdrawal during the read releases nothing.
      const s = await guard(q);
      const key = `${q.resultsVersion}\u0000${q.ref}`;
      let d = docs.get(key);
      if (!d) { d = s.db.prepare('SELECT ref, ord, row_json, state_json, list_json FROM rs_document WHERE version_id = ? AND ref = ?').bind(q.resultsVersion, q.ref).first<DocRow>().catch(unavailable); docs.set(key, d); d.catch(() => docs.delete(key)); }
      const row = await d;
      return release(s, q, row ? freeze<C.DocumentRow>({ ref: row.ref, ord: row.ord, source: 'results', row: JSON.parse(row.row_json), list: JSON.parse(row.list_json), state: JSON.parse(row.state_json) }) : null);
    },
    async documentCounts(scope) { const d = await collect(scope), imported = d.rows.filter((r) => r.source === 'results').length; return { total: d.rows.length, imported, provided: d.rows.length - imported, failed: d.failed }; },
    async existingRefs(q) { return new Set((await collect(q)).rows.filter((r) => q.refs.includes(r.ref)).map((r) => r.ref)); },
    async childDocuments(q) { return (await collect(q)).rows.filter((r) => r.list.parentRef === q.ref); },
    async fingerprints(scope) { return (await collect(scope)).rows.flatMap((d) => d.state.original ? [{ ref: d.ref, sha256: sha256(d.state.original.sha256) }] : []); },
    async anyDateBasis(scope) { return (await collect(scope)).rows.some((d) => d.list.dateType !== null || d.list.dateSource !== null); },
    async listJson(scope) {
      const d = await collect(scope);
      return { json: JSON.stringify(d.rows.map((r) => r.list)), etag: `"${scope.caseId}:${scope.resultsVersion}:${d.revisions.join(';')}"`, failed: d.failed };
    },
    async activeDocumentRows(scope) { const rv = await store.activeVersionId(scope); return rv ? { resultsVersion: rv, ...await store.documentRows({ ...scope, resultsVersion: rv }) } : { resultsVersion: null, rows: [], failed: [], dropped: [] }; },
    async publication(scope) { const s = await guard(scope); return freeze(await publicationRow(s.db, scope.caseId)); },
    providers: {
      register(p) { if (!/^[a-z][a-z0-9-]{0,31}$/.test(p.id) || providers.has(p.id)) throw contractError('invalid-package'); providers.set(p.id, p); return () => { if (providers.get(p.id) === p) providers.delete(p.id); }; },
      list: () => [...providers.values()].map(({ id, owner }) => ({ id, owner })),
    },
  };
  return store;
}
