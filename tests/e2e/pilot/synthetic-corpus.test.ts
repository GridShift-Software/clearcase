import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import { Value } from 'typebox/value';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, expect, it } from 'vitest';
import { Manifest } from '../../../src/lib/case-package/schema.ts';
import type { instance } from '../../../src/lib/local-case/app.server.ts';
import { cleanup, devServerLock, tempRoot } from '../../../src/lib/local-case/test-support.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const saved = { ...process.env };
let root: string | undefined;
let vite: ViteDevServer | undefined;
let http: Server | undefined;
let unlock: (() => void) | undefined;

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = netServer().listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => {
      if (error) reject(error);
      else if (!address || typeof address === 'string') reject(new Error('missing loopback address'));
      else resolve(address.port);
    });
  });
  server.on('error', reject);
});

afterAll(async () => {
  const errors: unknown[] = [];
  const attempt = async (shutdown: () => unknown) => {
    try { await shutdown(); } catch (error) { errors.push(error); }
  };
  try {
    await attempt(() => http && new Promise<void>((resolve, reject) => http?.close(error => error ? reject(error) : resolve())));
    await attempt(() => vite?.close());
    // Match the existing SSR harness: the Vite app instance survives module invalidation.
    const g = globalThis as { __clearcase?: ReturnType<typeof instance> };
    await attempt(() => g.__clearcase?.originals.close());
    await attempt(() => g.__clearcase?.app.shutdown());
    delete g.__clearcase;
  } finally {
    await attempt(() => root && cleanup(root));
    process.env = saved;
    await attempt(() => unlock?.());
  }
  if (errors.length) throw errors[0];
});

it('imports and activates the default synthetic corpus over HTTP and returns exactly 1,689 chronology rows', async () => {
  root = await tempRoot('synthetic-corpus');
  const out = path.join(root, 'corpus');
  // Exercise the public CLI defaults: 1,689 documents, default seed, small originals.
  const generated = spawnSync(process.execPath, [path.join(ROOT, 'scripts/fixtures/generate.ts'), '--out', out], {
    encoding: 'utf8', timeout: 20_000,
  });
  expect(generated.status, generated.stderr).toBe(0);
  const manifest = Value.Parse(Manifest, JSON.parse(await readFile(path.join(out, 'pkg/manifest.json'), 'utf8')));

  unlock = await devServerLock(ROOT);
  const port = await freePort();
  let originalsPort = await freePort();
  while (originalsPort === port) originalsPort = await freePort();
  Object.assign(process.env, {
    CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: String(port), ORIGINALS_PORT: String(originalsPort),
    CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000',
  });
  vite = await createServer({ root: ROOT, cacheDir: path.join(root, 'vite-cache'), configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  http = httpServer(vite.middlewares);
  await new Promise<void>((resolve, reject) => {
    http?.once('error', reject);
    http?.listen(port, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${port}`;
  expect((await fetch(`${origin}/api/health`)).status).toBe(200);
  const post = (route: string, body: URLSearchParams) => fetch(origin + route, {
    method: 'POST', redirect: 'manual', body,
    headers: { origin, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
  });

  const imported = await post('/import?/import', new URLSearchParams({
    caseFolder: path.join(out, 'case'), packageSource: path.join(out, 'pkg'),
  }));
  expect(imported.status, await imported.text()).toBe(303);
  const location = imported.headers.get('location');
  expect(location).toMatch(/^\/import\/\d+$/);
  if (!location) throw new Error('missing import redirect');
  const activated = await post(`${location}?/activate`, new URLSearchParams());
  expect(activated.status, await activated.text()).toBe(303);
  const version = encodeURIComponent(manifest.resultsVersion);
  expect(activated.headers.get('location')).toBe(`/v/${version}/overview`);
  const response = await fetch(`${origin}/api/v/${version}/chronology`);
  expect(response.status).toBe(200);
  const rows: unknown = await response.json();
  expect(Array.isArray(rows)).toBe(true);
  expect(rows).toHaveLength(1689);
});
