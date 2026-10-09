#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildCase } from '../../e2e/pilot/lib/fixtures.ts';
import { buildPackage, writePackageDir } from '../../../src/lib/case-package/writer.ts';
import { startServer } from '../../e2e/pilot/lib/server.mjs';
import { client, vpath } from '../../e2e/pilot/lib/client.mjs';
import { proveOffline } from '../../e2e/pilot/lib/netproof.mjs';
import { startCanary } from '../../e2e/pilot/lib/canary.mjs';
import { launch, sleep, DISABLED_FEATURES } from '../../e2e/pilot/lib/cdp.mjs';
import { openPage } from '../../e2e/pilot/v5/browser.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const { values: a } = parseArgs({ options: { out: { type: 'string' }, revision: { type: 'string' } } });
assert(a.out && a.revision, '--out and --revision are required');
if (process.env.CLEARCASE_OFFLINE !== '1') {
  const r = spawnSync('unshare', ['-rn', 'env', `OUTER_UID=${process.getuid()}`, `OUTER_GID=${process.getgid()}`, 'CANARY_PORT=43999', join(ROOT, 'tests/e2e/pilot/offline.sh'), process.execPath, import.meta.filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const out = resolve(a.out); mkdirSync(out, { recursive: true });
const stamp = JSON.parse(readFileSync(join(ROOT, 'build/clearcase-build.json')));
assert.equal(stamp.revision, a.revision); assert.equal(stamp.dirty, false); assert.equal(stamp.bun, '1.4.2');
assert.equal((await proveOffline()).pass, true);
const results = [];
const record = async (id, fn) => {
  try { const evidence = await fn(); results.push({ id, status: 'PASS', evidence }); console.log(`PASS ${id}`); }
  catch (e) { results.push({ id, status: 'FAIL', error: String(e.stack ?? e) }); console.error(`FAIL ${id}: ${e.message}`); }
  writeFileSync(join(out, 'results.json'), JSON.stringify({ revision: a.revision, build: stamp, results }, null, 2));
};
const code = "localStorage.setItem('cc24-vc-executed','yes');fetch('http://127.0.0.1:43999/executed');new Image().src='http://evil.example/vc'";
const script = `<script>${code}</script>`;
const image = `<img src="http://evil.example/vc" onerror="${code}">`;
const url = 'javascript:localStorage.setItem("cc24-vc-executed","yes")';
const title = '</title><script>1</script>';
const excerpt = `${image} ${script} ${url}`;
const also = `<img onerror="${code}">`;
const base = await buildCase(join(out, 'base'), { caseId: 'cc24-view-content', edit: r => {
  r.DATA.chronology[0].excerpt = excerpt;
  r.DATA.chronology[0].also_in = [also];
} });
const manifest = JSON.parse(Buffer.from(base.files.get('manifest.json')).toString());
const assets = JSON.parse(Buffer.from(base.files.get('assets.json')).toString()).assets;
const datasets = [...base.files].filter(([p]) => p.startsWith('datasets/')).map(([, b]) => {
  const { key, kind, schema, required, provenance, data } = JSON.parse(Buffer.from(b).toString());
  return { key, kind, schema, required, provenance, data };
}).filter(d => d.key !== 'view-content');
async function variant(name, content, invalidMeta = false) {
  const extra = content === undefined ? [] : [{ key: 'view-content', kind: 'generated', schema: 'v5.view-content@1', required: false, provenance: { source: 'generated', sourcePath: '(synthetic)', adapter: 'cc24' }, data: content }];
  const p = buildPackage({ caseId: manifest.case.id, caseLabel: manifest.case.label, inputKind: manifest.inputRevision.kind, sources: manifest.inputRevision.sources, claims: manifest.inputRevision.claims, producer: manifest.producer, created: manifest.created, datasets: [...datasets.map(d => invalidMeta && d.key === 'meta' ? { ...d, data: { ...d.data, emails: script, people: url } } : d), ...extra], assets });
  const dir = join(out, name); await writePackageDir(dir, p.files);
  return { dir, rv: p.manifest.resultsVersion };
}
const hostile = await variant('hostile', { overview: { subtitle: script, kpiDocumentsNote: { template: [image, ' ', { param: 'bundleCount' }] }, kpiInvoicesNote: url }, _shell: { documentTitle: title, brandName: image } });
const absent = await variant('absent', undefined);
const neutral = await variant('nontext', { overview: { subtitle: 7, kpiDocumentsNote: { template: [{ param: 'unknown' }] }, kpiInvoicesNote: [] }, _shell: { documentTitle: 7, brandName: [] } });
const malformed = await variant('malformed', { overview: { subtitle: { template: [{ param: 5 }] } } });
const invalidCounts = await variant('invalid-counts', undefined, true);
const c = client(43900);
let srv, browser, canary, page;
const start = () => startServer({ root: ROOT, port: 43900, origPort: 43901, dataDir: join(out, 'data'), buildDir: join(ROOT, 'build'), logFile: join(out, 'server.log') });
try {
  srv = await start();
  assert.deepEqual(srv.health.instance.build, stamp);
  canary = await startCanary();
  browser = await launch({ profileRoot: join(out, 'profiles'), extra: [`--disable-features=${DISABLED_FEATURES},NetworkTimeServiceQuerying`] });
  page = await openPage(browser);
  await page.goto('http://127.0.0.1:43999/control'); await sleep(100);
  assert(canary.hits.some(h => h.path === '/control'));
  assert(browser.events.requests.some(r => r.url === 'http://127.0.0.1:43999/control'));
  const mark = browser.mark();
  await record('view-content-text-through-production-app', async () => {
    const imp = await c.importPkg(base.caseDir, hostile.dir);
    assert(Number.isInteger(imp.importId)); assert.notEqual((await c.report(imp.importId)).verdict, 'reject');
    assert.equal((await c.activate(imp.importId)).status, 303);
    await page.goto(c.origin + vpath(hostile.rv) + '/overview', 'document.querySelector("main[data-ready=overview]")');
    const observed = await page.evaluate(`({ subtitle:document.querySelector('.subtitle').textContent, brand:document.querySelector('#case-brand').textContent, docs:document.querySelector('[aria-labelledby=kpi-docs] small').textContent, invoices:document.querySelector('[aria-labelledby=kpi-inv] small').textContent, title:document.title, dateSpan:document.querySelector('#date-span').textContent, count:document.querySelector('#count-documents').dataset.count, bad:document.querySelectorAll('main script,main img,nav.views img,head script:not([src]):not([nonce])').length })`);
    assert.equal(observed.subtitle, script); assert.equal(observed.brand, image);
    assert(observed.docs.includes(image)); assert(observed.invoices.includes(url));
    assert.equal(observed.title, `Overview · ${title} · ClearCase`);
    assert.equal(observed.bad, 0); assert.equal(observed.count, '7'); assert.match(observed.dateSpan, /Date span:.*2 emails.*1 correspondents/);
    assert.equal(await page.evaluate("!!document.querySelector('main img,nav.views img')"), false);
    assert.equal(await page.evaluate("localStorage.getItem('cc24-vc-executed')"), null);
    await page.shot(join(out, 'hostile-overview.png'));
    await page.goto(c.origin + vpath(hostile.rv) + '/chronology', 'document.querySelector("main[data-ready=chronology]")');
    await page.settled('true');
    const row = await page.evaluate(`(() => { const r=document.querySelector('[data-ref="OD-001"]');return { excerpt:r.querySelector('.excerpt').textContent, title:r.querySelector('.excerpt').getAttribute('title'), also:r.querySelector('.also-in').textContent, elements:r.querySelectorAll('script,img,a[href^="javascript:"]').length, titleText:document.title, count:document.querySelector('#row-count').dataset.count }; })()`);
    assert.equal(row.excerpt, excerpt.slice(0, 140) + '…'); assert.equal(row.title, excerpt);
    assert.equal(row.also, 'also in: ' + also); assert.equal(row.elements, 0); assert.equal(row.count, '7');
    assert.equal(row.titleText, `Chronology · ${title} · ClearCase`);
    await page.shot(join(out, 'hostile-chronology.png'));
    return { observed, row, titleIsText: true };
  });
  await record('missing-and-nontext-view-content-neutral-layout', async () => {
    const evidence = [];
    for (const p of [absent, neutral]) {
      const imp = await c.importPkg(base.caseDir, p.dir); assert(Number.isInteger(imp.importId));
      assert.notEqual((await c.report(imp.importId)).verdict, 'reject');
      await page.goto(c.origin + vpath(p.rv) + '/overview', 'document.querySelector("main[data-ready=overview]")');
      const v = await page.evaluate(`({ subtitle:document.querySelector('.subtitle').textContent, brand:document.querySelector('#case-brand').textContent, title:document.title, count:document.querySelector('#count-documents').dataset.count, captions:document.body.innerText.includes('(source caption)') })`);
      assert.equal(v.subtitle, 'Synthetic matter'); assert.equal(v.brand, 'cc24-view-content');
      assert.equal(v.title, 'Overview · cc24-view-content · ClearCase'); assert.equal(v.count, '7'); assert.equal(v.captions, false);
      assert.equal(await c.activeVersion(), hostile.rv); evidence.push(v);
    }
    return evidence;
  });
  await record('malformed-view-content-rejected-active-case-preserved', async () => {
    const imp = await c.importPkg(base.caseDir, malformed.dir); assert(Number.isInteger(imp.importId));
    const rep = await c.report(imp.importId); assert.equal(rep.verdict, 'reject'); assert.equal(rep.canActivate, false);
    assert.equal(await c.activeVersion(), hostile.rv);
    assert.equal((await c.get(vpath(hostile.rv) + '/overview')).status, 200);
    return { verdict: rep.verdict, codes: rep.codes, activePreserved: true };
  });
  await record('noninteger-date-span-counts-rejected', async () => {
    const imp = await c.importPkg(base.caseDir, invalidCounts.dir); assert(Number.isInteger(imp.importId));
    const rep = await c.report(imp.importId); assert.equal(rep.verdict, 'reject'); assert.equal(rep.codes.DS_SHAPE_INVALID, 'error'); assert.equal(rep.canActivate, false);
    assert.equal(await c.activeVersion(), hostile.rv);
    return { verdict: rep.verdict, codes: rep.codes, activePreserved: true };
  });
  await record('no-execution-no-page-egress', async () => {
    await sleep(300);
    assert.equal(await page.evaluate("localStorage.getItem('cc24-vc-executed')"), null);
    const requests = browser.events.requests.slice(mark.requests).filter(r => !r.url.startsWith(c.origin + '/') && !r.url.startsWith('data:') && !r.url.startsWith('about:'));
    assert.deepEqual(requests, []); assert.equal(canary.hits.filter(h => h.path === '/executed').length, 0);
    return { requests: 0, executionCanaryHits: 0, positiveControl: true };
  });
} finally {
  await browser?.close(); await canary?.close(); if (srv) await srv.stop();
}
assert.equal(results.length, 5); assert(results.every(r => r.status === 'PASS'), 'view-content acceptance failed');
