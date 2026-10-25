// UNIT TEST WORLD ONLY. The real createCloudResults (verified reads, ranges, authority, audit) runs over the storage
// unit doubles (SQLite-backed D1, in-memory R2) the storage tests already use. Nothing here is Cloudflare D1/R2, a real
// identity provider or a browser, so a pass is component evidence, never a hosted or native PASS. Synthetic bytes only.
import { isHttpError } from '@sveltejs/kit';
import * as original from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/+server.ts';
import { createCloudResults, type StorageEvent } from '../../../src/lib/results/hosted/index.ts';
import { createOriginalIntake } from '../../../src/lib/storage/cloud/intake.ts';
import { createResultsStaging } from '../../../src/lib/storage/cloud/staging.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import type { AssetsAccess, CaseRevision } from '../../../src/lib/server/runtime/contracts.ts';
import { BUDGETS, QUOTAS, deployment, grantedIdentity, ids, publish, shaOf, syntheticPackage, withdraw } from '../../hosted-foundation/storage/fixture.ts';

export { ids, publish, withdraw, shaOf, syntheticPackage };
export const ORIGIN = 'https://client-a.clearcase.test';
export const utf8 = (s: string) => new TextEncoder().encode(s);
/** A synthetic PDF long enough to range over: fixed filler, no case content. */
export const bigPdf = (tag: string, n = 4000) => utf8(`%PDF-1.4\n% SYNTHETIC ONLY ${tag}\n${'0123456789abcdef'.repeat(Math.ceil(n / 16)).slice(0, n)}\n%%EOF\n`);
export const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]);
export const html = () => utf8('<!doctype html><script>fetch("/x")</script>');

export function world(a: { grants?: string[] } = {}) {
  const dep = deployment('client-a', ['case-a', 'case-b']);
  const who = grantedIdentity(ids.clientA, a.grants ?? ['case-a']);
  const events: StorageEvent[] = [];
  const bindings = { db: dep.db, bucket: dep.bucket };
  const now = () => new Date('2026-10-25T00:00:00Z');
  const results = createCloudResults({
    bindings, clientId: ids.clientA, budgets: BUDGETS, identity: who.identity,
    record: async (e) => { events.push(e); },
    stateRevision: async () => id('case-revision', 'rev-1') as CaseRevision,
  });
  const writer = { bindings, clientId: ids.clientA, budgets: BUDGETS, now, quotas: QUOTAS, authorize: async () => {} };
  const intake = createOriginalIntake(writer as never);
  const staging = createResultsStaging(writer as never);
  async function upload(caseId: string, assetId: string, bytes: Uint8Array, o: { filename?: string; mediaType?: string } = {}) {
    const operationId = `op-${caseId}-${assetId}`, c = id('case', caseId);
    const decl = { caseId: c, operationId, assetId, filename: o.filename ?? `${assetId}.pdf`, mediaType: o.mediaType ?? 'application/pdf', size: bytes.byteLength, sha256: shaOf(bytes) };
    const steps = [await intake.declare(decl), await intake.put({ caseId: c, operationId, bytes }), await intake.finalize({ caseId: c, operationId })];
    if (steps.some((s) => s.kind === 'refused')) throw new Error(`fixture upload refused: ${JSON.stringify(steps)}`);
  }
  return { ...dep, ...results, who, events, upload, staging, bindings };
}
export type World = ReturnType<typeof world>;

type Headers_ = Record<string, string>;
export const fetchDest = (dest: string): Headers_ => ({ 'sec-fetch-dest': dest });
/** Calls the real route module the way SvelteKit does and answers refusals (thrown kit errors) as the response they become. */
export async function call(mod: { GET: (e: never) => unknown; HEAD: (e: never) => unknown }, method: 'GET' | 'HEAD', path: string, params: Record<string, string>, o: { assets: AssetsAccess; headers?: Headers_ }): Promise<Response> {
  const url = new URL(path, ORIGIN);
  const request = new Request(url, { method, headers: o.headers ?? {} });
  try { return (await (mod[method] as (e: never) => Promise<Response>)({ request, url, params, locals: { assets: o.assets }, platform: undefined } as never)); }
  catch (e) {
    if (isHttpError(e)) return new Response(JSON.stringify(e.body), { status: e.status });
    throw e;
  }
}
export const getOriginal = (w: { assets: AssetsAccess }, caseId: string, assetId: string, o: { query?: string; headers?: Headers_; method?: 'GET' | 'HEAD'; assets?: AssetsAccess } = {}) =>
  call(original, o.method ?? 'GET', `/cases/${caseId}/originals/${assetId}${o.query ?? ''}`, { caseId, assetId }, { assets: o.assets ?? w.assets, headers: o.headers ?? {} });
