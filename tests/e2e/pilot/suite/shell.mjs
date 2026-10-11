// Shell-level scenarios of the M2 base (BASE-R2): the chronology's export file name read from the package's
// view-content (a neutral name and a visible note without it), and the narrow shell at most 40rem wide (navigation
// stacked above the content) with the desktop layout unchanged. Synthetic packages only; screenshots under <out>/screens.
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
		columns: getComputedStyle(shell).gridTemplateColumns.split(' ').length, headerWrap: getComputedStyle(document.querySelector('header.top')).flexWrap,
		banners: [...document.querySelectorAll('.banner')].map((e) => e.textContent) };
})()`;

/** A valid case id at the CASE_ID limit (64 characters) with no break opportunity: no hyphen, dot or space. */
const UNBROKEN_ID = 'syn_unbroken_case_id_'.padEnd(64, '0123456789abcdefghijklmnopqrstuvwxyz');
/** Tab from a fresh page through the navigation: each focused nav link, whether it is inside the nav box and the viewport. */
async function tabThroughNav(p) {
	const links = await p.evaluate(`document.querySelectorAll('nav.views a').length`);
	const seen = [];
	for (let i = 0; i < links + 20 && seen.length < links; i++) {
		await p.key('Tab');
		const f = await p.evaluate(`(() => {
			const a = document.activeElement, nav = document.querySelector('nav.views');
			if (!nav.contains(a)) return null;
			const r = a.getBoundingClientRect(), n = nav.getBoundingClientRect();
			return { id: a.id, inNav: r.top >= n.top - 0.5 && r.bottom <= n.bottom + 0.5,
				inViewport: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5, scrollX };
		})()`);
		if (f) seen.push(f);
	}
	return { links, focused: seen.length, ok: links > 0 && seen.length === links && seen.every((f) => f.inNav && f.inViewport && f.scrollX === 0),
		outside: seen.filter((f) => !(f.inNav && f.inViewport && f.scrollX === 0)) };
}

/**
 * At most 40rem (640 px) the navigation stacks above main, is not sticky and main spans the viewport; 641 and 1280 px
 * keep two columns. At 390 px Tab reaches every nav link inside the nav box and the viewport, with no sideways scroll.
 * A case whose 64-character id has no break opportunity does not make its pages scroll sideways at 320 or 390 px. The
 * chronology's wide grid scrolls inside its own box: the document's scrollWidth equals the viewport at 320, 390 and 640 px.
 */
export async function narrowShell(ctx) {
	const { A, b, main } = ctx;
	const unbroken = await buildCase(join(ctx.tmp, 'unbroken-id'), { caseId: UNBROKEN_ID });
	const imp = await A.c.importPkg(unbroken.caseDir, unbroken.pkgDir);
	if (!imp.importId) throw new Error(`unbroken-id import failed: ${imp.status} ${imp.location}`);
	const { views } = await registryOf(ctx.ROOT);
	const ex = firstUnimplemented(views, implementedViews(ctx.ROOT, views));
	const V = A.v(main.resultsVersion);
	const pages = [
		{ name: 'overview', url: `${V}/overview`, ready: ready('overview') },
		{ name: 'document', url: `${V}/doc/OD-001`, ready: ready('doc:OD-001') },
		{ name: 'chronology', url: `${V}/chronology`, ready: `${ready('chronology')} && ${ROWS}.length > 0` },
		...(ex ? [{ name: `unavailable:${ex.id}`, url: `${V}${ex.route}`, ready: ready(`view:${ex.id}`) }] : []),
	];
	const U = A.v(unbroken.resultsVersion);
	const unbrokenPages = [
		{ name: 'unbroken-id:overview', url: `${U}/overview`, ready: ready('overview'), unbroken: true },
		{ name: 'unbroken-id:chronology', url: `${U}/chronology`, ready: `${ready('chronology')} && ${ROWS}.length > 0`, unbroken: true },
		...(ex ? [{ name: `unbroken-id:unavailable:${ex.id}`, url: `${U}${ex.route}`, ready: ready(`view:${ex.id}`), unbroken: true }] : []),
	];
	const screens = join(outDir(), 'screens');
	mkdirSync(screens, { recursive: true });
	const p = await openPage(b);
	const out = {};
	try {
		for (const width of [320, 390, 640, 641, 1280]) {
			await p.s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 640 });
			for (const pg of width <= 390 ? [...pages, ...unbrokenPages] : pages) {
				await p.goto(pg.url, pg.ready);
				await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
				const l = await p.evaluate(LAYOUT);
				const shot = await p.s('Page.captureScreenshot', { format: 'png' });
				const file = join(screens, `narrow-${width}-${pg.name.replace(/[^a-z0-9_-]/gi, '_')}.png`);
				writeFileSync(file, Buffer.from(shot.data, 'base64'));
				const narrow = width <= 640;
				const ok = (narrow
					? l.columns === 1 && l.navPosition !== 'sticky' && l.navBottom <= l.mainTop + 0.5 && Math.abs(l.mainLeft) <= 0.5 && Math.abs(l.mainWidth - l.vw) <= 1 &&
						l.navOverflowY === 'auto' && l.navMaxHeight !== 'none' && l.headerWrap === 'wrap' && l.scrollWidth === l.vw
					: l.columns === 2 && l.navPosition === 'sticky' && l.navRight <= l.mainLeft + 0.5 && l.mainTop < l.navBottom && l.headerWrap === 'nowrap') &&
					(!pg.unbroken || (l.scrollWidth === l.vw && l.banners.some((t) => t.includes(UNBROKEN_ID))));
				out[`${width}:${pg.name}`] = { ok, ...l, screenshot: file };
			}
		}
		await p.s('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
		await p.goto(`${V}/overview`, ready('overview'));
		out['390:keyboard'] = await tabThroughNav(p);
	} finally {
		await p.s('Emulation.clearDeviceMetricsOverride').catch(() => {});
		await p.close();
	}
	return { pass: Object.values(out).every((x) => x.ok), evidence: { example: ex?.id ?? 'none left', unbrokenId: { length: UNBROKEN_ID.length, import: imp.location }, layouts: out } };
}
