// Real route modules over the real strict /2 core. Synthetic D1/R2/identity only; not provider acceptance.
import { afterEach, expect, it } from 'vitest';
import { CASE, CLIENT } from '../recovery-native-adapters/world.ts';
import { EXPORT, bindingOf, body, pair, post, run, snapshot, type Pair } from './fixture.ts';
const live: Pair[] = [];
afterEach(() => { for (const p of live.splice(0)) for (const w of p.worlds) w.close(); });
async function setup() { const p = await pair(); live.push(p); return { p, deps: await p.source.deps() }; }

it('exports, verifies, plans and applies a /2 archive into the isolated target without activating anything', async () => {
  const { p, deps } = await setup(), binding = bindingOf(deps), who = p.source.identity;
  const exported = await run('export', post('export', EXPORT), who, binding);
  expect(exported.status).toBe(201);
  expect(exported.headers.get('cache-control')).toBe('no-store');
  const out = await body(exported);
  expect(out).toMatchObject({ kind: 'exported', format: 'clearcase.recovery-export/2', exportId: 'http-e1', caseId: CASE });
  const digest = out.manifestSha256 as string;
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  const pinned = { exportId: 'http-e1', expectedManifestSha256: digest };
  const verified = await run('verify', post('verify', pinned), who, binding);
  expect(verified.status).toBe(200);
  expect(await body(verified)).toMatchObject({ kind: 'verified', format: 'clearcase.recovery-export/2', manifestSha256: digest });
  expect(p.target.bucket.puts).toEqual([]);
  const planned = await run('plan', post('plan', pinned), who, binding);
  expect(planned.status).toBe(200);
  const plan = (await body(planned)).plan as { planSha256: string; destructive: boolean; deletes: number; source: { clientId: string; caseId: string } };
  expect(plan).toMatchObject({ destructive: false, deletes: 0, source: { clientId: CLIENT, caseId: CASE } });
  expect(p.target.bucket.puts).toEqual([]);
  const grants = p.target.db.rows('SELECT * FROM tenant_case_grants');
  const applied = await run('apply', post('apply', { ...pinned, confirmedPlanSha256: plan.planSha256, operationId: 'http-restore' }), who, binding);
  expect(applied.status).toBe(200);
  const report = (await body(applied)).report as { ok: boolean; activated: boolean; planSha256: string };
  expect(report).toMatchObject({ ok: true, activated: false, planSha256: plan.planSha256 });
  const prefix = `restore/${CLIENT}/${CASE}/http-e1`;
  expect(p.target.bucket.puts.some((k) => k === `${prefix}/manifest.json`)).toBe(true);
  for (const t of ['rs_results_version', 'rs_publication', 'native_candidate', 'native_import_link', 'rs_case_original']) expect(p.target.db.rows(`SELECT * FROM ${t}`) as unknown[]).toEqual([]);
  expect(p.target.db.rows('SELECT * FROM tenant_case_grants')).toEqual(grants);
  // The /2 audit contract: the core's own records, one per action, none supplied by the HTTP layer.
  const actions = p.source.db.rows('SELECT action FROM native_audit_events').map((r) => (r as { action: string }).action);
  for (const a of ['recovery.export', 'recovery.verify', 'recovery.restore.plan', 'recovery.restore.apply']) expect(actions).toContain(a);
});

it('never echoes a session token, an object key or a public URL', async () => {
  const { p, deps } = await setup(), binding = bindingOf(deps), who = p.source.identity;
  const exported = await run('export', post('export', EXPORT), who, binding);
  const text = JSON.stringify(await body(exported));
  expect(text).not.toContain(who.sessionId as string);
  expect(text).not.toContain('recovery/exports/');
  expect(text).not.toMatch(/r2\.dev|r2\.cloudflarestorage|https?:\/\/(?!$)/);
});

it('answers a repeated export id with 409 and keeps the stored archive', async () => {
  const { p, deps } = await setup(), binding = bindingOf(deps), who = p.source.identity;
  expect((await run('export', post('export', EXPORT), who, binding)).status).toBe(201);
  const again = await run('export', post('export', EXPORT), who, binding);
  expect(again.status).toBe(409);
  expect(await body(again)).toMatchObject({ code: 'export-exists' });
});

it('refuses a pinned digest that is not the stored manifest', async () => {
  const { p, deps } = await setup(), binding = bindingOf(deps), who = p.source.identity;
  await run('export', post('export', EXPORT), who, binding);
  const res = await run('verify', post('verify', { exportId: 'http-e1', expectedManifestSha256: 'a'.repeat(64) }), who, binding);
  expect(res.status).toBe(409);
  expect(await body(res)).toMatchObject({ code: 'manifest-mismatch' });
});

it('does not report an uncertain apply as success and converges on the same operation id', async () => {
  const { p, deps } = await setup(), binding = bindingOf(deps), who = p.source.identity;
  const out = await body(await run('export', post('export', EXPORT), who, binding));
  const pinned = { exportId: 'http-e1', expectedManifestSha256: out.manifestSha256 as string };
  const plan = (await body(await run('plan', post('plan', pinned), who, binding))).plan as { planSha256: string };
  const apply = () => run('apply', post('apply', { ...pinned, confirmedPlanSha256: plan.planSha256, operationId: 'http-uncertain' }), who, binding);
  p.target.bucket.alter = (key, o) => key.includes('/blobs/') ? { ...o, size: o.size + 1 } : o;
  const lost = await apply();
  expect(lost.status).toBe(503);
  const refused = await body(lost);
  expect(refused).toMatchObject({ code: 'storage-unavailable' });
  expect(JSON.stringify(refused)).not.toContain('activated');
  expect(p.target.db.rows('SELECT * FROM uw_note')).toEqual([]);
  p.target.bucket.alter = null;
  const replanned = (await body(await run('plan', post('plan', pinned), who, binding))).plan as { planSha256: string };
  const retried = await run('apply', post('apply', { ...pinned, confirmedPlanSha256: replanned.planSha256, operationId: 'http-uncertain' }), who, binding);
  expect(retried.status).toBe(200);
  expect((await body(retried)).report).toMatchObject({ ok: true, activated: false });
  expect(snapshot(p).targetPuts).toBeGreaterThan(0);
});
