// GRS-281: staging answered 500 to every download of an original over 100 MB. That path signs a 10-minute R2 URL with
// the account id from the Worker var R2_S3_ACCOUNT_ID, which deploy/staging/wrangler.jsonc never set, so signing threw.
// These tests drive the real original route with the staging config's own vars and synthetic stand-ins for its two R2
// secrets, so a var the download path reads and the config lacks fails here, not on staging.
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
const ENV = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('cloudflare:workers', () => ({ env: ENV }));
import { originalWorld } from './08-world';

const staging = JSON.parse(readFileSync('deploy/staging/wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const SECRETS = { R2_S3_ACCESS_KEY_ID: 'synthetic-r2-key-id', R2_S3_SECRET_ACCESS_KEY: 'synthetic-r2-secret', CLEARCASE_ASSET_TICKET_KEY: 'k'.repeat(64) };
const SHA = 'a'.repeat(64), LARGE = 258_000_000, DOWNLOAD = '/cases/case-a/originals/asset-a?download=1';
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

async function largeWorld(env: Record<string, unknown>) {
  for (const key of Object.keys(ENV)) delete ENV[key];
  Object.assign(ENV, env);
  const w = await originalWorld();
  w.dep.db.exec('UPDATE rs_original SET size = ? WHERE sha256 = ?', LARGE, SHA);
  return w;
}
afterEach(() => vi.restoreAllMocks());

it('sends a 258 MB download to a 10-minute presigned URL for exactly its object on the EU endpoint, and audits it', async () => {
  const w = await largeWorld({ ...staging.vars, ...SECRETS });
  const r = await w.get(w.identity, DOWNLOAD);
  expect(r.status).toBe(302);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  const href = new URL(r.headers.get('location')!);
  expect(href.origin).toBe(`https://${staging.account_id}.eu.r2.cloudflarestorage.com`);
  expect(href.pathname).toBe(`/${staging.r2_buckets[0].bucket_name}/orig/${SHA}`);
  expect(href.searchParams.get('X-Amz-Credential')).toMatch(/^synthetic-r2-key-id\/\d{8}\/auto\/s3\/aws4_request$/);
  expect(href.searchParams.get('X-Amz-Expires')).toBe('600');
  expect(href.searchParams.get('response-content-disposition')).toBe('attachment');
  expect(href.toString()).not.toContain(SECRETS.R2_S3_SECRET_ACCESS_KEY);
  await settled();
  expect(w.events.at(-1)).toMatchObject({ action: 'asset.read-original', object: { kind: 'asset', id: 'asset-a', caseId: 'case-a' }, outcome: 'succeeded' });
});

it('gives a principal without a grant on the case no presigned URL', async () => {
  const w = await largeWorld({ ...staging.vars, ...SECRETS });
  if (w.identity.kind !== 'verified') throw new Error('identity');
  const r = await w.get({ ...w.identity, principal: { ...w.identity.principal, subject: 'no-grant' } }, DOWNLOAD)
    .catch((e) => { if (isHttpError(e)) return new Response(null, { status: e.status }); throw e; });
  expect(r.status).toBe(404);
  expect(r.headers.get('location')).toBeNull();
  await settled();
  expect(w.events.at(-1)).toMatchObject({ action: 'asset.read-original', outcome: 'denied' });
});

it('gives the Worker and every preview the same R2 account as the bucket the download path signs for', () => {
  expect(staging.account_id).toMatch(/^[a-f0-9]{32}$/);
  expect(staging.r2_buckets).toEqual([expect.objectContaining({ bucket_name: 'clearcase-staging-files', jurisdiction: 'eu' })]);
  expect(JSON.parse(staging.vars.CLEARCASE_NATIVE_CONFIG).deployment.r2Bucket).toBe('clearcase-staging-files');
  expect(staging.vars.R2_S3_ACCOUNT_ID).toBe(staging.account_id);
  expect(staging.previews.vars.R2_S3_ACCOUNT_ID).toBe(staging.account_id);
});

it('answers 503 without the R2 account, audits the failure and logs only the missing binding names', async () => {
  const { R2_S3_ACCOUNT_ID: _account, ...vars } = { R2_S3_ACCOUNT_ID: undefined, ...staging.vars };
  const w = await largeWorld({ ...vars, ...SECRETS });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const r = await w.get(w.identity, DOWNLOAD);
  expect(r.status).toBe(503);
  expect(r.headers.get('location')).toBeNull();
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(logged.mock.calls).toEqual([['download-unavailable', { unset: ['R2_S3_ACCOUNT_ID'] }]]);
  await settled();
  expect(w.events.at(-1)).toMatchObject({ action: 'asset.read-original', outcome: 'failed' });
});
