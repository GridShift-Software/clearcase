#!/usr/bin/env bun
// Synthetic screenshots of the litigation views for the CC-08 report (product-visible changes), offline:
//   unshare -rn env OUTER_UID=$(id -u) OUTER_GID=$(id -g) tests/e2e/pilot/offline.sh bun tests/e2e/litigation/screens.mjs <out dir>
// Starts the production server on a fresh data directory, imports the litigation suite's synthetic case and saves one
// PNG per view (reached through the navigation, so the focused heading shows), plus the conflict check's no-match
// result. Synthetic data only.
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { launch } = await import('../pilot/lib/cdp.mjs');
const { appServer } = await import('../pilot/suite/context.mjs');
const { INIT, openPage, sleep } = await import('../pilot/suite/browser.mjs');
const { mainCase } = await import('./lib/cases.mjs');

const out = resolve(process.argv[2] ?? join(process.cwd(), '.local', 'cc08-screens'));
mkdirSync(out, { recursive: true });
const ROOT = resolve(join(import.meta.dirname, '..', '..', '..'));
const { VIEWS } = await import(join(ROOT, 'src', 'lib', 'components', 'view-registry.ts'));
const tmp = mkdtempSync(join(tmpdir(), 'cc08-screens-'));
const A = appServer({ name: 'screens', root: ROOT, buildDir: join(ROOT, 'build'), port: 43150, origPort: 43151, dir: tmp });
let b;
try {
	await A.start();
	const sc = await mainCase(join(tmp, 'case'));
	const imp = await A.c.importPkg(sc.caseDir, sc.pkgDir);
	await A.c.activate(imp.importId, { ack: true });
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	const p = await openPage(b, { initScript: INIT });
	await p.s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	const shot = async (name) => { const { data } = await p.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64')); console.log(join(out, `${name}.png`)); };
	for (const v of VIEWS.filter((x) => x.category === 'litigation')) {
		await p.goto(`${A.v(sc.resultsVersion)}/overview`, `document.querySelector('main#main')?.dataset.ready === 'overview'`);
		await p.click(`#nav-${v.id}`);
		await p.waitFor(`document.querySelector('main#main')?.dataset.ready === ${JSON.stringify(v.id)}`);
		await sleep(150);
		await shot(v.id);
	}
	await p.goto(`${A.v(sc.resultsVersion)}${VIEWS.find((x) => x.id === 'conflict_tab').route}`, `document.querySelector('main#main')?.dataset.ready === 'conflict_tab'`);
	await p.type('#confq', 'zzz');
	await p.click('#conf-check');
	await sleep(150);
	await shot('conflict_tab-no-match');
} finally {
	await b?.close().catch(() => {});
	await A.stop().catch(() => {});
	rmSync(tmp, { recursive: true, force: true });
}
