import type * as C from './contracts.ts';
import type { MemoryContext, MemoryVersion } from './memory.ts';
import { copy, digest, freeze } from './data.ts';
import { contractError } from './errors.ts';
import { parseStrictJson, decodeUtf8Strict } from '../../case-package/strict-json.ts';
import { KNOWN_SCHEMAS } from '../../case-package/registry.ts';
import { readViewContent } from '../../case-package/view-content.ts';
import { sha256 } from './ids.ts';
import { providerProblem, validOriginal } from './provider-row.ts';

export function createMemoryReader(ctx: MemoryContext): C.CaseReader {
  const providers = new Map<string, C.DocumentProvider>();
  const guard = async (scope: C.Scope) => { await ctx.before('read'); await ctx.identity.authorize({ ...scope, operation: 'read' }); };
  async function version(scope: C.VersionScope): Promise<MemoryVersion> {
    await guard(scope);
    const c = ctx.client.cases.find((c) => c.caseId === scope.caseId), v = ctx.client.versions.find((v) => v.info.id === scope.resultsVersion);
    if (!v || v.info.case_id !== scope.caseId || c?.publication.kind !== 'published' || c.publication.resultsVersion !== scope.resultsVersion) throw contractError('forbidden');
    return v;
  }
  async function collect(scope: C.VersionScope) {
    const v = await version(scope), rows = copy(v.rows), failed: C.DocumentRowsResult['failed'] = [], dropped: C.DocumentRowsResult['dropped'] = [], revisions: string[] = [];
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
    await ctx.identity.authorize({ ...scope, operation: 'read' });
    return { rows: freeze(rows), failed, dropped, revisions };
  }
  const store: C.CaseReader = {
    async listCases() {
      await ctx.before('read'); await ctx.identity.checkRevocation();
      const out: C.CaseInfo[] = [];
      for (const c of ctx.client.cases) {
        try { await ctx.identity.authorize({ caseId: c.caseId, operation: 'read' }); out.push(copy(c)); }
        catch (e) { if (!(e instanceof Error && 'code' in e && e.code === 'forbidden')) throw e; }
      }
      return freeze(out);
    },
    async getCase(a) { await guard(a); return freeze(copy(ctx.client.cases.find((c) => c.caseId === a.caseId) ?? null)); },
    async getVersion(a) { await ctx.identity.checkRevocation(); const v = ctx.client.versions.find((v) => v.info.id === a.resultsVersion); return v ? freeze(copy((await version({ caseId: v.info.case_id, ...a })).info)) : null; },
    async versionsOf(a) { await guard(a); const rv = await store.activeVersionId(a); return rv ? [freeze(copy((await version({ ...a, resultsVersion: rv })).info))] : []; },
    async verifyVersion(a) { const v = await version(a); const manifest = v.files.find((f) => f.path === 'manifest.json'); const ok = !!manifest && await digest(manifest.bytes) === v.info.manifest_sha256; return { ok, ms: 0, ...(ok ? {} : { reason: 'integrity' }) }; },
    async activeVersionId(a) { await guard(a); const p = ctx.client.cases.find((c) => c.caseId === a.caseId)?.publication; return p?.kind === 'published' ? p.resultsVersion : null; },
    async previousVersion(a) { await guard(a); return null; },
    async trustedFor(a) { await guard(a); return new Set(); },
    async stateRevision(a) { await guard(a); return ctx.work(a.caseId).revision; },
    async packageFile(a) { const v = await version(a); const f = v.files.find((f) => f.path === a.path); return f ? new Uint8Array(f.bytes) : null; },
    async packageFilePaths(a) { return (await version(a)).files.map((f) => f.path).sort(); },
    async datasetOf(a) {
      const bytes = await store.packageFile({ ...a, path: `datasets/${a.key}.json` });
      if (!bytes) return null;
      try {
        const envelope = parseStrictJson(decodeUtf8Strict(bytes));
        return envelope && typeof envelope === 'object' && !Array.isArray(envelope) && envelope.key === a.key && typeof envelope.schema === 'string' && KNOWN_SCHEMAS.has(envelope.schema) && 'data' in envelope ? freeze(envelope.data!) : null;
      } catch { throw contractError('invalid-package'); }
    },
    async datasetKeys(a) { return (await store.packageFilePaths(a)).filter((p) => /^datasets\/[a-z0-9-]+\.json$/.test(p)).map((p) => p.slice(9, -5)); },
    async viewContentOf(a) { return readViewContent(await store.datasetOf({ ...a, key: 'view-content' })); },
    async seeds(a) { return freeze(copy((await version(a)).seeds)); },
    async documentRows(a) { const { rows, failed, dropped } = await collect(a); return { rows, failed, dropped }; },
    async documentRow(a) { return (await collect(a)).rows.find((d) => d.ref === a.ref) ?? null; },
    async documentCounts(a) { const d = await collect(a), imported = d.rows.filter((r) => r.source === 'results').length; return { total: d.rows.length, imported, provided: d.rows.length - imported, failed: d.failed }; },
    async existingRefs(a) { return new Set((await collect(a)).rows.filter((r) => a.refs.includes(r.ref)).map((r) => r.ref)); },
    async childDocuments(a) { return (await collect(a)).rows.filter((r) => r.list.parentRef === a.ref); },
    async fingerprints(a) { return (await collect(a)).rows.flatMap((d) => d.state.original ? [{ ref: d.ref, sha256: sha256(d.state.original.sha256) }] : []); },
    async anyDateBasis(a) { return (await collect(a)).rows.some((d) => d.list.dateType !== null || d.list.dateSource !== null); },
    async listJson(a) { const d = await collect(a); return { json: JSON.stringify(d.rows.map((r) => r.list)), etag: `"${ctx.client.clientId}:${a.caseId}:${a.resultsVersion}:${d.revisions.join(';')}"`, failed: d.failed }; },
    async activeDocumentRows(a) { const rv = await store.activeVersionId(a); return rv ? { resultsVersion: rv, ...await store.documentRows({ ...a, resultsVersion: rv }) } : { resultsVersion: null, rows: [], failed: [], dropped: [] }; },
    providers: { register(p) { if (!/^[a-z][a-z0-9-]{0,31}$/.test(p.id) || providers.has(p.id)) throw contractError('invalid-package'); providers.set(p.id, p); return () => { if (providers.get(p.id) === p) providers.delete(p.id); }; }, list: () => [...providers.values()].map(({ id, owner }) => ({ id, owner })) },
  };
  return store;
}
