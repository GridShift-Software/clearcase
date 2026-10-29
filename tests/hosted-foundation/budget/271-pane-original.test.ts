// The chronology pane's original through the real hostedServices composition (GRS-271). The pane asks for a document's
// original by a POST under /cases/<id>/v/, and since GRS-261 such a POST reads the case through the request's one lookup
// (09b's snapshot). That snapshot must carry the pane's original, or every pane says "This original is no longer
// available" while the viewer page shows the same original. A real gone original must still say so. Synthetic SQLite and
// R2 doubles, with the asset-ticket key set as on staging (it turns on the fast original path the snapshot serves).
import { expect, it, vi } from 'vitest';
const TICKET_KEY = vi.hoisted(() => 'k'.repeat(64));
vi.mock('cloudflare:workers', () => ({ env: { CLEARCASE_ASSET_TICKET_KEY: TICKET_KEY } }));
import { readFileSync } from 'node:fs';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { mintAppSession, signAppSession } from '../../../src/lib/auth/app-session.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { shardPrefix } from '../../../src/lib/results/hosted/shards.ts';
import { verifyTicket } from '../../../src/lib/viewer/hosted/ticket.ts';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import * as paneOriginal from '../../../deploy/client/routes/cases/[caseId]/v/[version]/chronology/original/[ref]/+server.ts';
import { exampleInput } from '../native-runtime-config/example-input.ts';
import { runtimeEnv, instances } from '../native-runtime-config/harness.ts';
import { hostedWorld } from './harness.ts';
import { MIGRATION } from '../provisioning/world.ts';

const POST = (paneOriginal as unknown as { POST: (e: never) => Promise<Response> }).POST;

async function world() {
  const w = await hostedWorld();
  w.db.sqlite.exec(MIGRATION);
  w.db.sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
  w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0006_shard_publication.sql', 'utf8'));
  w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0007_shard_admission.sql', 'utf8'));
  const rv = w.resultsVersion!;
  const refs = w.db.rows<{ ref: string }>("SELECT ref FROM rs_document WHERE version_id = ? AND json_extract(state_json, '$.original.sha256') IS NOT NULL ORDER BY ord LIMIT 2", rv).map((r) => r.ref);
  // The ETag and media family intake records (GRS-250), which the original-serving route reads instead of probing the bytes.
  w.db.exec("UPDATE rs_original SET etag = '\"synthetic-etag\"', media_family = 'pdf' WHERE etag IS NULL");
  // The chronology's one list page, admitted by the publication: the pane endpoint finds the document's row there.
  const page = new TextEncoder().encode(JSON.stringify({ page: 1, pages: 1, total: refs.length, rows: refs.map((ref) => ({ ref, file: 'present' })) }));
  w.bucket.setRaw(`${shardPrefix(rv)}list/page-1.json`, page);
  w.db.exec('INSERT INTO rs_shard_manifest (version_id, prefix, manifest_sha256, built_at, admitted_json) VALUES (?, ?, ?, ?, ?)',
    rv, shardPrefix(rv), 'b'.repeat(64), '2001-01-01T00:00:00.000Z', JSON.stringify({ 'list/page-1.json': page.byteLength }));
  const file = planNativeRuntimeConfig(exampleInput()).clients.find((c) => c.clientId === 'client-a')!;
  const db = w.db, pending: Promise<void>[] = [];
  const env = runtimeEnv(file, { DB: Object.assign(db, { withSession: () => db }), BUCKET: w.bucket,
    CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => null, put: async () => {} } });
  const issuer = instances['client-a'].iss, origin = 'https://client-a.clearcase.test';
  const config = { key: 'a'.repeat(64), clientId: 'client-a', issuer, origin, sessions: { get: async () => null, put: async () => {} } };
  const session = await mintAppSession(config, { sid: 'synthetic-pane-session', subject: 'pane-viewer', name: 'Synthetic Viewer' });
  const cookie = `__Host-clearcase_session=${await signAppSession(config, session)}`;
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('pane-grant','client-a','case','case-a',?,'pane-viewer','client','viewer','content','active',1,'seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, issuer);
  const native = JSON.parse(String(env.CLEARCASE_NATIVE_CONFIG));
  await provisionAuditBinding({ db, config: auditConfig({ clientId: id('client', 'client-a'), trustedIssuers: [issuer, instances.staff.iss], limits: native.auditLimits }), now: () => new Date() });
  /** One pane open: the request's services, then the endpoint, as SvelteKit runs them for the pane's POST. */
  const open = async (ref: string) => {
    const url = `${origin}/cases/case-a/v/${encodeURIComponent(rv)}/chronology/original/${encodeURIComponent(ref)}`;
    const request = new Request(url, { method: 'POST', headers: { cookie, origin } });
    const ready = await hostedServices(request, env, { waitUntil: (p) => pending.push(p) });
    expect(ready.ready).toBe(true);
    const r = await POST({ locals: ready.services, params: { caseId: 'case-a', version: rv, ref }, request, url: new URL(url) } as never);
    return (await r.json()) as { view: { state: string; reason?: string; mode?: string; srcHref?: string } };
  };
  return { ...w, refs, open, async cleanup() { await Promise.all(pending); w.db.sqlite.close(); } };
}

it("271 the pane's POST shows a present original as available, through the request's one lookup", async () => {
  const w = await world();
  try {
    const [ref] = w.refs;
    const { view } = await w.open(ref!);
    expect(view).toMatchObject({ state: 'available', mode: 'pdf' });
    expect(view.srcHref).toMatch(new RegExp(`^/cases/case-a/originals/${ref}\\?t=`));
    // The ticket is one the byte route accepts for this case and asset, and only for them.
    const ticket = new URL(view.srcHref!, 'https://client-a.clearcase.test').searchParams.get('t')!;
    expect(await verifyTicket(ticket, TICKET_KEY, 'case-a', ref!)).toMatchObject({ caseId: 'case-a', assetId: ref, mediaType: 'application/pdf', mediaFamily: 'pdf', subject: 'pane-viewer' });
    expect(await verifyTicket(ticket, TICKET_KEY, 'case-b', ref!)).toBeNull();
    expect(await verifyTicket(ticket, TICKET_KEY, 'case-a', w.refs[1]!)).toBeNull();
  } finally { await w.cleanup(); }
});

it('271 a gone original still shows the pane as missing', async () => {
  const w = await world();
  try {
    const gone = w.refs[1]!;
    w.db.exec("DELETE FROM rs_case_original WHERE case_id = 'case-a' AND asset_id = ?", gone);
    expect((await w.open(gone)).view).toEqual({ state: 'unavailable', reason: 'missing', filename: null });
    expect((await w.open(w.refs[0]!)).view).toMatchObject({ state: 'available' });
  } finally { await w.cleanup(); }
});
