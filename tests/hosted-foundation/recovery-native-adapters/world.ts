// SYNTHETIC ONLY: real SQL migrations/adapters over SQLite and R2-shaped fault transport, NOT provider evidence.
import { readFileSync } from 'node:fs';
import type { CloudR2Body } from '../../../src/lib/storage/cloud/bindings.ts';
import type { Identity, IdentityState } from '../../../src/lib/server/runtime/contracts.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { auditConfig, requestAuditSink } from '../../../src/lib/audit/index.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/trusted.ts';
import { createCaseAuthorizer } from '../../../src/lib/tenancy/authorizer.ts';
import { d1GrantRepository } from '../../../src/lib/tenancy/d1-grants.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import type { ClientResourceIdentity, ExactDeploymentTuple } from '../../../src/lib/tenancy/manifest.ts';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import { inputRevisionId, resultsVersionOf } from '../../../src/lib/case-package/hash.ts';
import type { Manifest } from '../../../src/lib/case-package/schema.ts';
import { resultsVersion } from '../../../src/lib/server/runtime/ids.ts';
import { createResultsStaging } from '../../../src/lib/storage/cloud/staging.ts';
import { preparePackage } from '../../../src/lib/results/hosted/project.ts';
import { readOriginalFacts } from '../../../src/lib/storage/cloud/original-facts.ts';
import { createCloudResults } from '../../../src/lib/results/hosted/index.ts';
import { createD1UserWork, d1WorkRevision } from '../../../src/lib/user-work/hosted/d1-user-work.ts';
import { createNativeRecoveryAdapters, type NativeRecoveryOptions, type RecoveryR2 } from '../../../src/lib/recovery/hosted/native-adapters.ts';
import { sha256Hex } from '../../../src/lib/recovery/hosted/bytes.ts';
import { SqliteD1, MemoryR2 } from '../storage/doubles.ts';
import { BUDGETS, QUOTAS, syntheticPackage, provideOriginals, publish } from '../storage/fixture.ts';

export const CLIENT = id('client', 'client-a'), CASE = id('case', 'case-a');
export const now = () => new Date('2026-10-25T12:00:00.000Z');
export const enc = (s: string) => new TextEncoder().encode(s);
export const LIMITS = { maxFiles: 256, maxFileBytes: 1 << 20, maxTotalBytes: 8 << 20, maxManifestBytes: 256 << 10 };
const migration = (p: string) => readFileSync(new URL(`../../../src/lib/${p}`, import.meta.url), 'utf8');

export class StreamR2 extends MemoryR2 implements RecoveryR2 {
  reads: string[] = [];
  puts: string[] = [];
  bodyReads = 0;
  cancelled = 0;
  ackLoss = false;
  beforePut: (() => Promise<void>) | null = null;
  afterGet: ((key: string) => void) | null = null;
  alter: ((key: string, object: CloudR2Body & { body: ReadableStream<Uint8Array> }) => CloudR2Body & { body: ReadableStream<Uint8Array> }) | null = null;
  override async get(key: string) {
    this.reads.push(key);
    const object = await super.get(key);
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const body = new ReadableStream<Uint8Array>({
      // No pull until a reader asks; tests can prove metadata refusals read no bytes.
      start() {},
      pull: (controller) => { this.bodyReads++; controller.enqueue(bytes); controller.close(); },
      cancel: () => { this.cancelled++; },
    }, { highWaterMark: 0 });
    const value = this.alter?.(key, { ...object, body }) ?? { ...object, body };
    this.afterGet?.(key);
    return value;
  }
  override async put(...args: Parameters<MemoryR2['put']>) {
    this.puts.push(args[0]);
    if (this.beforePut) { const hook = this.beforePut; this.beforePut = null; await hook(); }
    const result = await super.put(...args);
    if (this.ackLoss) { this.ackLoss = false; throw new Error('synthetic lost acknowledgement'); }
    return result;
  }
}

export async function world(isolated = false, workBound = true) {
  const db = new SqliteD1(), bucket = new StreamR2();
  for (const p of ['user-work/hosted/migrations/0001_uw_user_work.sql', 'results-review/native/migrations/0001_native_candidate_import.sql', 'tenancy/migrations/0001_tenant_case_grants.sql', 'audit/migrations/0001_native_audit.sql']) db.sqlite.exec(migration(p));
  db.exec("INSERT INTO rs_storage_identity VALUES (1, ?, 'clearcase.rs/1')", CLIENT);
  db.exec('INSERT INTO rs_case VALUES (?, ?)', CASE, 'Synthetic recovery');
  if (workBound) db.exec("INSERT INTO uw_binding VALUES (1, ?, 1, ?)", CLIENT, now().toISOString());
  bucket.setRaw('identity/client.json', enc(JSON.stringify({ client_id: CLIENT })));
  const resource: ClientResourceIdentity = {
    clientId: CLIENT, hostname: isolated ? 'restore.client-a.example' : 'client-a.example', worker: isolated ? 'restore-client-a' : 'client-a',
    d1DatabaseId: isolated ? '22222222-2222-2222-2222-222222222222' : '11111111-1111-1111-1111-111111111111',
    d1DatabaseName: isolated ? 'restore-client-a' : 'client-a', r2Bucket: isolated ? 'restore-client-a' : 'client-a',
    clientIssuer: 'https://clerk.client-a.example', staffIssuer: 'https://clerk.staff.example',
  };
  const boundResources: ExactDeploymentTuple = { clientId: CLIENT, hostname: resource.hostname, worker: resource.worker, d1DatabaseId: resource.d1DatabaseId, d1DatabaseName: resource.d1DatabaseName, r2Bucket: resource.r2Bucket };
  const config = auditConfig({ clientId: CLIENT, trustedIssuers: [resource.clientIssuer, resource.staffIssuer], limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 10_000, maxDenialsPerActor: 1000, maxPageRows: 50, maxPagesPerRequest: 5 } });
  await provisionAuditBinding({ db, config, now });
  const requester: IdentityState = { kind: 'verified', principal: { issuer: resource.clientIssuer, subject: 'synthetic-editor', kind: 'client' }, sessionId: id('session', isolated ? 'target-session' : 'source-session') };
  const audit = requestAuditSink({ db, config, requester, now });
  db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
    VALUES ('g1', ?, 'case', ?, ?, ?, 'client', 'editor', 'content', 'active', 1, 'grant-op', '{}', ?, 'provisioner', ?)`, CLIENT, CASE, resource.clientIssuer, requester.principal.subject, resource.staffIssuer, now().toISOString());
  const authorizer = createCaseAuthorizer({ deployment: resource, grants: d1GrantRepository(db), cases: d1CaseDirectory({ db, deployment: resource }), audit, now });
  const state = { revoked: false, authorizations: 0, afterAuthorize: null as (() => void) | null };
  const identity: Identity = { ...requester, clientId: CLIENT,
    async checkRevocation() { if (state.revoked) throw contractError('invalid-session'); },
    async authorize(q) { await identity.checkRevocation(); state.authorizations++; await authorizer.authorizeCase({ ...q, principal: requester.principal, sessionId: requester.sessionId }); state.afterAuthorize?.(); },
  };
  const sessions: string[] = [];
  const resources = { deployment: resource, boundResources, db: { prepare: db.prepare.bind(db), batch: db.batch.bind(db), withSession: (constraint: 'first-primary') => { sessions.push(constraint); return db; } }, bucket };
  const options: NativeRecoveryOptions = { resources, identity, audit, storageBudgets: { ...BUDGETS }, userWork: { clientId: CLIENT, limits: { maxStatementsPerBatch: 500, maxSnapshotBytes: 1 << 20 } }, caseId: CASE, limits: { ...LIMITS }, now, newId: () => crypto.randomUUID(), target: null };
  const deps = () => createNativeRecoveryAdapters(options);
  const work = () => {
    const store = createCloudResults({ bindings: { db, bucket }, clientId: CLIENT, budgets: options.storageBudgets, identity,
      stateRevision: d1WorkRevision({ db, config: options.userWork }), now,
      record: async (event) => { await audit.append({ ...event, actor: requester, eventId: crypto.randomUUID(), at: now().toISOString() }); },
    }).store;
    return createD1UserWork({ db, config: options.userWork, identity, audit, store, now, tableDefinitions: null });
  };
  const revokeGrant = () => db.exec("UPDATE tenant_case_grants SET state = 'revoked', revoked_at = ? WHERE grant_id = 'g1'", now().toISOString());
  const stage = async (tag = 'native-adapter-fixture') => {
    const pkg = await syntheticPackage(CASE, 'unchanged-originals');
    // A different processing input over the SAME immutable originals. Do not overwrite a case-original identity.
    const manifest = JSON.parse(new TextDecoder().decode(pkg.files.get('manifest.json')!)) as Manifest;
    manifest.inputRevision.sources[0]!.sha256 = await sha256Hex(enc(tag));
    manifest.inputRevision.sources[0]!.size = enc(tag).length;
    manifest.inputRevision.id = inputRevisionId(manifest.inputRevision.sources);
    manifest.resultsVersion = resultsVersionOf({ formatVersion: manifest.formatVersion, caseId: CASE, inputRevisionId: manifest.inputRevision.id, files: manifest.files });
    pkg.files.set('manifest.json', canonicalBytes(manifest));
    pkg.identity = { resultsVersion: resultsVersion(manifest.resultsVersion), manifestSha256: await sha256Hex(pkg.files.get('manifest.json')!) };
    if (db.rows('SELECT * FROM rs_case_original').length === 0) await provideOriginals({ db, bucket }, CASE, pkg);
    const prepared = preparePackage(pkg.files);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    const facts = await readOriginalFacts({ db, bucket, clientId: CLIENT, budgets: BUDGETS }, CASE, prepared.fileAssets);
    if (facts.kind !== 'ok') throw new Error(JSON.stringify(facts));
    const projected = prepared.project(facts.facts);
    if (!projected.ok) throw new Error(JSON.stringify(projected));
    const fixture = { ...pkg, projection: projected.projection };
    const result = await createResultsStaging({ bindings: { db, bucket }, clientId: CLIENT, budgets: BUDGETS, quotas: QUOTAS, authorize: async () => {}, now })
      .stage({ caseId: CASE, operationId: `stage-${tag}`, ...fixture });
    if (result.kind !== 'stored') throw new Error(JSON.stringify(result));
    return fixture;
  };
  const preview = async (rv: string, assetId = 'preview-OD-001') => {
    const bytes = enc('synthetic published preview'), sha = await sha256Hex(bytes);
    const key = `preview/${rv.slice(7)}/${sha}`;
    await bucket.put(key, bytes, { sha256: sha, onlyIf: { etagDoesNotMatch: '*' } });
    db.exec('INSERT INTO rs_preview VALUES (?, ?, ?, ?, ?, ?, ?)', rv, assetId, sha, bytes.length, 'application/pdf', 'supplied-preview.pdf', key);
    return bytes;
  };
  return { db, bucket, identity, state, options, resources, deps, work, sessions, revokeGrant, stage, preview, publish: (rv: string) => publish(db, CASE, rv), close: () => db.sqlite.close() };
}
export type World = Awaited<ReturnType<typeof world>>;
export const exportKey = (id = 'e1') => `recovery/exports/${CLIENT}/${CASE}/${id}/manifest.json`;
export const blobKey = (sha: string) => `recovery/exports/${CLIENT}/${CASE}/e1/blobs/${sha}`;
