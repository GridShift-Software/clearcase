#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { portOpen } from '../../e2e/pilot/lib/server.mjs';
import { sleep } from '../../e2e/pilot/lib/cdp.mjs';
const ROOT = resolve(import.meta.dirname, '../../..');
const { values: a } = parseArgs({ options: { out: { type: 'string' }, revision: { type: 'string' } } });
assert(a.out && a.revision, '--out and --revision are required');
if (process.env.CLEARCASE_OFFLINE !== '1') {
  const r = spawnSync('unshare', ['-rn', 'env', `OUTER_UID=${process.getuid()}`, `OUTER_GID=${process.getgid()}`, join(ROOT, 'tests/e2e/pilot/offline.sh'), process.execPath, import.meta.filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const out = resolve(a.out); mkdirSync(out, { recursive: true });
const stamp = JSON.parse(readFileSync(join(ROOT, 'build/clearcase-build.json')));
assert.equal(stamp.revision, a.revision); assert.equal(stamp.dirty, false); assert.equal(stamp.bun, '1.4.2');
const port = 43910, origPort = 43911;
const bare = spawnSync(process.execPath, ['build/index.js'], { cwd: ROOT, encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), ORIGINALS_PORT: String(origPort), CLEARCASE_DATA_DIR: join(out, 'bare-data') } });
assert.equal(bare.status, 1); assert.match(bare.stderr, /FATAL:.*not a supported ClearCase entry/);
assert.equal(existsSync(join(out, 'bare-data')), false);
assert.notEqual(await portOpen(port), true); assert.notEqual(await portOpen(origPort), true);
const bareListeners = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8' });
assert(!new RegExp(`:(${port}|${origPort})\\b`).test(bareListeners));
writeFileSync(join(out, 'bare-listeners.txt'), bareListeners);
const proc = spawn(process.execPath, ['run', '--bun', 'start'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, HOST: '0.0.0.0', PORT: String(port), ORIGINALS_PORT: String(origPort), CLEARCASE_DATA_DIR: join(out, 'data'), CLEARCASE_OFFLINE: '1' } });
let log = '', exited = null, health;
proc.stdout.on('data', d => log += d); proc.stderr.on('data', d => log += d); proc.on('exit', (code, signal) => exited = { code, signal });
const request = (path, { localAddress, host = `127.0.0.1:${port}`, headers = {}, hostname = '127.0.0.1' } = {}) => new Promise((resolve, reject) => {
  const req = http.get({ hostname, port, path, localAddress, headers: { host, ...headers }, agent: false }, r => { let body = ''; r.on('data', d => body += d); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body })); });
  req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
});
try {
  for (let t = Date.now(); !health && Date.now() - t < 15000;) {
    assert.equal(exited, null, JSON.stringify(exited));
    health = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json()).catch(() => null); await sleep(20);
  }
  assert(health); assert.equal(health.instance.bun, '1.4.2'); assert.deepEqual(health.instance.build, stamp);
  assert.equal(resolve(health.instance.dataDir), join(out, 'data'));
  assert.match(readFileSync(`/proc/${health.instance.pid}/cmdline`, 'utf8'), /scripts\/pilot\/start.ts/);
  assert.equal(health.pragmas.main.journal_mode, 'wal'); assert.equal(health.pragmas.work.journal_mode, 'delete');
  assert.equal(health.pragmas.main.synchronous, 2); assert.equal(health.pragmas.work.synchronous, 2);
  const listeners = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8' });
  const lines = listeners.split('\n').filter(l => new RegExp(`:(${port}|${origPort})\\b`).test(l));
  assert.equal(lines.length, 2); assert(lines.every(l => l.includes('127.0.0.1:')));
  writeFileSync(join(out, 'documented-listeners.txt'), listeners);
  for (const path of ['/import', '/api/health', '/favicon.svg']) assert.equal((await request(path, { host: `evil.example:${port}` })).status, 421);
  const forwarded = [];
  for (const headers of [{}, { 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1;host=127.0.0.1' }, { 'x-forwarded-for': '::ffff:127.0.0.1', forwarded: 'for="[::ffff:127.0.0.1]"' }]) {
    assert.equal((await request('/api/health', { headers })).status, 200);
    if (process.env.CC24_CLIENT_ADDR) {
      const r = await request('/api/health', { localAddress: process.env.CC24_CLIENT_ADDR, headers });
      assert.equal(r.status, 403); assert.match(r.body, /loopback clients/); forwarded.push({ headers, status: r.status });
    }
  }
  assert.equal((await request('/api/health', { hostname: '::ffff:127.0.0.1' })).status, 200);
  if (process.env.CC24_CLIENT_ADDR) {
    assert.notEqual(await portOpen(port, process.env.CC24_CLIENT_ADDR), true);
    assert.notEqual(await portOpen(origPort, process.env.CC24_CLIENT_ADDR), true);
  }
  const api = await request('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } });
  const encoded = await request('/%61pi/state', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(api.status, 403); assert.equal(encoded.headers['cross-origin-resource-policy'], 'same-origin'); assert.equal(encoded.headers['access-control-allow-origin'], undefined);
  const result = { revision: a.revision, build: stamp, F1: 'fixed', bare: { exit: bare.status, message: bare.stderr.trim(), listeners: [], dataCreated: false }, documented: { health, listeners: lines }, nonLoopbackClients: forwarded, mappedLoopback: 200, SH1: { api: api.status, encoded: encoded.status, CORP: encoded.headers['cross-origin-resource-policy'], CORS: false } };
  writeFileSync(join(out, 'results.json'), JSON.stringify(result, null, 2));
  console.log('PASS: bare Bun entry refuses; documented Bun entry has two loopback listeners, exact Host guard and FULL SQLite pragmas');
  if (forwarded.length) console.log('PASS: four non-loopback client probes refused despite forwarded headers; mapped loopback accepted');
} finally {
  if (health?.instance?.pid) try { process.kill(health.instance.pid, 'SIGTERM'); } catch {}
  for (let t = Date.now(); !exited && Date.now() - t < 8000;) await sleep(20);
  if (!exited) { proc.kill('SIGKILL'); if (health?.instance?.pid) try { process.kill(health.instance.pid, 'SIGKILL'); } catch {} }
  writeFileSync(join(out, 'server.log'), log);
}
assert.equal(exited?.code, 0); assert.notEqual(await portOpen(port), true); assert.notEqual(await portOpen(origPort), true);
