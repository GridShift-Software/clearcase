import { afterEach, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ env: {} }));
import { readFileSync } from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { installNativeCompositions } from '../../../src/lib/server/runtime/hosted/compositions.ts';
import { intakeControllerFor } from '../../../src/lib/submissions/composition.ts';
import { caseActionsFor } from '../../../src/lib/views/hosted/case-actions.ts';
import { mintAppSession, signAppSession } from '../../../src/lib/auth/app-session.ts';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { exampleInput } from '../../hosted-foundation/native-runtime-config/example-input.ts';
import { runtimeEnv, instances } from '../../hosted-foundation/native-runtime-config/harness.ts';
import { hostedWorld, countedD1 } from '../../hosted-foundation/budget/harness.ts';
import { MIGRATION } from '../../hosted-foundation/provisioning/world.ts';
import { provisionIntakeGrant } from '../../../scripts/intake/provision.ts';
import { fileSetDigest } from '../../../src/lib/submissions/file-set.ts';
import { hex, syntheticPdf } from './doubles.ts';

afterEach(() => vi.unstubAllGlobals());

it('19 wires the request-bound action and asynchronous notification through real hostedServices', async () => {
  installNativeCompositions();
  const w = await hostedWorld();
  w.db.sqlite.exec(MIGRATION);
  for (const file of ['tenancy/migrations/0003_tenant_upload_grants.sql', 'audit/migrations/0001_native_audit.sql',
    'publication/hosted/migrations/0006_shard_publication.sql', 'publication/hosted/migrations/0007_shard_admission.sql',
    'submissions/migrations/0003_intake_notification.sql']) {
    w.db.sqlite.exec(readFileSync(new URL(`../../../src/lib/${file}`, import.meta.url), 'utf8'));
  }
  const db = countedD1(w.db, w.counters), pending: Promise<void>[] = [];
  const file = planNativeRuntimeConfig(exampleInput()).clients.find((c) => c.clientId === 'client-a')!;
  const env = runtimeEnv(file, { DB: Object.assign(db, { withSession: () => db }), BUCKET: w.bucket,
    CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => null, put: async () => {} },
    CLEARCASE_INTAKE_WEBHOOK: 'https://webhook.example.invalid/synthetic-secret' });
  const issuer = instances['client-a'].iss, origin = 'https://client-a.clearcase.test';
  const config = { key: 'a'.repeat(64), clientId: 'client-a', issuer, origin, sessions: { get: async () => null, put: async () => {} } };
  const session = await mintAppSession(config, { sid: 'synthetic-intake-session', subject: 'intake-reader', name: 'Synthetic Reader' });
  const cookie = `__Host-clearcase_session=${await signAppSession(config, session)}`;
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id,client_id,scope,case_id,issuer,subject,principal_kind,role,slot,state,version,created_operation_id,request,created_by_issuer,created_by_subject,created_at)
    VALUES ('intake-read','client-a','case','case-a',?,'intake-reader','client','viewer','content','active',1,'seed','[]','seed','seed','2001-01-01T00:00:00.000Z')`, issuer);
  const granted = await provisionIntakeGrant({ db, nativeConfig: String(env.CLEARCASE_NATIVE_CONFIG), caseId: 'case-a', subject: 'intake-reader' });
  expect(granted.kind).toBe('applied');
  const compose = async (path: string, method = 'GET', body?: BodyInit, contentType = 'application/json') => {
    const request = new Request(origin + path, { method, headers: { cookie, origin, 'content-type': contentType }, body });
    const ready = await hostedServices(request, env, { waitUntil: (p) => { pending.push(p); } });
    expect(ready.ready).toBe(true);
    return { request, platform: undefined, url: new URL(request.url), locals: ready.services, params: { caseId: 'case-a' } } as unknown as RequestEvent;
  };
  try {
    const event = await compose('/cases/case-a/v/placeholder/overview');
    await event.locals.identity.authorize({ caseId: w.caseId, operation: 'read' });
    await Promise.all(pending);
    w.counters.reset();
    expect(await caseActionsFor('case-a', event)).toContainEqual({ label: 'Upload documents', href: '/client/intake/case-a' });
    expect(w.counters.d1).toBe(1);
    // A copied request has no bound intake ports, even if its URL and cookie match.
    expect(await caseActionsFor('case-a', { ...event, request: new Request(event.request) })).not.toContainEqual(expect.objectContaining({ label: 'Upload documents' }));
    const setId = 'synthetic-wired-set-0001';
    const files = [0, 1].map((i) => { const bytes = syntheticPdf(`wired-${i}`); return { bytes, path: `${i}.pdf`,
      operationId: `synthetic-wired-file-000${i}`, size: bytes.length, sha256: hex(bytes), mediaType: 'application/pdf' }; });
    const base = '/client/intake/case-a';
    const call = async (action: 'openSet' | 'declareSetFile' | 'uploadSetFile' | 'sealSet', body: unknown, operationId?: string) => {
      const pdf = action === 'uploadSetFile';
      const e = await compose(base, pdf ? 'PUT' : 'POST', pdf ? body as BodyInit : JSON.stringify(body), pdf ? 'application/pdf' : 'application/json');
      return (await intakeControllerFor(e))[action]({ request: e.request, url: e.url, identity: e.locals.identity, params: { caseId: 'case-a', setId, operationId } });
    };
    expect((await call('openSet', { setId, fileCount: 2, totalBytes: files.reduce((n, f) => n + f.size, 0) })).status).toBe(201);
    for (const { bytes, ...meta } of files) {
      expect((await call('declareSetFile', meta)).status).toBe(201);
      expect((await call('uploadSetFile', bytes, meta.operationId)).status).toBe(201);
    }
    let release!: (r: Response) => void;
    const send = vi.fn<typeof fetch>(() => new Promise((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', send);
    expect((await call('sealSet', { filesSha256: await fileSetDigest(files) })).status).toBe(201);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(w.db.rows('SELECT delivered_at FROM sub_notification')).toEqual([{ delivered_at: null }]);
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toMatchObject({ caseId: 'case-a', submissionId: setId, files: 2,
      bytes: files.reduce((n, f) => n + f.size, 0) });
    release(new Response(null, { status: 204 }));
    await Promise.all(pending);
    expect(w.db.rows<{ delivered_at: string }>('SELECT delivered_at FROM sub_notification')[0]!.delivered_at).toBeTruthy();
    if (granted.kind !== 'applied') throw new Error('grant missing');
    // The advisory reader is fresh on the next call; it cannot preserve a revoked grant.
    w.db.exec("UPDATE tenant_upload_grants SET state='revoked', version=version+1, revoked_operation_id='synthetic-revocation', revoked_at=? WHERE grant_id=?", new Date().toISOString(), granted.grant.grantId);
    expect(await caseActionsFor('case-a', event)).not.toContainEqual(expect.objectContaining({ label: 'Upload documents' }));
  } finally { await Promise.all(pending); w.db.sqlite.close(); }
}, 30_000);
