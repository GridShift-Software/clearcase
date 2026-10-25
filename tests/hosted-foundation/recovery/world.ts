// Synthetic world for the recovery tests: stand-ins for the injected ports. They prove unit semantics only, never a real provider.
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import type { AssetRef, AuditEvent, CaseId, CaseRevision, ClientId, Identity, ResultsVersion, UserWorkExport, VersionInfo, Written } from '../../../src/lib/server/runtime/contracts.ts';
import { sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
import type { PrivateObjectPort, RecoveryDeps } from '../../../src/lib/recovery/hosted/index.ts';
import type { RestoreDeps, RestoreTarget } from '../../../src/lib/recovery/hosted/index.ts';

export const enc = (s: string) => new TextEncoder().encode(s);
export const CLIENT = 'client-a' as ClientId, CASE = 'case-1' as CaseId, RV = ('sha256:' + 'a'.repeat(64)) as ResultsVersion, SESSION = 'session-secret-token-abc';
export class MemObjects implements PrivateObjectPort {
  kind: PrivateObjectPort['kind'] = 'test-standin'; map = new Map<string, Uint8Array>(); gets: string[] = []; puts: string[] = []; failPutAt: number | null = null;
  async putIfAbsent(a: { key: string; bytes: Uint8Array }) {
    if (this.failPutAt !== null && this.puts.length >= this.failPutAt) throw new Error('boom');
    if (this.map.has(a.key)) return { kind: 'exists' as const };
    this.puts.push(a.key); this.map.set(a.key, new Uint8Array(a.bytes)); return { kind: 'created' as const };
  }
  async get(key: string) { this.gets.push(key); const b = this.map.get(key); return b ? new Uint8Array(b) : null; }
}
export interface Knobs { revoked: boolean; denyWith: string | null; auditDown: boolean; revision: string; tamper: null | 'bytes' | 'size' | 'missing'; embedded: boolean }
export function world(over: Partial<{ clientId: ClientId; published: boolean; userRows: number }> = {}) {
  const k: Knobs = { revoked: false, denyWith: null, auditDown: false, revision: 'rev-1', tamper: null, embedded: false };
  const calls = { authorize: 0, checkRevocation: 0, originalsGet: 0, store: 0, packageFile: 0, exportAll: 0, audit: [] as AuditEvent[] };
  const clientId = over.clientId ?? CLIENT;
  const originals = new Map([['orig-1', enc('original bytes one')], ['orig-2', enc('second original')], ['orig-dup', enc('original bytes one')]]);
  const previews = new Map([['prev-1', enc('preview of one')]]);
  const files = new Map([['manifest.json', enc('{"synthetic":true}')], ['datasets/docs.json', enc('[1,2,3]')]]);
  const identity: Identity = {
    kind: 'verified', principal: { issuer: 'https://issuer.test', subject: 'user-1', kind: 'client' }, sessionId: SESSION as never, clientId,
    async checkRevocation() { calls.checkRevocation++; if (k.revoked) throw contractError('invalid-session'); },
    async authorize() { calls.authorize++; if (k.denyWith) throw contractError(k.denyWith); },
  } as unknown as Identity;
  const version = { id: RV, case_id: CASE, case_label: 'Synthetic', input_revision_id: 'rev-in-1', created: '2026-10-01T00:00:00Z', import_id: 1, verdict: 'ok', stored_at: '2026-10-01T00:00:01Z', manifest_sha256: 'b'.repeat(64), diagnostics_sha256: 'c'.repeat(64), validator_version: 'v1', warning_fingerprints: '[]', expect: '{}', read_model_sha256: 'd'.repeat(64), overview: '{}' } as unknown as VersionInfo;
  const store = {
    async getCase() { calls.store++; return { caseId: CASE, caseLabel: 'Synthetic', publication: over.published === false ? { kind: 'none' as const } : { kind: 'published' as const, resultsVersion: RV }, href: '/c', documents: 1 }; },
    async versionsOf() { return [version]; }, async activeVersionId() { return RV; },
    async stateRevision() { calls.store++; const r = k.revision as CaseRevision; return r; },
    async verifyVersion() { return { ok: true, ms: 0 }; },
    async packageFilePaths() { return [...files.keys()]; },
    async packageFile(a: { path: string }) { calls.packageFile++; return files.get(a.path) ?? null; },
  };
  const meta = async (b: Uint8Array, name: string) => ({ size: b.length, sha256: await sha256Hex(b) as never, mediaType: 'application/octet-stream', filename: name, objectVersion: 'v1', etag: '"e"' });
  const assets = {
    async originals() { return [...originals].map(([assetId, b]) => ({ assetId, filename: assetId + '.bin', mediaType: 'application/octet-stream', size: b.length })); },
    async availability({ asset }: { asset: AssetRef }) {
      if (k.embedded && asset.assetId === 'orig-2') return { kind: 'unavailable' as const, reason: 'embedded' as const, parent: null };
      if (k.tamper === 'missing' && asset.assetId === 'orig-1') return { kind: 'unavailable' as const, reason: 'missing' as const, parent: null };
      const b = (asset.kind === 'original' ? originals : previews).get(asset.assetId)!; return { kind: 'available' as const, metadata: await meta(b, asset.assetId) };
    },
    async get({ asset }: { asset: AssetRef }) {
      calls.originalsGet++;
      const b = new Uint8Array((asset.kind === 'original' ? originals : previews).get(asset.assetId)!);
      if (k.tamper === 'bytes' && asset.assetId === 'orig-1') b[0] ^= 1;
      const out = k.tamper === 'size' && asset.assetId === 'orig-1' ? b.slice(0, b.length - 1) : b;
      return new Response(out as BodyInit, { status: 200 });
    },
  };
  const previewCatalog = { async previewsOf() { return [{ assetId: 'prev-1', filename: 'prev-1.pdf', mediaType: 'application/pdf', size: previews.get('prev-1')!.length }]; } };
  const userExport: UserWorkExport = { format: 'clearcase.user-work/1', exportedAt: '2026-10-02T00:00:00Z', tables: [{ name: 'notes', kind: 'user-work', scope: 'case', owner: 'notes', description: 'n', columns: [], rows: Array.from({ length: over.userRows ?? 2 }, (_, i) => ({ id: `n${i}`, body: `note ${i}` })) }] };
  const userWork = { async exportAll() { calls.exportAll++; return structuredClone(userExport); } };
  const audit = { async append(e: AuditEvent) { if (k.auditDown) throw new Error('down'); calls.audit.push(e); return { eventId: e.eventId }; } };
  let n = 0;
  const objects = new MemObjects();
  const deps: RecoveryDeps = { profile: 'hosted-gate', now: () => new Date('2026-10-25T00:00:00Z'), newId: () => `ev-${++n}`, identity, store: store as never, assets: assets as never, previews: previewCatalog, userWork, audit, objects };
  return { k, calls, deps, objects, originals, previews, files, userExport, version, identity };
}

export function target(over: { objects?: MemObjects; isolationId?: string; clientId?: ClientId; seedRows?: number } = {}) {
  const log: string[] = []; let revision = 'trev-1'; const snaps = new Map<string, UserWorkExport>();
  let rows = over.seedRows ?? 0; const imports: unknown[] = []; let importResult: 'ok' | 'stale' | 'gone' = 'ok';
  const objects = over.objects ?? new MemObjects();
  const empty = (): UserWorkExport => ({ format: 'clearcase.user-work/1', exportedAt: 'x', tables: [{ name: 'notes', kind: 'user-work', scope: 'case', owner: 'notes', description: '', columns: [], rows: Array.from({ length: rows }, (_, i) => ({ id: `t${i}` })) }] });
  const userWork = {
    async exportAll() { return empty(); },
    snapshots: { async put(a: { snapshot: UserWorkExport }) { log.push('snapshot'); snaps.set('snap-1', a.snapshot); return 'snap-1' as never; }, async get() { return null; } },
    async importAll(a: { snapshot: UserWorkExport; expectedRevision: string }): Promise<Written<never>> {
      log.push('import'); imports.push(a);
      if (importResult === 'stale') return { kind: 'stale' };
      if (importResult === 'gone') return { kind: 'gone' };
      const tables = a.snapshot.tables, r = tables.reduce((x, t) => x + t.rows.length, 0); rows = r; revision = 'trev-2';
      return { kind: 'written', value: { tables: tables.length, rows: r, cases: [CASE], restored: tables.map((t) => ({ name: t.name, scope: t.scope, action: 'replaced-for-cases', rows: t.rows.length, deleted: 0, inserted: t.rows.length })) } as never, version: 'v' as never, caseRevision: revision as never };
    },
  };
  const t: RestoreTarget = { isolationId: over.isolationId ?? 'isolated-restore-1', clientId: over.clientId ?? CLIENT, caseId: 'case-restore-1' as CaseId, objects, userWork: userWork as never, async stateRevision() { return revision as CaseRevision; } };
  return { t, log, objects, snaps, imports, bump: () => { revision = 'trev-9'; }, setImport: (r: 'ok' | 'stale' | 'gone') => { importResult = r; } };
}
export function restoreDeps(w: ReturnType<typeof world>, t: RestoreTarget | null): RestoreDeps { return { ...w.deps, liveIsolationId: 'live-client-a', target: t }; }
export const lookup = (o: MemObjects, part: string) => [...o.map.keys()].filter((k) => k.includes(part));
