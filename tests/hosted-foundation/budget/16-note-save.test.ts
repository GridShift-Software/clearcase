// The document page's note save and delete through the real hostedServices composition (GRS-261): count every D1 round
// trip the form POST makes, authorization and audit included. Synthetic SQLite doubles, not a deployed Worker; a count
// is a round trip, which costs tens of ms from the London placement, so these ceilings only go down.
import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: {} }));
import { readFileSync } from 'node:fs';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { mintAppSession, signAppSession } from '../../../src/lib/auth/app-session.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { actions } from '../../../deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts';
import { exampleInput } from '../native-runtime-config/example-input.ts';
import { runtimeEnv, instances } from '../native-runtime-config/harness.ts';
import { hostedWorld, countedD1, measure } from './harness.ts';
import { MIGRATION } from '../provisioning/world.ts';

/** The save's D1 round trips, measured 59 on the preview before GRS-261 (ten authorizations and a read-model load). */
const SAVE_D1 = 20;
const DELETE_D1 = 14;

async function world() {
  const w = await hostedWorld();
  w.db.sqlite.exec(MIGRATION);
  w.db.sqlite.exec(readFileSync('src/lib/audit/migrations/0001_native_audit.sql', 'utf8'));
  w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0006_shard_publication.sql', 'utf8'));
  w.db.sqlite.exec(readFileSync('src/lib/publication/hosted/migrations/0007_shard_admission.sql', 'utf8'));
  const rv = w.resultsVersion!;
  const ref = w.db.rows<{ ref: string }>("SELECT ref FROM rs_document WHERE version_id = ? AND json_extract(state_json, '$.original.sha256') IS NOT NULL ORDER BY ord LIMIT 1", rv)[0]!.ref;
  w.db.exec('INSERT INTO rs_shard_manifest (version_id, prefix, manifest_sha256, built_at, admitted_json) VALUES (?, ?, ?, ?, ?)',
    rv, `views/${rv.slice(7)}/`, 'b'.repeat(64), '2001-01-01T00:00:00.000Z', JSON.stringify({ [`doc/${ref}.json`]: 100 }));
  const file = planNativeRuntimeConfig(exampleInput()).clients.find(c => c.clientId === 'client-a')!;
  const db = countedD1(w.db, w.counters), pending: Promise<void>[] = [];
  const env = runtimeEnv(file, { DB: Object.assign(db, { withSession: () => db }), BUCKET: w.bucket,
    CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => null, put: async () => {} } });
  const issuer = instances['client-a'].iss, origin = 'https://client-a.clearcase.test';
  const config = { key: 'a'.repeat(64), clientId: 'client-a', issuer, origin, sessions: { get: async () => null, put: async () => {} } };
  const session = await mintAppSession(config, { sid: 'synthetic-save-session', subject: 'save-editor', name: 'Synthetic Editor' });
  const cookie = `clearcase_session=${await signAppSession(config, session)}`;
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at) VALUES ('save-grant','client-a','case','case-a',?,'save-editor','client','editor','content','active',1,'seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, issuer);
  const native = JSON.parse(String(env.CLEARCASE_NATIVE_CONFIG));
  await provisionAuditBinding({ db, config: auditConfig({ clientId: id('client', 'client-a'), trustedIssuers: [issuer, instances.staff.iss], limits: native.auditLimits }), now: () => new Date() });
  const params = { caseId: 'case-a', version: rv, ref };
  /** One form POST to the document page: the request's services, then the named action, as SvelteKit runs them. */
  const post = async (action: 'note' | 'delnote', fields: Record<string, string>) => {
    const url = `${origin}/cases/case-a/v/${encodeURIComponent(rv)}/doc/${encodeURIComponent(ref)}?/${action}`;
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const request = new Request(url, { method: 'POST', headers: { cookie, origin }, body: form });
    const ready = await hostedServices(request, env, { waitUntil: p => pending.push(p) });
    expect(ready.ready).toBe(true);
    return actions[action]!({ locals: ready.services, params, request, url: new URL(url) } as never);
  };
  return { ...w, pending, post, async cleanup() { await Promise.all(pending); w.db.sqlite.close(); } };
}

it('16 a note save from the document page stays within its D1 round-trip ceiling, audited in its batch', async () => {
  const w = await world();
  try {
    const saved = await measure(w.counters, () => w.post('note', { body: 'Synthetic budget note', operationId: 'save-budget' }));
    expect(saved.thrown).toBeUndefined(); expect(saved.value).toEqual({ saved: true });
    console.log('16 note save D1 round trips', saved.counts);
    expect(saved.counts.d1).toBeLessThanOrEqual(SAVE_D1); expect(saved.counts.clerk).toBe(0); expect(saved.counts.otherFetch).toBe(0);
    await Promise.all(w.pending);
    const actions = w.db.rows<{ action: string }>('SELECT action FROM native_audit_events').map(e => e.action);
    expect(actions).toContain('user-work.note-add'); expect(actions).toContain('case.write-user-work');
    expect(w.db.rows('SELECT body FROM uw_note')).toEqual([{ body: 'Synthetic budget note' }]);
  } finally { await w.cleanup(); }
});

it('16 a note delete from the document page stays within its D1 round-trip ceiling, and a stale delete is refused', async () => {
  const w = await world();
  try {
    expect(await w.post('note', { body: 'Synthetic note to delete', operationId: 'delete-budget-add' })).toEqual({ saved: true });
    const note = w.db.rows<{ note_id: string; version: string }>('SELECT note_id, version FROM uw_note')[0]!;
    const deleted = await measure(w.counters, () => w.post('delnote', { id: note.note_id, version: note.version, operationId: 'delete-budget' }));
    expect(deleted.thrown).toBeUndefined(); expect(deleted.value).toEqual({ deleted: true });
    console.log('16 note delete D1 round trips', deleted.counts);
    expect(deleted.counts.d1).toBeLessThanOrEqual(DELETE_D1); expect(deleted.counts.clerk).toBe(0);
    expect(w.db.rows('SELECT note_id FROM uw_note')).toEqual([]);
    // The same delete from a second tab, with another operation id, finds the note gone.
    const stale = await w.post('delnote', { id: note.note_id, version: note.version, operationId: 'delete-budget-stale' });
    expect(stale).toMatchObject({ status: 409, data: { gone: true } });
  } finally { await w.cleanup(); }
});
