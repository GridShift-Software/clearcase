// Shell-level scenarios of the M2 base (BASE-R2): the chronology's export file name read from the package's
// view-content (a neutral name and a visible note without it), and the narrow shell below 40rem (navigation stacked
// above the content) with the desktop layout unchanged. Synthetic packages only; screenshots under <out>/screens.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_NAME_NOTE } from '../../../../src/lib/local-case/results.server.ts';
import { buildCase } from '../lib/fixtures.ts';
import { firstUnimplemented, implementedViews, registryOf } from '../lib/implemented.mjs';
import { outDir } from '../lib/record.mjs';
import { openPage, sleep } from './browser.mjs';
import { ROWS, ready } from './main-flow.mjs';

const J = JSON.stringify;

/** A plain-text field of a built package's view-content dataset, or null (the expected value, never a literal). */
export const vcText = (sc, view, field) => {
	const f = sc.files.get('datasets/view-content.json');
	const v = f ? JSON.parse(new TextDecoder().decode(f)).data?.[view]?.[field] : undefined;
	return typeof v === 'string' ? v : null;
};

/** Click the chronology's export and return the browser downloads it began (CDP Browser.downloadWillBegin) and the note. */
async function chronologyExport(ctx, p, rv) {
	const { A, b } = ctx;
	await p.goto(`${A.v(rv)}/chronology`, `${ready('chronology')} && ${ROWS}.length > 0`);
	const n0 = b.events.downloads.length;
	await p.click('#export-csv');
	for (const t0 = Date.now(); b.events.downloads.length === n0 && Date.now() - t0 < 10000;) await sleep(25);
	await sleep(200);
	const notes = await p.evaluate(`[...document.querySelectorAll('[data-export-note]')].map((e) => ({ text: e.textContent.trim(), besideExport: e.closest('.page-actions')?.querySelector('#export-csv') !== null && !!e.closest('.page-actions') }))`);
	return { downloads: b.events.downloads.slice(n0).map((d) => d.suggestedFilename), notes };
}

/** The chronology export is named by the package's chronology.exportFileName; without it, chronology.csv and the note. */
export async function exportName(ctx) {
	const { A, p, main } = ctx;
	const expected = vcText(main, 'chronology', 'exportFileName');
	const named = await chronologyExport(ctx, p, main.resultsVersion);
	// a package built without viewer code carries no view-content fields: previewed as a candidate of its own case
	const neutral = (ctx.neutralCase = await buildCase(join(ctx.tmp, 'neutral'), { caseId: 'e2e-neutral', viewCode: false }));
	const imp = await A.c.importPkg(neutral.caseDir, neutral.pkgDir);
	if (!imp.importId) throw new Error(`neutral import failed: ${imp.status} ${imp.location}`);
	const generic = await chronologyExport(ctx, p, neutral.resultsVersion);
	const ok = typeof expected === 'string' && expected !== 'chronology.csv' && J(named.downloads) === J([expected]) && named.notes.length === 0 &&
		vcText(neutral, 'chronology', 'exportFileName') === null && J(generic.downloads) === J(['chronology.csv']) &&
		generic.notes.length === 1 && generic.notes[0].text === EXPORT_NAME_NOTE && generic.notes[0].besideExport;
	return { pass: ok, evidence: { packageName: expected, named, neutral: { resultsVersion: neutral.resultsVersion, import: imp.location, ...generic } } };
}

const LAYOUT = `(() => {
	const nav = document.querySelector('nav.views'), main = document.querySelector('main#main'), shell = document.querySelector('.case-shell');
	const n = nav.getBoundingClientRect(), m = main.getBoundingClientRect(), de = document.documentElement;
	return { vw: de.clientWidth, scrollWidth: de.scrollWidth, navPosition: getComputedStyle(nav).position, navBottom: n.bottom, navRight: n.right, navWidth: n.width,
		navMaxHeight: getComputedStyle(nav).maxHeight, navOverflowY: getComputedStyle(nav).overflowY, mainTop: m.top, mainLeft: m.left, mainWidth: m.width,
		columns: getComputedStyle(shell).gridTemplateColumns.split(' ').length, headerWrap: getComputedStyle(document.querySelector('header.top')).flexWrap };
})()`;

/** Below 40rem the navigation stacks above main, is not sticky and main spans the viewport; 1280 px keeps two columns. */
export async function narrowShell(ctx) {
	const { A, b, main } = ctx;
	const { views } = await registryOf(ctx.ROOT);
	const ex = firstUnimplemented(views, implementedViews(ctx.ROOT, views));
	const V = A.v(main.resultsVersion);
	const pages = [
		{ name: 'overview', url: `${V}/overview`, ready: ready('overview') },
		{ name: 'document', url: `${V}/doc/OD-001`, ready: ready('doc:OD-001') },
		...(ex ? [{ name: `unavailable:${ex.id}`, url: `${V}${ex.route}`, ready: ready(`view:${ex.id}`) }] : []),
	];
	const screens = join(outDir(), 'screens');
	mkdirSync(screens, { recursive: true });
	const p = await openPage(b);
	const out = {};
	try {
		for (const width of [320, 390, 1280]) {
			await p.s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 640 });
			for (const pg of pages) {
				await p.goto(pg.url, pg.ready);
				await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
				const l = await p.evaluate(LAYOUT);
				const shot = await p.s('Page.captureScreenshot', { format: 'png' });
				const file = join(screens, `narrow-${width}-${pg.name.replace(/[^a-z0-9_-]/gi, '_')}.png`);
				writeFileSync(file, Buffer.from(shot.data, 'base64'));
				const narrow = width < 560;
				const ok = narrow
					? l.columns === 1 && l.navPosition !== 'sticky' && l.navBottom <= l.mainTop + 0.5 && Math.abs(l.mainLeft) <= 0.5 && Math.abs(l.mainWidth - l.vw) <= 1 &&
						l.navOverflowY === 'auto' && l.navMaxHeight !== 'none' && l.headerWrap === 'wrap' && (pg.name !== 'overview' || l.scrollWidth <= l.vw)
					: l.columns === 2 && l.navPosition === 'sticky' && l.navRight <= l.mainLeft + 0.5 && l.mainTop < l.navBottom && l.headerWrap === 'nowrap';
				out[`${width}:${pg.name}`] = { ok, ...l, screenshot: file };
			}
		}
	} finally {
		await p.s('Emulation.clearDeviceMetricsOverride').catch(() => {});
		await p.close();
	}
	return { pass: Object.values(out).every((x) => x.ok), evidence: { example: ex?.id ?? 'none left', layouts: out } };
}
