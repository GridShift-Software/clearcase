#!/usr/bin/env node
// Capture v5 workspace screens with no network, a fixed clock and a fixed timezone.
// Run it only through scripts/fixtures/capture-screens, which wraps it in `unshare -rn`.
//
//   node capture-screens.mjs --chrome BIN --html FILE --out DIR --plan PLAN.json
//
// Chromium is driven over --remote-debugging-pipe, so no socket is opened. The page is the v5 HTML from the
// local fixture; its own UI code runs (that is what a screen shows), but no archive processing script runs.
// PLAN.json: {"clock": "2026-10-08T09:00:00Z", "timezone": "UTC", "shots": [{"name": "...", "view": "<nav id>",
//   "storage": {"key": value}, "steps": ["<js run in the page after go(view)>"], "probe": "<js returning JSON>"}]}
// Writes DIR/<name>.png and DIR/capture.json with each shot's probe result and every non-file request seen.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
for (const k of ['chrome', 'html', 'out', 'plan']) if (!args[k]) { console.error(`missing --${k}`); process.exit(2); }
const plan = JSON.parse(readFileSync(args.plan, 'utf8'));
const profile = mkdtempSync(join(tmpdir(), 'cc01-chrome-'));
const chrome = spawn(args.chrome, [
  '--headless', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-component-update',
  '--disable-sync', '--metrics-recording-only', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,1000',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', (d) => { stderr += d; });
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];
let nextId = 1;
const pending = new Map();
const listeners = [];
let buf = Buffer.alloc(0);
fromChrome.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let i;
  while ((i = buf.indexOf(0)) >= 0) {
    const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
    buf = buf.subarray(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    } else listeners.forEach((fn) => fn(msg));
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  return new Promise((ok, fail) => pending.set(id, { ok, fail }));
}
const waitFor = (pred, ms = 20000) => new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error('timeout')), ms);
  listeners.push((m) => { if (pred(m)) { clearTimeout(t); ok(m); } });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Freeze Date: `new Date()` and Date.now() return the plan clock; explicit dates are untouched.
const clockScript = (iso) => `(() => { const T = Date.parse(${JSON.stringify(iso)}); const R = Date;
  class D extends R { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } }
  D.parse = R.parse; D.UTC = R.UTC; globalThis.Date = D; })();`;

const results = { clock: plan.clock, timezone: plan.timezone, html: resolve(args.html), shots: [], nonFileRequests: [] };
try {
  await sleep(300);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  listeners.push((m) => {
    if (m.method === 'Network.requestWillBeSent' && !/^(file|data|blob|about):/.test(m.params.request.url)) {
      results.nonFileRequests.push(m.params.request.url);
    }
  });
  await s('Network.enable');
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setTimezoneOverride', { timezoneId: plan.timezone });
  await s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await s('Page.addScriptToEvaluateOnNewDocument', { source: clockScript(plan.clock) });
  const url = pathToFileURL(resolve(args.html)).href;
  for (const shot of plan.shots) {
    const seed = `localStorage.clear(); ${Object.entries(shot.storage || {}).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`).join(' ')}`;
    const { identifier } = await s('Page.addScriptToEvaluateOnNewDocument', { source: seed });
    const loaded = waitFor((m) => m.method === 'Page.loadEventFired' && m.sessionId === sessionId);
    await s('Page.navigate', { url });
    await loaded;
    await s('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    const run = async (expr) => {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${shot.name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    await run(`go(${JSON.stringify(shot.view)})`);
    for (const step of shot.steps || []) { await run(step); await sleep(100); }
    await sleep(400);
    const probe = shot.probe ? await run(shot.probe) : null;
    const png = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(args.out, `${shot.name}.png`), Buffer.from(png.data, 'base64'));
    results.shots.push({ name: shot.name, view: shot.view, probe });
    console.log(`captured ${shot.name} (${shot.view})`);
  }
} catch (e) {
  results.error = String(e.stack || e);
  console.error(results.error, stderr.slice(-2000));
  process.exitCode = 1;
} finally {
  writeFileSync(join(args.out, 'capture.json'), JSON.stringify(results, null, 1) + '\n');
  chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
if (results.nonFileRequests.length) { console.error(`non-file requests: ${results.nonFileRequests.length}`); process.exitCode = 1; }
