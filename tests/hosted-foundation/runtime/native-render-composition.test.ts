import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
 NATIVE_SDK_BUILD_SCHEMA, NATIVE_SDK_INPUT_PINS, NATIVE_SDK_WORKER_OUTPUTS,
 NATIVE_SDK_BUFFER_SOURCE, NATIVE_SDK_DEBUG_SOURCE, NATIVE_SDK_POLICY_IDENTITY,
} from '../../../src/lib/viewer/hosted/sdk-build-contract.ts';
import { fixture, bundle } from '../native-sdk-build/harness.ts';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import type { NativeRequestCompositions } from '../../../src/lib/server/runtime/hosted/compositions.ts';
import type { NativePreviewRenderOptions } from '../../../src/lib/viewer/hosted/native-render-check.ts';
import type { NativePreviewRenderChecker } from '../../../src/lib/viewer/hosted/render-check-contract.ts';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { createNativeResultsImport } from '../../../src/lib/results-review/native/service.ts';
import { checkSnapshot, signoffBlocker } from '../../../src/lib/publication/hosted/rules.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { provisionAuditBinding } from '../../../src/lib/audit/d1-log.ts';
import { prepareHostedStaticInput } from '../../../scripts/hosted-static-input.ts';
import { world, caseId } from '../native-stager/world.ts';
import { BUDGETS, QUOTAS, ids } from '../storage/fixture.ts';

// UNIT-ONLY wiring seams for the hostedServices composition block below, NOT native render evidence:
// - Clerk is a synthetic provider whose configured appOrigin is the only origin source (no Clerk contact);
// - the compiled-pin lookup returns the verified static inventory (or a bad one), as the build define would;
// - the REAL checker constructor runs, but its verify is replaced so no test can reach Browser Run.
const wiring = vi.hoisted(() => ({
 identity: null as Identity | null, appOrigin: 'https://client-a.test', pins: null as unknown,
 ports: null as NativeRequestCompositions | null,
 created: [] as { options: NativePreviewRenderOptions; checker: NativePreviewRenderChecker | null }[],
 verified: [] as Parameters<NativePreviewRenderChecker['verify']>[0][],
}));
vi.mock('../../../src/lib/auth/clerk/provider.ts', () => ({ clerkIdentityProviderFromEnv: () => ({ ok: true,
 config: { clientId: 'client-a', appOrigin: wiring.appOrigin, client: { issuer: 'https://client-issuer.test' }, staff: { issuer: 'https://staff-issuer.test' } },
 provider: { authenticate: async () => wiring.identity } }) }));
vi.mock('../../../src/lib/server/runtime/hosted/compositions.ts', async (original) => {
 const actual = await original<typeof import('../../../src/lib/server/runtime/hosted/compositions.ts')>();
 return { ...actual, bindNativeRequestCompositions(request: Request, ports: NativeRequestCompositions) { wiring.ports = ports; actual.bindNativeRequestCompositions(request, ports); } };
});
vi.mock('../../../src/lib/server/runtime/hosted/render-pins.ts', () => ({ compiledPdfAssetPins: () => wiring.pins }));
vi.mock('../../../src/lib/viewer/hosted/native-render-check.ts', async (original) => {
 const actual = await original<typeof import('../../../src/lib/viewer/hosted/native-render-check.ts')>();
 return { ...actual, async createNativePreviewRenderChecker(options: NativePreviewRenderOptions) {
  const checker = await actual.createNativePreviewRenderChecker(options);
  wiring.created.push({ options, checker });
  return checker && { ...checker, async verify(input: Parameters<NativePreviewRenderChecker['verify']>[0]) {
   wiring.verified.push(input);
   return { state: 'pending' as const, rendererVersion: 'unit-wiring-spy', pages: null, reason: 'unit-wiring-spy' };
  } };
 } };
});

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const fixtures: ReturnType<typeof fixture>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0)) f.dispose();});

describe('native renderer build identity (unit/build-only)',()=>{
 it('captures independently measured installed SDK inventory and exact virtual sources',async()=>{
  const pkg=JSON.parse(readFileSync('node_modules/@cloudflare/puppeteer/package.json','utf8'));
  const root='node_modules/@cloudflare/puppeteer/lib/esm';
  const files:string[]=[];
  const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.name.endsWith('.js')&&!entry.name.endsWith('.test.js'))files.push(file);}};
  walk(root);files.sort((a,b)=>path.relative(root,a)<path.relative(root,b)?-1:1);
  const inventory=JSON.stringify(files.map(file=>({module:path.relative(root,file),sha256:hash(readFileSync(file,'utf8'))})));
  expect(pkg.version).toBe('1.4.0');
  expect(files).toHaveLength(144);
  expect(hash(inventory)).toBe('65d81a63ea1ea2a381d29260aad55d9737ca513b345efc68b66a88c4df539005');
  expect(NATIVE_SDK_INPUT_PINS).toMatchObject({version:pkg.version,modules:files.length,esmInventorySha256:hash(inventory)});
  expect(NATIVE_SDK_BUFFER_SOURCE).toBe("export { Buffer } from 'node:buffer';\n");
  expect(NATIVE_SDK_DEBUG_SOURCE).toBe("export default function debug() { throw Error('native render SDK Node diagnostics refused'); }\n");
  expect(NATIVE_SDK_POLICY_IDENTITY).toEqual({schema:NATIVE_SDK_BUILD_SCHEMA,inputs:NATIVE_SDK_INPUT_PINS,transforms:NATIVE_SDK_WORKER_OUTPUTS,hostBuffer:NATIVE_SDK_BUFFER_SOURCE,deniedNodeDiagnostics:NATIVE_SDK_DEBUG_SOURCE});
  expect(Object.isFrozen(NATIVE_SDK_INPUT_PINS)).toBe(true);
  expect(Object.isFrozen(NATIVE_SDK_WORKER_OUTPUTS)).toBe(true);
  expect(Object.isFrozen(NATIVE_SDK_POLICY_IDENTITY)).toBe(true);
  expect(Object.keys(NATIVE_SDK_WORKER_OUTPUTS)).toHaveLength(8);
 });
 it('agrees with actual scoped build receipts without claiming native SDK/render evidence',async()=>{
  const f=fixture();fixtures.push(f);await bundle(f.root);
  const receipt=JSON.parse(readFileSync(path.join(f.root,'.local/native-render-sdk-build/ssr.json'),'utf8'));
  expect(receipt.evidence).toBe('SCOPED-BUNDLE-NOT-NATIVE');
  expect(receipt.schema).toBe(NATIVE_SDK_BUILD_SCHEMA);
  expect(receipt.pins).toEqual(NATIVE_SDK_INPUT_PINS);
  for(const [module,outputSha256] of Object.entries(NATIVE_SDK_WORKER_OUTPUTS))
   expect(receipt.modules.find((item:{module:string})=>item.module===module)).toMatchObject({outputSha256});
 });
});

const auditLimits = { maxEventBytes: 4096, maxRows: 1000, maxReadRows: 100, maxDenialRows: 100, maxDenialsPerActor: 10, maxPageRows: 20, maxPagesPerRequest: 5 };
const deployment = { clientId: ids.clientA, hostname: 'client-a.test', worker: 'client-a',
 d1DatabaseId: '11111111-1111-1111-1111-111111111111', d1DatabaseName: 'client-a', r2Bucket: 'client-a' };
const CONFIGURED_ORIGIN = 'https://client-a.test';
const RENDER = { maxFileBytes: 1_000_000, maxPages: 4, maxCanvasPixels: 1_000_000, maxRunMs: 10_000, maxRunsPerCasePerDay: 1, maxRunsPerClientPerDay: 2 };
const ABSENT = Symbol('absent');
type Settings = typeof RENDER | Record<string, unknown> | unknown[] | string | null | typeof ABSENT;

// Receivers with private state: only a call made ON the binding itself passes.
class Browser { #brand = 'browser'; calls = 0; fetch(_request: unknown) { if (this.#brand !== 'browser') throw Error('receiver'); this.calls++; return Promise.resolve(new Response('x')); } }
class Assets { #brand = 'assets'; seen: Request[] = []; fetch(request: Request) { if (this.#brand !== 'assets') throw Error('receiver'); this.seen.push(request); return Promise.resolve(new Response('ok')); } }

describe('hostedServices native renderer wiring (unit-only composition: real constructor, no verify, no Browser Run/Clerk)', () => {
 const input = prepareHostedStaticInput(process.cwd());
 const inventory = input.inventory;
 const spoofed = { ...inventory, files: inventory.files.map((f, i) => i === 0 ? { ...f, sha256: 'sha256:' + '0'.repeat(64) } : f) };
 const truncated = { ...inventory, files: inventory.files.slice(1) };
 const worlds: ReturnType<typeof world>[] = [];
 afterAll(() => input.dispose());
 afterEach(() => {
  for (const w of worlds.splice(0)) w.db.sqlite.close();
  wiring.identity = null; wiring.ports = null; wiring.pins = null; wiring.created = []; wiring.verified = []; wiring.appOrigin = CONFIGURED_ORIGIN;
 });

 async function setup() {
  const w = world(); worlds.push(w);
  for (const path of ['tenancy/migrations/0001_tenant_case_grants.sql', 'tenancy/migrations/0002_tenant_grant_operations.sql',
   'publication/hosted/migrations/0001_publication_ledger.sql', 'publication/hosted/migrations/0002_atomic_publication.sql',
   'publication/hosted/migrations/0003_provenance_generation.sql', 'audit/migrations/0001_native_audit.sql']) {
   w.db.sqlite.exec(readFileSync(`src/lib/${path}`, 'utf8'));
  }
  // Every session is a distinct object so a session can never be mistaken for the raw primary binding.
  const sessions: { constraint: string; session: object }[] = [];
  const db = Object.assign(w.db, { withSession(constraint: 'first-primary') {
   const session = new Proxy(w.db, { get: (target, key) => { const v = Reflect.get(target, key, target); return typeof v === 'function' ? v.bind(target) : v; } });
   sessions.push({ constraint, session }); return session;
  } });
  if (w.identity.kind !== 'verified') throw new Error('synthetic identity');
  const identity: Extract<Identity, { kind: 'verified' }> = { ...w.identity,
   principal: { ...w.identity.principal, issuer: 'https://staff-issuer.test' }, async authorize(a) {
    expect(a.operation).toBe('read-preview'); expect(a.caseId).toBe(caseId);
   } };
  await provisionAuditBinding({ db, config: auditConfig({ clientId: ids.clientA, trustedIssuers: [identity.principal.issuer, 'https://client-issuer.test'], limits: auditLimits }), now: () => new Date() });
  for (const role of ['operator', 'publisher']) w.db.exec(`INSERT INTO tenant_case_grants
   (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, expires_at, version,
   created_operation_id, request, created_by_issuer, created_by_subject, created_at)
   VALUES (?, ?, 'case', ?, ?, ?, 'staff', ?, ?, 'active', NULL, 1, ?, '{}', ?, ?, ?)`,
   role, ids.clientA, caseId, identity.principal.issuer, identity.principal.subject, role, role, `grant-${role}`,
   identity.principal.issuer, identity.principal.subject, new Date().toISOString());
  const revision = await w.upload();
  const settings = (render: Settings) => ({ schema: 'clearcase.native-runtime/1', deployment,
   manifest: { staffIssuer: identity.principal.issuer, clients: [{ ...deployment, clientIssuer: 'https://client-issuer.test' }] },
   auditLimits, storageBudgets: BUDGETS, storageQuotas: QUOTAS, userWorkLimits: { maxStatementsPerBatch: 20, maxSnapshotBytes: 1 << 20 },
   intakeBudget: { maxFileBytes: BUDGETS.maxOriginalBytes, maxMetadataBytes: 4096 },
   importBudget: { maxFiles: BUDGETS.maxPackageFiles, maxFileBytes: BUDGETS.maxPackageFileBytes, maxPackageBytes: BUDGETS.maxPackageBytes, maxRequestBytes: 16 << 20 },
   ...(render === ABSENT ? {} : { nativeRenderBudget: render }) });
  return { w, db, identity, revision, sessions, settings };
 }
 type Setup = Awaited<ReturnType<typeof setup>>;

 // The request is hostile on purpose: foreign URL/host/origin and a body naming an origin, pins and a budget.
 const hostile = () => new Request('https://attacker.test/operator/publication/x/signoffs', { method: 'POST',
  headers: { origin: 'https://attacker.test', host: 'attacker.test', 'x-forwarded-host': 'attacker.test', 'content-type': 'application/json' },
  body: JSON.stringify({ appOrigin: 'https://attacker.test', pins: inventory, nativeRenderBudget: { ...RENDER, maxRunsPerCasePerDay: 2 } }) });
 async function compose(s: Setup, o: { env?: Record<string, unknown>; render?: Settings; pins?: unknown; origin?: string; request?: Request } = {}) {
  wiring.created = []; wiring.verified = []; wiring.ports = null;
  wiring.identity = s.identity; wiring.pins = o.pins === undefined ? inventory : o.pins; wiring.appOrigin = o.origin ?? CONFIGURED_ORIGIN;
  const ready = await hostedServices(o.request ?? hostile(), { CLEARCASE_CLIENT_ID: ids.clientA, DB: s.db, BUCKET: s.w.bucket,
   CLEARCASE_NATIVE_CONFIG: JSON.stringify(s.settings(o.render === undefined ? RENDER : o.render)), ...o.env });
  return { ready, created: [...wiring.created], ports: wiring.ports as NativeRequestCompositions | null };
 }
 /** Imports the synthetic package through the composed ports and reads the publication snapshot's required previews. */
 async function snapshotOf(s: Setup, ports: NativeRequestCompositions | null) {
  if (!ports?.imports || !ports.publication?.candidates) throw new Error('real composition unavailable');
  const importer = createNativeResultsImport(ports.imports)!;
  const token = await importer.admit({ identity: s.identity, caseId, access: 'write' });
  const result = await importer.importPackage(token, { operationId: 'render-wiring-import', submissionRevisionId: s.revision, files: s.w.pkg.files });
  if (result.kind !== 'linked') throw new Error(JSON.stringify(result));
  const snapshot = checkSnapshot(await ports.publication.candidates.read({ clientId: ids.clientA, caseId, candidateId: result.candidate.candidateId }));
  if (!snapshot) throw new Error('material unavailable');
  return { snapshot, candidateId: result.candidate.candidateId };
 }

 it('composes the real checker from the raw primary DB, exact BROWSER, configured origin, compiled inventory and six-field budget', async () => {
  const s = await setup(), browser = new Browser(), assets = new Assets();
  const { created, ports } = await compose(s, { env: { BROWSER: browser, ASSETS: assets } });
  expect(created).toHaveLength(1);
  const { options, checker } = created[0];
  expect(options.db).toBe(s.db);                       // the raw binding, never a pre-opened session
  expect(s.sessions.length).toBeGreaterThan(0);
  expect(s.sessions.every((x) => x.constraint === 'first-primary' && x.session !== options.db)).toBe(true);
  expect(options.browser).toBe(browser);
  expect(options.appOrigin).toBe(CONFIGURED_ORIGIN);   // not the hostile request's URL, Host, Origin or body
  expect(options.clientId).toBe(ids.clientA);
  expect(options.pins).toBe(inventory);
  expect(options.pins?.files).toHaveLength(191);
  expect(options.budget).toEqual(RENDER);
  expect(Object.keys(options.budget!).sort()).toEqual(['maxCanvasPixels', 'maxFileBytes', 'maxPages', 'maxRunMs', 'maxRunsPerCasePerDay', 'maxRunsPerClientPerDay']);
  expect(typeof options.now).toBe('function');
  expect(checker).not.toBeNull();                      // the real constructor accepted every piece
  expect(typeof checker!.verify).toBe('function');
  expect([browser.calls, assets.seen.length, wiring.verified.length]).toEqual([0, 0, 0]); // construction launches and fetches nothing
  expect(ports?.publication).not.toBeNull();
 });

 it('hands the composed checker to publication preview material, for the required PDF only', async () => {
  const s = await setup();
  const { created, ports } = await compose(s, { env: { BROWSER: new Browser(), ASSETS: new Assets() } });
  expect(created[0].checker).not.toBeNull();
  const { snapshot, candidateId } = await snapshotOf(s, ports);
  expect(wiring.verified).toHaveLength(1);
  expect(wiring.verified[0]).toMatchObject({ clientId: ids.clientA, caseId, candidateId, assetId: 'OD-001', mediaType: 'application/pdf' });
  expect(wiring.verified[0].bytes).toBeInstanceOf(Uint8Array);
  expect(snapshot.requiredPreviews).toEqual([{ assetId: 'OD-001', state: 'pending' }]); // only the unit spy answered: not a render
 });

 it('invokes the ASSETS adapter on the binding itself, directly and detached', async () => {
  const s = await setup(), assets = new Assets();
  const { created } = await compose(s, { env: { BROWSER: new Browser(), ASSETS: assets } });
  const adapter = created[0].options.assets!;
  const first = new Request('https://client-a.test/pdfjs/LICENSE'), second = new Request('https://client-a.test/pdfjs/pdf.min.mjs');
  expect(assets.seen).toEqual([]);                     // nothing fetched during construction
  expect(await (await adapter.fetch(first)).text()).toBe('ok');
  const { fetch } = adapter; await fetch(second);      // a private-field receiver rejects any other `this`
  expect(assets.seen).toHaveLength(2);
  expect(assets.seen[0]).toBe(first);
  expect(assets.seen[1]).toBe(second);
 });

 const bad = (extra: Record<string, unknown> = {}) => ({ BROWSER: new Browser(), ASSETS: new Assets(), ...extra });
 const impostors = { __CLEARCASE_PDF_ASSETS__: JSON.stringify(inventory), CLEARCASE_PDF_ASSETS: JSON.stringify(inventory), PDF_ASSETS: JSON.stringify(inventory),
  CLEARCASE_NATIVE_RENDER_BUDGET: JSON.stringify(RENDER), CLEARCASE_APP_ORIGIN: 'https://attacker.test' };
 const unavailable: [string, { env: Record<string, unknown>; render?: Settings; pins?: unknown; origin?: string }][] = [
  ['no compiled pins, with env pin/budget/origin impostors and a hostile body', { env: bad(impostors), pins: null }],
  ['a spoofed pin digest', { env: bad(), pins: spoofed }],
  ['a pin inventory missing a file', { env: bad(), pins: truncated }],
  ['no BROWSER', { env: { ASSETS: new Assets() } }],
  ['BROWSER without fetch', { env: bad({ BROWSER: { connect() {} } }) }],
  ['BROWSER with a non-function fetch', { env: bad({ BROWSER: { fetch: 'x' } }) }],
  ['no ASSETS', { env: { BROWSER: new Browser() } }],
  ['ASSETS as a string', { env: bad({ ASSETS: 'https://client-a.test' }) }],
  ['ASSETS with a non-function fetch', { env: bad({ ASSETS: { fetch: {} } }) }],
  ['no budget, despite an env budget impostor', { env: bad({ CLEARCASE_NATIVE_RENDER_BUDGET: JSON.stringify(RENDER) }), render: ABSENT }],
  ['a null budget', { env: bad(), render: null }],
  ['an array budget', { env: bad(), render: [1, 2, 3, 4, 5, 6] }],
  ['a five-field budget', { env: bad(), render: { ...RENDER, maxPages: undefined } as Settings }],
  ['a budget over a ceiling', { env: bad(), render: { ...RENDER, maxRunMs: 20_001 } }],
  ['a zero field', { env: bad(), render: { ...RENDER, maxRunMs: 0 } }],
  ['a fractional field', { env: bad(), render: { ...RENDER, maxPages: 1.5 } }],
  ['a numeric string field', { env: bad(), render: { ...RENDER, maxPages: '4' } }],
  ['a case limit above the client limit', { env: bad(), render: { ...RENDER, maxRunsPerCasePerDay: 3 } }],
  ['a non-https configured origin', { env: bad(), origin: 'http://client-a.test' }],
  ['a configured origin carrying a path', { env: bad(), origin: 'https://client-a.test/app' }],
 ];
 it.each(unavailable)('%s: no checker, so the required preview stays pending while import and publication still compose', async (_name, o) => {
  const s = await setup();
  const { created, ports } = await compose(s, o);
  expect(created).toHaveLength(1);
  expect(created[0].checker).toBeNull();               // no default quota, pin, origin or binding was supplied
  expect(ports?.imports).not.toBeNull();
  expect(ports?.publication).not.toBeNull();
  const { snapshot } = await snapshotOf(s, ports);
  expect(wiring.verified).toEqual([]);
  expect(snapshot.requiredPreviews).toEqual([{ assetId: 'OD-001', state: 'pending' }]);
  expect(signoffBlocker(snapshot)?.code).toBe('preview-not-ready');
 });

 it('composes nothing, and constructs no checker, when the DB binding cannot open a first-primary session', async () => {
  const s = await setup();
  const noSession = new Proxy(s.db, { get: (target, key) => { if (key === 'withSession') return undefined; const v = Reflect.get(target, key, target); return typeof v === 'function' ? v.bind(target) : v; } });
  wiring.identity = s.identity; wiring.pins = inventory;
  const ready = await hostedServices(hostile(), { CLEARCASE_CLIENT_ID: ids.clientA, DB: noSession, BUCKET: s.w.bucket,
   CLEARCASE_NATIVE_CONFIG: JSON.stringify(s.settings(RENDER)), BROWSER: new Browser(), ASSETS: new Assets() });
  expect(ready.ready).toBe(true);                      // sign-in stays reachable
  expect(wiring.created).toEqual([]);
  expect(wiring.ports).toBeNull();
 });

 it('rebuilds everything per request: no checker, binding, budget, origin or session carries over', async () => {
  const s = await setup();
  const browserA = new Browser(), assetsA = new Assets(), browserB = new Browser(), assetsB = new Assets();
  const other = { ...RENDER, maxPages: 2, maxRunsPerClientPerDay: 4 };
  const a = await compose(s, { env: { BROWSER: browserA, ASSETS: assetsA } });
  const sessionsA = s.sessions.splice(0);
  const b = await compose(s, { env: { BROWSER: browserB, ASSETS: assetsB }, render: other, origin: 'https://client-a.test' });
  expect(b.created[0].checker).not.toBe(a.created[0].checker);
  expect(b.created[0].options.browser).toBe(browserB);
  expect(b.created[0].options.budget).toEqual(other);
  expect(a.created[0].options.budget).toEqual(RENDER);  // the first request's budget was not rewritten
  await b.created[0].options.assets!.fetch(new Request('https://client-a.test/pdfjs/LICENSE'));
  expect([assetsA.seen.length, assetsB.seen.length]).toEqual([0, 1]);
  expect(s.sessions.length).toBeGreaterThan(0);          // a fresh session for the second request...
  expect(s.sessions.some((x) => sessionsA.some((y) => y.session === x.session))).toBe(false); // ...never the first one's
  expect(s.sessions.every((x) => x.session !== b.created[0].options.db)).toBe(true);
  // A valid request does not make the next request valid, nor an invalid one poison the next.
  const missing = await compose(s, { env: { ASSETS: new Assets() } });
  expect(missing.created[0].checker).toBeNull();
  const again = await compose(s, { env: { BROWSER: browserA, ASSETS: assetsA } });
  expect(again.created[0].checker).not.toBeNull();
  expect(again.created[0].checker).not.toBe(a.created[0].checker);
  const spoof = await compose(s, { env: { BROWSER: browserA, ASSETS: assetsA }, pins: spoofed });
  expect(spoof.created[0].checker).toBeNull();
 });

 it('keeps concurrent requests apart: each checker is bound to its own request bindings', async () => {
  const s = await setup(), t = await setup();
  const one = { browser: new Browser(), assets: new Assets() }, two = { browser: new Browser(), assets: new Assets() };
  wiring.identity = s.identity; wiring.pins = inventory; wiring.created = [];
  const call = (x: Setup, b: typeof one) => hostedServices(hostile(), { CLEARCASE_CLIENT_ID: ids.clientA, DB: x.db, BUCKET: x.w.bucket,
   CLEARCASE_NATIVE_CONFIG: JSON.stringify(x.settings(RENDER)), BROWSER: b.browser, ASSETS: b.assets });
  await Promise.all([call(s, one), call(t, two)]);
  const mine = (b: typeof one) => wiring.created.filter((c) => c.options.browser === b.browser);
  expect(wiring.created).toHaveLength(2);
  expect(mine(one)).toHaveLength(1); expect(mine(two)).toHaveLength(1);
  expect(mine(one)[0].options.db).toBe(s.db);
  expect(mine(two)[0].options.db).toBe(t.db);
  await mine(one)[0].options.assets!.fetch(new Request('https://client-a.test/pdfjs/LICENSE'));
  expect([one.assets.seen.length, two.assets.seen.length]).toEqual([1, 0]);
  expect(mine(one)[0].checker).not.toBe(mine(two)[0].checker);
 });
});
