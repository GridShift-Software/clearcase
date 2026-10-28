// Shell-level scenarios of the M2 base (BASE-R2): the chronology's export file name read from the package's
// view-content (a neutral name and a visible note without it), and the case shell of the prototype restyle (GRS-254): a
// 240 px sidebar and a 56 px top bar beside 641 px and wider; at most 40rem (640 px) the sidebar is a drawer that is
// closed (not rendered) until the top bar's toggle opens it. Synthetic packages only; screenshots under <out>/screens.
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
	const q = (s) => document.querySelector(s), r = (e) => e.getBoundingClientRect();
	const side = q('.case-shell > .side'), bar = q('.case-shell > .top-bar'), main = q('main#main'), shell = q('.case-shell'), nav = q('.side nav.views'), toggle = q('#nav-toggle');
	const s = getComputedStyle(side), t = getComputedStyle(bar), de = document.documentElement, a = r(side), c = r(bar), m = r(main), n = r(nav);
	return { vw: de.clientWidth, vh: innerHeight, scrollWidth: de.scrollWidth, legacyHeader: q('header.top') !== null,
		sideDisplay: s.display, sidePosition: s.position, sideLeft: a.left, sideRight: a.right, sideWidth: a.width, sideHeight: a.height,
		barPosition: t.position, barWrap: t.flexWrap, barLeft: c.left, barRight: c.right, barBottom: c.bottom, barHeight: c.height,
		toggleDisplay: getComputedStyle(toggle).display, expanded: toggle.getAttribute('aria-expanded'),
		navOverflowY: getComputedStyle(nav).overflowY, navBottom: n.bottom,
		mainTop: m.top, mainLeft: m.left, mainWidth: m.width, columns: getComputedStyle(shell).gridTemplateColumns.split(' ').length,
		banners: [...document.querySelectorAll('.banner')].map((e) => e.textContent) };
})()`;

/** What a page shows once the drawer is open or closed again: the shell's open state, what is inert and where focus is. */
const DRAWER_STATE = `(() => {
	const q = (s) => document.querySelector(s), a = document.activeElement, side = q('.case-shell > .side');
	return { open: q('.case-shell')?.classList.contains('nav-open') ?? false, backdrop: q('.drawer-backdrop') !== null, barInert: q('.case-shell > .top-bar').inert,
		mainInert: q('main#main').inert, focusInSide: side.contains(a), active: a?.id || a?.tagName || null, expanded: q('#nav-toggle').getAttribute('aria-expanded') };
})()`;

/** A valid case id at the CASE_ID limit (64 characters) with no break opportunity: no hyphen, dot or space. */
const UNBROKEN_ID = 'syn_unbroken_case_id_'.padEnd(64, '0123456789abcdefghijklmnopqrstuvwxyz');
/** Tab from a fresh page through the sidebar: each focused nav link, whether it is inside the nav box and the viewport. */
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
 * Open the drawer with the keyboard (Tab to the top bar's toggle, Enter), then Tab on round: focus must stay in the
 * sidebar (the drawer is modal), visit every nav link inside the nav box and the viewport, and never scroll sideways.
 */
async function tabThroughDrawer(p) {
	let toggled = false;
	for (let i = 0; i < 8 && !toggled; i++) { await p.key('Tab'); toggled = await p.evaluate(`document.activeElement?.id === 'nav-toggle'`); }
	if (!toggled) return { ok: false, why: 'Tab never reached the drawer toggle' };
	await p.key('Enter');
	await p.waitFor(`document.querySelector('.case-shell.nav-open') && document.querySelector('.side').contains(document.activeElement)`, 5000);
	const links = await p.evaluate(`document.querySelectorAll('nav.views a').length`);
	const ids = new Set(), bad = [];
	for (let i = 0; i < links + 3; i++) {
		const f = await p.evaluate(`(() => {
			const a = document.activeElement, nav = document.querySelector('nav.views'), side = document.querySelector('.side');
			const r = a.getBoundingClientRect(), n = nav.getBoundingClientRect();
			return { id: a.id, inSide: side.contains(a), isLink: nav.contains(a), inNav: r.top >= n.top - 0.5 && r.bottom <= n.bottom + 0.5,
				inViewport: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5, scrollX };
		})()`);
		if (!f.inSide || (f.isLink && !(f.inNav && f.inViewport && f.scrollX === 0))) bad.push(f);
		if (f.isLink) ids.add(f.id);
		await p.key('Tab');
	}
	return { links, focused: ids.size, ok: links > 0 && ids.size === links && bad.length === 0, outside: bad };
}

/**
 * The drawer at a narrow width, driven with the real mouse and keyboard: the toggle opens it (a fixed panel at most 288 px
 * and 86% of the viewport wide, the full height, its nav scrolling inside it, a backdrop, the top bar and main inert,
 * focus inside it, no sideways scroll); Escape closes it with focus back on the toggle; the backdrop does the same.
 */
async function drawerCycle(p, width) {
	const out = {};
	await p.click('#nav-toggle');
	await p.waitFor(`document.querySelector('.case-shell.nav-open')`, 5000);
	await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
	const l = await p.evaluate(LAYOUT), d = await p.evaluate(DRAWER_STATE);
	out.opened = { ...l, ...d, ok: l.sideDisplay === 'flex' && l.sidePosition === 'fixed' && Math.abs(l.sideLeft) <= 0.5 && l.sideWidth > 0 && l.sideWidth <= Math.min(288, 0.86 * l.vw) + 0.5 &&
		Math.abs(l.sideHeight - l.vh) <= 1 && l.navOverflowY === 'auto' && l.navBottom <= l.vh + 0.5 && l.expanded === 'true' && d.backdrop && d.barInert && d.mainInert && d.focusInSide && l.scrollWidth === l.vw };
	await p.key('Escape');
	await p.waitFor(`!document.querySelector('.case-shell.nav-open')`, 5000);
	const e = await p.evaluate(DRAWER_STATE);
	out.escape = { ...e, ok: !e.open && !e.backdrop && !e.barInert && !e.mainInert && e.active === 'nav-toggle' && e.expanded === 'false' };
	await p.click('#nav-toggle');
	await p.waitFor(`document.querySelector('.case-shell.nav-open')`, 5000);
	// the backdrop is what is left of the viewport to the right of the drawer (at most 288 px wide)
	const x = width - 4;
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.s('Input.dispatchMouseEvent', { type, x, y: 400, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
	await p.waitFor(`!document.querySelector('.case-shell.nav-open')`, 5000);
	const bd = await p.evaluate(DRAWER_STATE);
	out.backdrop = { ...bd, ok: !bd.open && !bd.barInert && !bd.mainInert && bd.active === 'nav-toggle' && bd.expanded === 'false' };
	return out;
}

/**
 * The case shell (GRS-254). At most 40rem (640 px) the sidebar is a drawer: closed it is not rendered and the top bar
 * (with the toggle, aria-expanded false) and main span the viewport, starting at the left edge, with main in the first
 * screen (the navigation never pushes content down); the top bar wraps; no page scrolls sideways. The drawer opens and
 * closes by mouse, Escape and backdrop (drawerCycle). 641 and 1280 px: the 240 px sidebar is sticky and runs the
 * viewport's height beside two columns, the top bar is sticky beside it and main starts below the bar; at 1280 the bar is
 * one 56 px row. No legacy header.top inside a case. At 390 px Tab reaches every nav link in the open drawer inside the
 * nav box and the viewport and stays in the drawer; at 1280 px Tab reaches every sidebar link inside it. A case whose
 * 64-character id has no break opportunity does not make its pages scroll sideways at 320 or 390 px. The chronology's
 * wide grid scrolls inside its own box: the document's scrollWidth equals the viewport at 320, 390 and 640 px.
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
		// the bundle views (GRS-19): their tables and builder must not widen the page at 320 and 390 px
		...['discovery_tab', 'caselines_tab', 'court_bundle_tab'].map((id) => ({ name: id, url: `${V}/bundles/${id}`, ready: ready(id) })),
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
	const shot = async (name) => writeFileSync(join(screens, name), Buffer.from((await p.s('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
	try {
		for (const width of [320, 390, 640, 641, 1280]) {
			await p.s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 640 });
			for (const pg of width <= 390 ? [...pages, ...unbrokenPages] : pages) {
				await p.goto(pg.url, pg.ready);
				await p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
				const l = await p.evaluate(LAYOUT);
				const tag = pg.name.replace(/[^a-z0-9_-]/gi, '_');
				await shot(`narrow-${width}-${tag}.png`);
				const file = join(screens, `narrow-${width}-${tag}.png`);
				const narrow = width <= 640;
				const ok = !l.legacyHeader && (narrow
					? l.columns === 1 && l.sideDisplay === 'none' && l.toggleDisplay !== 'none' && l.expanded === 'false' && Math.abs(l.barLeft) <= 0.5 && l.barRight <= l.vw + 0.5 &&
						l.barWrap === 'wrap' && Math.abs(l.mainLeft) <= 0.5 && Math.abs(l.mainWidth - l.vw) <= 1 && l.mainTop < l.vh / 2 && l.scrollWidth === l.vw
					: l.columns === 2 && l.sideDisplay === 'flex' && l.sidePosition === 'sticky' && Math.abs(l.sideLeft) <= 0.5 && Math.abs(l.sideWidth - 240) <= 0.5 && Math.abs(l.sideHeight - l.vh) <= 1 &&
						l.toggleDisplay === 'none' && l.barPosition === 'sticky' && l.barLeft >= l.sideRight - 0.5 && l.sideRight <= l.mainLeft + 0.5 && l.mainTop >= l.barBottom - 0.5 &&
						(width < 1024 || l.barHeight <= 57) && l.scrollWidth === l.vw) &&
					(!pg.unbroken || (l.scrollWidth === l.vw && l.banners.some((t) => t.includes(UNBROKEN_ID))));
				out[`${width}:${pg.name}`] = { ok, ...l, screenshot: file };
				if (narrow && pg.name.endsWith('overview')) {
					const cyc = await drawerCycle(p, width);
					await p.click('#nav-toggle');
					await p.waitFor(`document.querySelector('.case-shell.nav-open')`, 5000);
					await shot(`drawer-${width}-${tag}.png`);
					await p.key('Escape');
					await p.waitFor(`!document.querySelector('.case-shell.nav-open')`, 5000);
					for (const [k, v] of Object.entries(cyc)) out[`${width}:${pg.name}:drawer-${k}`] = v;
				}
			}
		}
		await p.s('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
		await p.goto(`${V}/overview`, ready('overview'));
		out['390:keyboard'] = await tabThroughDrawer(p);
		await p.s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
		await p.goto(`${V}/overview`, ready('overview'));
		out['1280:keyboard'] = await tabThroughNav(p);
	} finally {
		await p.s('Emulation.clearDeviceMetricsOverride').catch(() => {});
		await p.close();
	}
	return { pass: Object.values(out).every((x) => x.ok), evidence: { example: ex?.id ?? 'none left', unbrokenId: { length: UNBROKEN_ID.length, import: imp.location }, layouts: out } };
}
