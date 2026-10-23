// GRS-97 viewer evaluation runner. Run it under the host browser lock:
//   orch-bin/browser-lock bun harness/run.mjs [--only pdf,image,...] [--skip-large]
// It imports every fixture, serves the protected shell, drives Chrome for Testing through each family's checks at the
// required viewports, and writes .local/viewer-evaluation/results.json and results.md (PASS/FAIL per fixture and
// check, with the assertion that decided it, at the exact Git revision of this harness).
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStore, importAll } from './import.mjs';
import { startServer } from './server.mjs';
import { launch, openShell, rendererFrame, VIEWPORTS } from './browser.mjs';
import { HERE, OUT_ROOT, REPO } from './paths.mjs';
import { CHECKS } from './checks/index.mjs';
import { gitEnv } from '../../../scripts/browser-lock.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const onlyViewport = args.includes('--viewport') ? args[args.indexOf('--viewport') + 1] : null;
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', env: gitEnv() }).trim();
const revision = { head: git('rev-parse', 'HEAD'), harnessTree: (() => { try { return git('rev-parse', 'HEAD:tests/viewer-evaluation'); } catch { return null; } })(), dirty: git('status', '--porcelain', '--untracked-files=all', '--', 'tests/viewer-evaluation') !== '' };

const store = createStore(path.join(OUT_ROOT, 'fixtures'));
const descriptors = await importAll(store);
const { server, origin, log } = startServer({ descriptors, assets: store.assets });
const browser = await launch();
const browserVersion = browser.version();
const results = [];
const shots = path.join(OUT_ROOT, 'screenshots');
const progress = path.join(OUT_ROOT, 'progress.log');
writeFileSync(progress, '');
mkdirSync(shots, { recursive: true });

/** Context handed to every check. */
function ctx(viewport, session) {
  const { page, mon } = session;
  const c = {
    viewport, page, mon, origin, descriptors, store, serverLog: log,
    record(family, fixture, component, check, pass, assertion, observed) {
      results.push({ family, fixture, component, viewport, check, verdict: pass === null ? 'HOLD' : pass ? 'PASS' : 'FAIL', assertion, observed: observed === undefined ? null : JSON.parse(JSON.stringify(observed ?? null)) });
      appendFileSync(progress, `${new Date().toISOString().slice(11, 19)} ${results.at(-1).verdict} ${viewport} ${fixture} ${check}\n`);
    },
    async open(id, target, opts) { return page.evaluate(([i, t, o]) => window.__shell.open(i, t, o), [id, target ?? { kind: 'file' }, opts ?? {}]); },
    async navigate(target) { return page.evaluate((t) => window.__shell.navigate(t), target); },
    frame: () => rendererFrame(page),
    async rstate() { const f = rendererFrame(page); return f ? f.evaluate(() => (window.__r ? JSON.parse(JSON.stringify(window.__r)) : null)).catch(() => null) : null; },
    async inFrame(fn, arg) { const f = rendererFrame(page); if (!f) throw new Error('no renderer frame'); return f.evaluate(fn, arg); },
    async shot(name) { const file = path.join(shots, `${viewport}-${name.replace(/[^\w.-]+/g, '_')}.png`); await page.screenshot({ path: file }); return path.relative(REPO, file); },
    egressSince(n) { return mon.egress.slice(n); },
    /** Serve an existing asset under a second id with a patched descriptor (a mapping, a version bump). */
    alias(id, newId, patch) { store.assets.set(newId, store.assets.get(id)); descriptors.set(newId, { ...structuredClone(descriptors.get(id)), assetId: newId, ...patch }); return newId; },
  };
  return c;
}

try {
  for (const viewport of Object.keys(VIEWPORTS).filter((v) => !onlyViewport || v === onlyViewport)) {
    for (const [family, check] of Object.entries(CHECKS)) {
      if (only && !only.includes(family)) continue;
      const session = await openShell(browser, origin, viewport);
      const t0 = Date.now();
      let watchdog;
      try { await Promise.race([check(ctx(viewport, session), { full: viewport === 'desktop-1440x900', skipLarge: args.includes('--skip-large') }), new Promise((_, j) => { watchdog = setTimeout(() => j(new Error(`family ${family} exceeded 10 minutes at ${viewport}`)), 600000); })]); } catch (err) {
        results.push({ family, fixture: '(check crashed)', component: '-', viewport, check: 'harness', verdict: 'FAIL', assertion: 'check completes', observed: String(err.stack ?? err).slice(0, 600) });
      }
      clearTimeout(watchdog);
      const m = session.mon;
      results.push({ family, fixture: '(session)', component: 'shell', viewport, check: 'containment: no egress, dialogs, popups or top navigation during the session', verdict: !m.egress.length && !m.dialogs.length && !m.popups.length && !m.topNavigations.length ? 'PASS' : 'FAIL', assertion: 'egress=[] dialogs=[] popups=[] topNavigations=[]', observed: { egress: m.egress, dialogs: m.dialogs, popups: m.popups, topNavigations: m.topNavigations, seconds: Math.round((Date.now() - t0) / 1000) } });
      await session.context.close();
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}

const out = { revision, browser: { name: 'Chrome for Testing (Playwright install)', version: browserVersion, driver: `playwright-core ${JSON.parse(readFileSync(path.join(HERE, 'node_modules', 'playwright-core', 'package.json'), 'utf8')).version}`, headless: true }, network: process.env.CLEARCASE_OFFLINE === '1' ? 'offline: tests/e2e/pilot/offline.sh (loopback only)' : 'host network (page egress aborted by the context router)', viewports: VIEWPORTS, hold: ['Firefox: not installed', 'WebKit: not installed', 'real iOS Safari: no device', 'real Android Chrome: no device'], generatedAt: new Date().toISOString(), results };
writeFileSync(path.join(OUT_ROOT, 'results.json'), JSON.stringify(out, null, 1));
const fam = {};
for (const r of results) { const k = r.family; fam[k] ??= { PASS: 0, FAIL: 0, HOLD: 0 }; fam[k][r.verdict]++; }
const lines = [`# Viewer evaluation results`, '', `Harness revision ${revision.head} (tests/viewer-evaluation tree ${revision.harnessTree}${revision.dirty ? ', DIRTY' : ''}); ${out.browser.name} ${out.browser.version}; ${out.network}`, '', '| Family | PASS | FAIL | HOLD |', '|---|---|---|---|', ...Object.entries(fam).map(([k, v]) => `| ${k} | ${v.PASS} | ${v.FAIL} | ${v.HOLD} |`), '', '| Verdict | Viewport | Family | Fixture | Component | Check | Assertion |', '|---|---|---|---|---|---|---|', ...results.map((r) => `| ${r.verdict} | ${r.viewport} | ${r.family} | ${r.fixture} | ${r.component} | ${r.check} | ${String(r.assertion).replace(/\|/g, '\\|')} |`)];
writeFileSync(path.join(OUT_ROOT, 'results.md'), lines.join('\n') + '\n');
for (const [k, v] of Object.entries(fam)) console.log(`${k.padEnd(10)} PASS ${v.PASS}  FAIL ${v.FAIL}  HOLD ${v.HOLD}`);
console.log(`revision ${revision.head}${revision.dirty ? ' (dirty harness)' : ''}; results in ${path.relative(REPO, OUT_ROOT)}/results.{json,md}`);
process.exit(results.some((r) => r.fixture === '(check crashed)') ? 1 : 0);
