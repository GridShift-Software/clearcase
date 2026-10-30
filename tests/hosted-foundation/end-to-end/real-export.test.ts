// U14 local end to end. SYNTHETIC ONLY: a generated corpus (126 documents, one uncited original withheld, META counting one document
// too many), the assembled native schema through the staging original-metadata migration on node:sqlite, an in-memory R2, and the real `hostedServices`
// composition behind the real routes. Clerk, the compiled PDF pins and the Browser Rendering SDK are doubles: the browser double
// fabricates canvas proofs, so this proves the server's wiring, sealing, readiness, sign-off and publish, NOT that anything rendered.
// It is not Cloudflare evidence: D1, R2, Workers limits and latency are not exercised.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateCorpus } from '../../../scripts/fixtures/synthetic/corpus.ts';
import { prepareHostedPdfAssets } from '../../../scripts/hosted-pdf-assets.ts';
import { installWorkerdRedirectContract } from '../workerd-redirect-contract.ts';
import { pdfBrowser } from '../native-render-check/pdf-evidence-world.ts';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import {
  assembleNativeRuntimeMigration, NATIVE_RUNTIME_MIGRATION_INPUTS, assembleNativeRenderCaseLimitMigration, NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS,
  assembleNativeEvidenceMigration, NATIVE_EVIDENCE_MIGRATION_INPUTS, assembleNativeImportStagingMigration, NATIVE_IMPORT_STAGING_MIGRATION_INPUTS,
  assembleNativeIntakeFileSetsMigration, NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS, assembleNativePdfSessionsMigration, NATIVE_PDF_SESSIONS_MIGRATION_INPUTS,
  assembleNativeOriginalMetadataMigration, NATIVE_ORIGINAL_METADATA_MIGRATION_INPUTS,
} from '../../../deploy/native-alpha/runtime-migration.ts';
import type { Identity, Principal, SessionId } from '../../../src/lib/server/runtime/contracts.ts';
import type { AuthorizeCase } from '../../../src/lib/tenancy/authorizer.ts';
import { installNativeCompositions } from '../../../src/lib/server/runtime/hosted/compositions.ts';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { gateRecords, verifiedMaterial } from '../../../src/lib/server/runtime/hosted/evidence-gate.ts';
import { hostedValidationPolicy } from '../../../src/lib/server/runtime/hosted/validation-policy.ts';
import { NATIVE_PDF_EVIDENCE_CEILINGS } from '../../../src/lib/viewer/hosted/native-render-check.ts';
import { validateHostedPackage } from '../../../src/lib/case-package/hosted-validation.ts';
import { META_DISAGREEMENT_CODE } from '../../../src/lib/case-package/meta-integrity.ts';
import { ASSET_ACK_CODE } from '../../../src/lib/publication/hosted/asset-policy.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { MemoryR2 } from '../storage/doubles.ts';
import { Sqlite } from '../../publication/signoff-root/harness.ts';
import { BUDGETS, QUOTAS, ids, submitSet } from '../storage/fixture.ts';
import { POST as openStagedRoute } from '../../../deploy/client/routes/operator/results/[caseId]/imports/staged/+server.ts';
import { POST as filesRoute } from '../../../deploy/client/routes/operator/results/[caseId]/imports/staged/[operationId]/files/+server.ts';
import { POST as completeRoute } from '../../../deploy/client/routes/operator/results/[caseId]/imports/staged/[operationId]/complete/+server.ts';
import { planBatches, stagedBounds } from '../../../src/lib/results-review/native/staging/limits.ts';
import { POST as evidenceRoute } from '../../../deploy/client/routes/operator/publication/[caseId]/evidence/+server.ts';
import { GET as readinessRoute } from '../../../deploy/client/routes/operator/publication/[caseId]/readiness/+server.ts';
import { POST as signoffRoute } from '../../../deploy/client/routes/operator/publication/[caseId]/signoffs/+server.ts';
import { POST as publishRoute } from '../../../deploy/client/routes/operator/publication/[caseId]/publish/+server.ts';
import { load as recordsLoad } from '../../../deploy/client/routes/cases/[caseId]/views/[resultsVersion]/records/[key]/+page.server.ts';
import { load as viewLoad } from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/view/+page.server.ts';
import { GET as originalRoute } from '../../../deploy/client/routes/cases/[caseId]/originals/[assetId]/+server.ts';

// Clerk is replaced by a provider that answers per exact Request; each identity's case decisions go to the REAL grant authorizer
// hostedServices hands the provider, so every read below is decided by the grant rows this test inserts.
const wiring = vi.hoisted(() => ({ authorizeCase: null as AuthorizeCase | null, identityFor: new WeakMap<Request, Identity>(), pins: null as unknown, launch: null as null | (() => unknown), older: false }));
vi.mock('../../../src/lib/auth/clerk/provider.ts', () => ({ clerkIdentityProviderFromEnv: (_env: unknown, hooks: { authorizeCase: AuthorizeCase }) => {
  wiring.authorizeCase = hooks.authorizeCase;
  return { ok: true, config: { clientId: 'client-a', appOrigin: 'https://app.example', client: { issuer: 'https://client-issuer.test' }, staff: { issuer: 'https://staff-issuer.test' } },
    provider: { authenticate: async ({ request }: { request: Request }) => wiring.identityFor.get(request)
      ?? { kind: 'anonymous', principal: null, sessionId: null, clientId: 'client-a', checkRevocation: async () => { throw new Error('anonymous'); }, authorize: async () => { throw new Error('anonymous'); } } } };
} }));
vi.mock('../../../src/lib/server/runtime/hosted/render-pins.ts', () => ({ compiledPdfAssetPins: () => wiring.pins }));
vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: async () => wiring.launch!() } }));
// `older` stands in for the producer before U10: it sealed a missing original's warning without the detail that names the asset and the
// validator's diagnostic, so the run's summary counts it under ORIGINAL_NOT_WARNED. Off, the real policy runs unchanged.
vi.mock('../../../src/lib/publication/hosted/asset-policy.ts', async (original) => {
  const actual = await original<typeof import('../../../src/lib/publication/hosted/asset-policy.ts')>();
  return { ...actual, assetPolicyItems: (...a: Parameters<typeof actual.assetPolicyItems>) => actual.assetPolicyItems(...a).map((item) => {
    if (!wiring.older || !item.key.startsWith('warning/')) return item;
    const { missing: _missing, ...observation } = item.observation as Record<string, unknown>;
    return { ...item, observation } as typeof item;
  }) };
});

const ORIGIN = 'https://app.example', STAFF = 'https://staff-issuer.test', CLIENT_ISSUER = 'https://client-issuer.test';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sources = (pins: readonly { path: string }[]) => pins.map((p) => ({ path: p.path, bytes: readFileSync(p.path) }));
/** The assembled native schema plus the staging increments the current runtime requires, each in its own transaction. */
function nativeSchema(db: DatabaseSync) {
  db.exec(assembleNativeSchema(sources(NATIVE_SCHEMA_INPUTS)).sql);
  db.exec(assembleNativeRuntimeMigration(sources(NATIVE_RUNTIME_MIGRATION_INPUTS)).sql);
  for (const sql of [assembleNativeRenderCaseLimitMigration(sources(NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS)).sql, assembleNativeEvidenceMigration(sources(NATIVE_EVIDENCE_MIGRATION_INPUTS)).sql,
    assembleNativeImportStagingMigration(sources(NATIVE_IMPORT_STAGING_MIGRATION_INPUTS)).sql, assembleNativeIntakeFileSetsMigration(sources(NATIVE_INTAKE_FILE_SETS_MIGRATION_INPUTS)).sql,
    assembleNativePdfSessionsMigration(sources(NATIVE_PDF_SESSIONS_MIGRATION_INPUTS)).sql,
    assembleNativeOriginalMetadataMigration(sources(NATIVE_ORIGINAL_METADATA_MIGRATION_INPUTS)).sql]) {
    db.exec('BEGIN'); try { db.exec(sql); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
function identity(principal: Principal, session: string): Identity {
  const sessionId = session as SessionId;
  return { kind: 'verified', principal, sessionId, clientId: ids.clientA, checkRevocation: async () => {},
    authorize: async (scope) => { await wiring.authorizeCase!({ principal, sessionId, caseId: scope.caseId, operation: scope.operation }); } };
}
const operator = identity({ issuer: STAFF, subject: 'operator-synthetic', kind: 'staff' }, 'session-operator-synthetic');
const owner = identity({ issuer: STAFF, subject: 'owner-synthetic', kind: 'staff' }, 'session-owner-synthetic');
const reader = identity({ issuer: CLIENT_ISSUER, subject: 'client-reader-synthetic', kind: 'client' }, 'session-client-synthetic');

const work = mkdtempSync(path.join(tmpdir(), 'clearcase-u14-e2e-'));
const assetsRoot = path.join(work, 'public');
mkdirSync(assetsRoot);
const pins = prepareHostedPdfAssets({ root: path.resolve('.'), publicRoot: assetsRoot });
let restoreRequest: (() => void) | undefined;
// Only Date is faked, from mid-morning of a synthetic day, so the trusted clock can pass each PDF session's lease; timers run as they do.
const DAY_MS = 86_400_000;
beforeAll(() => {
  restoreRequest = installWorkerdRedirectContract(); installNativeCompositions();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(20_000 * DAY_MS + 8 * 3_600_000);
});
afterAll(() => { vi.useRealTimers(); restoreRequest?.(); rmSync(work, { recursive: true, force: true }); });

function walk(root: string, rel = ''): [string, Uint8Array][] {
  return readdirSync(path.join(root, rel)).sort().flatMap((name) => {
    const p = rel ? `${rel}/${name}` : name;
    return statSync(path.join(root, p)).isDirectory() ? walk(root, p) : [[p, new Uint8Array(readFileSync(path.join(root, p)))] as [string, Uint8Array]];
  });
}

let worlds = 0;
async function world(o: { pdfBudget?: boolean; metaDisagrees?: boolean } = {}) {
  const corpusDir = path.join(work, `corpus-${++worlds}`);
  const corpus = await generateCorpus({ out: corpusDir, seed: 'u14-end-to-end', documents: DOCUMENTS, profile: 'small', images: 0, withhold: [122], metaDocCountOffset: o.metaDisagrees === false ? 0 : 1 });
  const pkg = new Map(walk(path.join(corpusDir, 'pkg')));
  const originals = walk(path.join(corpusDir, 'case'));
  const caseId = id('case', (JSON.parse(new TextDecoder().decode(pkg.get('manifest.json'))) as { case: { id: string } }).case.id);

  // A D1-shaped adapter (results and meta.changes, as D1 answers) over node:sqlite holding the native schema.
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.limits.likePatternLength = 50; // D1 refuses a LIKE or GLOB pattern over 50 bytes
  nativeSchema(sqlite);
  const db = new Sqlite(sqlite), bucket = new MemoryR2();
  const raw = { exec: (sql: string, ...v: (string | number | null)[]) => { sqlite.prepare(sql).run(...v); }, rows: <T>(sql: string, ...v: (string | number | null)[]) => sqlite.prepare(sql).all(...v) as T[] };
  raw.exec("INSERT INTO rs_storage_identity (singleton, client_id, layout) VALUES (1, ?, 'clearcase.rs/1')", ids.clientA);
  bucket.setRaw('identity/client.json', new TextEncoder().encode(JSON.stringify({ client_id: ids.clientA })));
  raw.exec('INSERT INTO rs_case (case_id, case_label) VALUES (?, ?)', caseId, 'Synthetic U14 case');
  await provisionAuditBinding({ db, config: auditConfig({ clientId: ids.clientA, trustedIssuers: [STAFF, CLIENT_ISSUER], limits: AUDIT }), now: () => new Date() });
  // Test-owned identities only: the operator operates, the owner publishes, both may read the private preview, the client reads.
  const grant = (who: Identity, role: string, slot: string) => {
    if (who.kind !== 'verified') throw new Error('synthetic identity');
    raw.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, expires_at, version,
      created_operation_id, request, created_by_issuer, created_by_subject, created_at) VALUES (?, ?, 'case', ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, '{}', ?, ?, ?)`,
    `grant-${who.principal.subject}-${role}`, ids.clientA, caseId, who.principal.issuer, who.principal.subject, who.principal.kind, role, slot,
    `grant-op-${who.principal.subject}-${role}`, STAFF, 'grant-admin-synthetic', new Date().toISOString());
  };
  grant(operator, 'operator', 'operator'); grant(operator, 'viewer', 'content');
  grant(owner, 'publisher', 'publisher'); grant(owner, 'viewer', 'content');
  grant(reader, 'viewer', 'content');

  // The PDF evidence browser double answers each original's real page count.
  const script = new Map(originals.map(([, bytes]) => [sha(bytes), { totalPages: Math.max(1, new TextDecoder('latin1').decode(bytes).match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0) }]));
  const boundary = pdfBrowser(script);
  wiring.pins = pins; wiring.launch = () => boundary.launch();
  const assets = { fetch: async (request: Request) => new Response(readFileSync(path.join(assetsRoot, new URL(request.url).pathname))) };
  const browser = { fetch: async () => { throw new Error('inert BROWSER double: no provider call'); } };
  const settings = { schema: 'clearcase.native-runtime/1', deployment: DEPLOYMENT,
    manifest: { staffIssuer: STAFF, clients: [{ ...DEPLOYMENT, clientIssuer: CLIENT_ISSUER }] }, auditLimits: AUDIT,
    storageBudgets: STORAGE, storageQuotas: { ...QUOTAS, maxUploadsPerCase: 4096 }, userWorkLimits: { maxStatementsPerBatch: 20, maxSnapshotBytes: 1 << 20 },
    intakeBudget: { maxFileBytes: STORAGE.maxOriginalBytes, maxMetadataBytes: 4096 },
    importBudget: { maxFiles: STORAGE.maxPackageFiles, maxFileBytes: STORAGE.maxPackageFileBytes, maxPackageBytes: STORAGE.maxPackageBytes, maxRequestBytes: IMPORT_REQUEST_BYTES },
    ...(o.pdfBudget === false ? {} : { pdfEvidenceBudget: NATIVE_PDF_EVIDENCE_CEILINGS }) };
  const env = { CLEARCASE_CLIENT_ID: ids.clientA, DB: db, BUCKET: bucket, CLEARCASE_NATIVE_CONFIG: JSON.stringify(settings), BROWSER: browser, ASSETS: assets };

  /** One request through the real services and the real route module, as the parent's handle would run it. */
  async function call(who: Identity, route: (e: never) => unknown, method: 'GET' | 'POST', at: string, params: Record<string, string>, body?: unknown) {
    const url = new URL(at, ORIGIN);
    const request = new Request(url, { method, headers: { origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    wiring.identityFor.set(request, who);
    const ready = await hostedServices(request, env);
    if (!ready.ready) throw new Error(ready.reason);
    return route({ request, url, params, locals: ready.services, platform: null } as never) as Promise<Response>;
  }
  const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> });
  const scope = { caseId };
  /** Intake, then the staged import, as the real export takes them. The candidate id. */
  async function imported(): Promise<string> {
    // The client's originals as one sealed file set, through the real intake controller and repository.
    const revision = await submitSet({ db: db as never, bucket }, caseId, 'u14', originals.map(([p, bytes], i) => ({ ref: `o${i}`, path: p, bytes })), { quotas: { ...QUOTAS, maxUploadsPerCase: 4096 } });
    // Open with the manifest, send the files in bounded batches, complete until linked.
    const operationId = 'u14-import-operation-0001', staged = `/operator/results/${caseId}/imports/staged`;
    const opened = await json(await call(operator, openStagedRoute, 'POST', staged, scope,
      { operationId, submissionRevisionId: revision, manifest: new TextDecoder().decode(pkg.get('manifest.json')) }));
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    for (const batch of planBatches([...pkg].filter(([p]) => p !== 'manifest.json').map(([p, b]) => [p, b.byteLength] as const), stagedBounds({ maxRequestBytes: IMPORT_REQUEST_BYTES }))) {
      const sent = await json(await call(operator, filesRoute, 'POST', `${staged}/${operationId}/files`, { ...scope, operationId },
        { files: Object.fromEntries(batch.map((p) => [p, Buffer.from(pkg.get(p)!).toString('base64')])) }));
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    }
    let done: { status: number; body: Record<string, unknown> };
    for (let n = 0; ; n++) {
      done = await json(await call(operator, completeRoute, 'POST', `${staged}/${operationId}/complete`, { ...scope, operationId }, {}));
      if (done.status !== 202 || n > 500) break;
    }
    expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
    expect(done.body.kind).toBe('linked');
    return (done.body.candidate as { candidateId: string }).candidateId;
  }
  /** One build request, the clock untouched. */
  const step = (candidateId: string, restart = false) =>
    call(operator, evidenceRoute, 'POST', `/operator/publication/${caseId}/evidence`, scope, { candidateId, ...(restart ? { restart } : {}) }).then(json);
  /** Build requests until the run answers something other than 202; the last answer and how many requests it took. */
  async function build(candidateId: string, restart = false) {
    let requests = 0, out: { status: number; body: Record<string, unknown> };
    do {
      out = await step(candidateId, restart && requests === 0);
      // One PDF session per client at a time, each reserving its lease (U9): the operator calls again once it has passed.
      vi.setSystemTime(Date.now() + 125_000);
    } while (out.status === 202 && ++requests < 400);
    return { ...out, requests: requests + 1 };
  }
  const readiness = (candidateId: string, q = '') => call(owner, readinessRoute, 'GET', `/operator/publication/${caseId}/readiness?candidateId=${candidateId}${q}`, scope).then(json);
  /** The owner reads every warning the run holds and acknowledges each new one, grouped by its code with one reason per group. */
  async function acknowledgementsFor(candidateId: string) {
    const codes = new Map(validateHostedPackage({ files: pkg, originals: new Map() }).result.diagnostics.map((d) => [d.fingerprint, d.code]));
    const warnings: { fingerprint: string; missing: boolean }[] = [];
    for (let cursor: string | null = null, n = 0; n < 100; n++) {
      const page = await readiness(candidateId, `&kind=warning${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.status).toBe(200);
      const p = page.body.page as { items: { observation: { fingerprint: string }; acknowledgementRequired?: boolean; policy?: unknown }[]; next: string | null };
      for (const item of p.items) if (item.acknowledgementRequired) warnings.push({ fingerprint: item.observation.fingerprint, missing: item.policy !== undefined });
      cursor = p.next; if (!cursor) break;
    }
    const byCode = new Map<string, string[]>();
    for (const x of warnings) {
      const code = x.missing ? ASSET_ACK_CODE : codes.get(x.fingerprint) ?? META_DISAGREEMENT_CODE;
      byCode.set(code, [...byCode.get(code) ?? [], x.fingerprint]);
    }
    return { count: warnings.length, codes: [...byCode.keys()], groups: [...byCode].map(([code, fingerprints]) => ({ code, reason: `Synthetic owner reviewed ${code}.`, fingerprints })) };
  }
  /** The owner's sign-off of the exact candidate identity and evidence root readiness showed. */
  async function signOff(candidateId: string, view: Record<string, unknown>, acknowledgements: unknown[], operationId = 'u14-signoff-operation-0001') {
    const { candidateId: _c, ...claimed } = view.identity as Record<string, string>;
    return json(await call(owner, signoffRoute, 'POST', `/operator/publication/${caseId}/signoffs`, scope,
      { operationId, candidateId, identity: { ...claimed, evidenceRoot: (view.evidence as { root: string }).root }, acknowledgements, selfApproval: false }));
  }
  const publish = (signoffId: string, operationId = 'u14-publish-operation-0001') =>
    call(owner, publishRoute, 'POST', `/operator/publication/${caseId}/publish`, scope, { operationId, signoffId, expected: { kind: 'none' } }).then(json);
  return { corpus, pkg, originals, caseId, raw, db, bucket, boundary, env, call, json, imported, step, build, readiness, acknowledgementsFor, signOff, publish };
}

const AUDIT = { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100, maxDenialRows: 100, maxDenialsPerActor: 10, maxPageRows: 20, maxPagesPerRequest: 5 };
const DEPLOYMENT = { clientId: ids.clientA, hostname: 'app.example', worker: 'client-a', d1DatabaseId: '11111111-1111-1111-1111-111111111111', d1DatabaseName: 'client-a', r2Bucket: 'client-a' };
const IMPORT_REQUEST_BYTES = 16 << 20;
/** 126 by default; CLEARCASE_U14_DOCUMENTS=1689 runs the v5-sized corpus (timings only; the assertions are the same). */
const DOCUMENTS = Number(process.env.CLEARCASE_U14_DOCUMENTS ?? 126);
// Sized for up to 1,689 documents: the single-request stager reserves four verification passes over each original plus the package
// files (1,689 x 4 + 37 objects), and every build request verifies the package again.
const STORAGE = { ...BUDGETS, maxRowsPerBatch: 100, maxPackageFileBytes: 16 << 20, maxPackageBytes: 32 << 20, maxBufferedObjectBytes: 16 << 20, maxDocuments: 4096, maxVerifyObjects: 8192, maxVerifyBytes: 256 << 20,
  maxVerifyObjectsPerCaseWindow: 1 << 20, maxVerifyBytesPerCaseWindow: 16 * 2 ** 30 };

describe('U14 real-export end to end (synthetic, local): intake, import, evidence, readiness, sign-off, publish, client read', () => {
  it(`takes a ${DOCUMENTS}-document package with a missing uncited original and a META disagreement to a published records view and a cited page`, async () => {
    const w = await world();
    const { caseId } = w, scope = { caseId };
    expect(w.originals.length).toBe(w.corpus.originalFiles); // the withheld original is never written
    const assets = JSON.parse(new TextDecoder().decode(w.pkg.get('assets.json'))) as { assets: Record<string, { kind: string; path?: string }> };
    const missing = Object.entries(assets.assets).filter(([, a]) => a.kind === 'missing').map(([ref]) => ref);
    expect(missing).toHaveLength(1);

    // 1-2. Intake and the staged import through the operator's routes: a private candidate, linked to the finalized submission.
    const candidateId = await w.imported();

    // 3. Evidence: bounded build requests until the run is sealed. A request releases its lease as it ends, so the operator's next
    // request, at once and with the clock unchanged, continues the run rather than answering 409 leased.
    expect((await w.step(candidateId)).status).toBe(202);
    const continued = await w.step(candidateId);
    expect(continued.status, JSON.stringify(continued.body)).toBe(202);
    expect(continued.body.state).not.toBe('leased');
    const built = await w.build(candidateId);
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    expect(built.body).toMatchObject({ state: 'complete', generation: '1' });
    const steps = built.requests - 1;
    const root = built.body.root as string;

    // The gate's records HTML is the client route's HTML once published (checked below); here, the material the gate verified.
    const material = await verifiedMaterial({ db: w.db as never, bucket: w.bucket, clientId: ids.clientA, storageBudgets: STORAGE as never, validationLimits: hostedValidationPolicy(STORAGE as never)!, now: () => new Date() }, { caseId, candidateId });

    // 4. Readiness: the sealed run, served as snapshot v2. Its only blocker is the META disagreement, which the owner's acknowledgement clears.
    const readinessAt = (q = '') => `/operator/publication/${caseId}/readiness?candidateId=${candidateId}${q}`;
    const t0 = performance.now();
    const before = await w.json(await w.call(owner, readinessRoute, 'GET', readinessAt(), scope));
    const readinessMs = performance.now() - t0;
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body).toMatchObject({ format: 'clearcase.readiness/2', evidence: { generation: '1', root } });
    expect(before.body.blocker).toEqual({ code: 'required-section', detail: ['meta:disagrees'] });

    const acks = await w.acknowledgementsFor(candidateId);
    expect(acks.count).toBe(before.body.acknowledgementsRequired);
    expect(acks.codes).toEqual(expect.arrayContaining([ASSET_ACK_CODE, META_DISAGREEMENT_CODE]));

    // 5. Owner sign-off of the exact candidate and run, then readiness naming it shows no blocker.
    const identityOf = before.body.identity as Record<string, string>;
    const signed = await w.signOff(candidateId, before.body, acks.groups);
    expect(signed.status, JSON.stringify(signed.body)).toBe(201);
    const signoffId = signed.body.signoffId as string;
    const after = await w.json(await w.call(owner, readinessRoute, 'GET', readinessAt(`&signoffId=${signoffId}`), scope));
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.blocker).toBeNull();
    expect(after.body.signoff).toMatchObject({ signoffId, blockers: [] });

    // 6. Publish: the guard rereads the run, compares every original in R2 and sets the pointer.
    const t1 = performance.now();
    const published = await w.json(await w.call(owner, publishRoute, 'POST', `/operator/publication/${caseId}/publish`, scope,
      { operationId: 'u14-publish-operation-0001', signoffId, expected: { kind: 'none' } }));
    const publishMs = performance.now() - t1;
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const rv = identityOf.resultsVersion!;
    expect(w.raw.rows<{ state: string; version_id: string }>('SELECT state, version_id FROM rs_publication WHERE case_id = ?', caseId)).toEqual([{ state: 'published', version_id: rv }]);

    // 7. The client reads a published records view: the same HTML the gate rendered when it sealed the section.
    const key = ['people', 'entities', 'contracts', 'witnesses', 'filings'].find((k) => gateRecords(material, k).state === 'records-rendered')!;
    expect(key).toBeDefined();
    const recordsRequest = new Request(new URL(`/cases/${caseId}/views/${rv}/records/${key}`, ORIGIN));
    wiring.identityFor.set(recordsRequest, reader);
    const services = (await hostedServices(recordsRequest, w.env)).services;
    const page = await recordsLoad({ locals: services, params: { caseId, resultsVersion: rv, key } } as never) as { html: string };
    expect(page.html).toBe(gateRecords(material, key).html);

    // ...and a cited page of a PDF original, in the viewer and as the checked bytes.
    const cited = material.mapped.find((m) => m.packageRefs.some((r) => material.cited.has(r)))!;
    const view = await viewLoad({ locals: services, params: { caseId, assetId: cited.submissionAssetId }, url: new URL(`${ORIGIN}/cases/${caseId}/originals/${cited.submissionAssetId}/view?page=1`) } as never) as { view: { state: string } };
    expect(view.view.state).toBe('available');
    const bytesRequest = new Request(new URL(`/cases/${caseId}/originals/${cited.submissionAssetId}`, ORIGIN));
    wiring.identityFor.set(bytesRequest, reader);
    const served = await originalRoute({ request: bytesRequest, url: new URL(bytesRequest.url), params: { caseId, assetId: cited.submissionAssetId }, locals: (await hostedServices(bytesRequest, w.env)).services } as never);
    expect(served.status).toBe(200);
    expect(sha(new Uint8Array(await served.arrayBuffer()))).toBe(cited.sha256);

    console.info(`U14 e2e timings (SQLite, MemoryR2, ${DOCUMENTS} documents): readiness read ${readinessMs.toFixed(1)} ms, publish guard ${publishMs.toFixed(1)} ms, ${steps + 1} evidence requests`);
  }, 900_000);

  // Review H1 (P3): a restart that begins after publish's final recheck and before its D1 batch makes the signed generation older. The
  // batch itself must refuse it: the guard requires that no newer generation exists, in the same transaction as the pointer write.
  it('refuses to publish a sign-off whose generation a restart replaced between the final recheck and the commit, and publishes nothing', async () => {
    const w = await world();
    const candidateId = await w.imported();
    expect((await w.build(candidateId)).status).toBe(200);
    const ready = await w.readiness(candidateId);
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    const signed = await w.signOff(candidateId, ready.body, (await w.acknowledgementsFor(candidateId)).groups);
    expect(signed.status, JSON.stringify(signed.body)).toBe(201);

    // The restart's first claim, exactly as d1EvidenceStore writes it, lands just before the publish batch runs.
    const sql = new WeakMap<object, string>();
    const prepare = w.db.prepare.bind(w.db), batch = w.db.batch.bind(w.db);
    const tag = (st: ReturnType<typeof prepare>, query: string): ReturnType<typeof prepare> => {
      sql.set(st, query);
      const bind = st.bind.bind(st);
      st.bind = ((...v: Parameters<typeof bind>) => tag(bind(...v) as ReturnType<typeof prepare>, query)) as typeof st.bind;
      return st;
    };
    w.db.prepare = ((query: string) => tag(prepare(query), query)) as typeof w.db.prepare;
    let restarted = false;
    w.db.batch = (async (statements: Parameters<typeof batch>[0]) => {
      if (!restarted && statements.some((st) => sql.get(st as object)?.includes('INSERT INTO pub_apply_receipt'))) {
        restarted = true;
        w.raw.exec(`INSERT INTO pub_evidence_run (candidate_id, generation, client_id, case_id, results_version, manifest_sha256, validator_version, renderer_version, state, cursor, lease_token, lease_until_ms, evidence_root)
          SELECT candidate_id, '2', client_id, case_id, results_version, manifest_sha256, validator_version, renderer_version, 'building', NULL, 'concurrent-restart', ?, NULL
          FROM pub_evidence_run WHERE candidate_id = ? AND generation = '1'`, Date.now() + 75_000, candidateId);
      }
      return batch(statements);
    }) as typeof w.db.batch;
    const refused = await w.publish(signed.body.signoffId as string);
    w.db.prepare = prepare; w.db.batch = batch;
    expect(restarted).toBe(true);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(w.raw.rows('SELECT * FROM rs_publication')).toEqual([]);
    expect(w.raw.rows('SELECT * FROM pub_apply_receipt')).toEqual([]);
    // Readiness reads only the latest generation, which is still building; once rebuilt, the old sign-off still never publishes.
    expect((await w.readiness(candidateId)).status).toBe(503);
    w.raw.exec("UPDATE pub_evidence_run SET lease_until_ms = 0 WHERE generation = '2'");
    expect(await w.build(candidateId)).toMatchObject({ status: 200, body: { state: 'complete', generation: '2' } });
    expect((await w.publish(signed.body.signoffId as string, 'u14-publish-operation-0002')).status).toBe(409);
    expect(w.raw.rows('SELECT * FROM rs_publication')).toEqual([]);
  }, 300_000);

  it('replaces a run sealed by an older producer: readiness answers 503 until the operator restarts the build, then 200 from the new generation', async () => {
    const w = await world();
    const candidateId = await w.imported();
    wiring.older = true;
    try { expect(await w.build(candidateId)).toMatchObject({ status: 200, body: { state: 'complete', generation: '1' } }); } finally { wiring.older = false; }
    // The older run is sealed and its summary never served: the missing original is counted as not warned, and nothing partial is shown.
    expect((await w.readiness(candidateId)).status).toBe(503);
    // Asking again without restart reports the sealed run as it is; only a restart replaces it.
    expect(await w.build(candidateId)).toMatchObject({ status: 200, body: { state: 'complete', generation: '1' } });
    const rebuilt = await w.build(candidateId, true);
    expect(rebuilt).toMatchObject({ status: 200, body: { state: 'complete', generation: '2' } });
    const ready = await w.readiness(candidateId);
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body).toMatchObject({ evidence: { generation: '2', root: rebuilt.body.root }, blocker: { code: 'required-section', detail: ['meta:disagrees'] } });
    expect(w.raw.rows('SELECT generation, state FROM pub_evidence_run ORDER BY generation')).toEqual([{ generation: '1', state: 'complete' }, { generation: '2', state: 'complete' }]);
  }, 300_000);

  it('fails closed on PDFs: no PDF evidence budget answers 503 renderer-unavailable and writes nothing; a browser without contexts seals failed previews that block sign-off', async () => {
    const none = await world({ pdfBudget: false });
    const unrendered = await none.imported();
    expect(await none.build(unrendered)).toMatchObject({ status: 503, body: { state: 'renderer-unavailable', generation: '1' }, requests: 1 });
    expect(none.raw.rows('SELECT * FROM pub_evidence_run')).toEqual([]);

    // META agrees here, so the section check (which comes first) passes and the previews decide.
    const w = await world({ metaDisagrees: false });
    w.boundary.browser.createBrowserContext.mockImplementation(async () => { throw new Error('Browser Rendering contexts are unsupported here'); });
    const candidateId = await w.imported();
    expect(await w.build(candidateId)).toMatchObject({ status: 200, body: { state: 'complete' } });
    const previews = w.raw.rows<{ state: string; reason: string }>(`SELECT json_extract(item_json, '$.observation.state') AS state, json_extract(item_json, '$.observation.reasonCode') AS reason
      FROM pub_evidence_item WHERE item_key LIKE 'preview/%' AND json_extract(item_json, '$.observation.state') <> 'held'`);
    expect(previews.length).toBeGreaterThan(0);
    expect(previews.every((p) => p.state === 'failed' && p.reason === 'render-failed')).toBe(true);
    expect(w.boundary.inspected).toEqual([]);
    const ready = await w.readiness(candidateId);
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body.blocker).toEqual({ code: 'preview-not-ready', detail: [`failed:render-failed=${previews.length}`] });
  }, 300_000);
});
