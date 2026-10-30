// Main-flow scenarios on app server A: UI import and preview (S1/S1b), activation through the UI, the chronology in
// the browser (filters, sorts, Back; S25), citations to originals in the real viewer, keyboard and Back (BA-14),
// titles (BA-16), the 42 extension points (BA-18), source routes (BA-09) and date basis (BA-04). The extension-point
// checks know which M2 views and overview slots the tree under test implements (lib/implemented.mjs).
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISABLED_FEATURES, frameEvaluator, launch } from '../lib/cdp.mjs';
import { destinationOk, expectedSlot, filledSlots, firstUnimplemented, implementedViews, modeSummary, observedSlot, readyKind, registryOf } from '../lib/implemented.mjs';
import { nextPopup, openPage, sleep } from './browser.mjs';
import { ODD_BUNDLE, missingCase, mainCase } from './cases.mjs';
import { readJson, vpath } from './context.mjs';
import { viewHeading } from '../../../../src/lib/views/analysis/headings.ts';

const J = JSON.stringify;
export const ROWS = `[...document.querySelectorAll('[role=table] [role=row][data-ref]')].map((r) => r.dataset.ref)`;
export const ready = (kind) => `document.querySelector('main#main')?.dataset.ready === ${J(kind)}`;
const docReady = (ref) => ready(`doc:${ref}`);

/** The registry, the implemented views and filled slots of the tree under test, and the example unavailable view. */
async function modes(ctx) {
	if (!ctx.modes) {
		const r = await registryOf(ctx.ROOT);
		const implemented = implementedViews(ctx.ROOT, r.views);
		const filled = filledSlots(ctx.ROOT, r.slots);
		ctx.modes = { ...r, implemented, filled, example: firstUnimplemented(r.views, implemented), summary: modeSummary(r.views, implemented, filled) };
	}
	return ctx.modes;
}

// ---- independent re-implementation of the chronology predicates (v5 chronFiltered/sortChron as revised) ----------
const num = (s) => { const n = parseFloat(s); return Number.isNaN(n) ? 0 : n; };
const code = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function expected(chronology, { q = '', bundle = '', type = '', status = '', sort = 'date', dir = 1 } = {}) {
	const rows = chronology.map((r, ord) => ({ ref: r.ref, ord, date: r.date ?? '', amount: r.amount ?? '', bundle: r.bundle, docType: r.doc_type, status: r.text_status, hay: `${r.filename} ${r.ref} ${r.subject} ${r.sender} ${r.excerpt}`.toLowerCase() }));
	const key = { date: 'date', ref: 'ref', docType: 'docType', bundle: 'bundle', amount: 'amount' }[sort];
	return rows.filter((r) => (!bundle || r.bundle === bundle) && (!type || r.docType === type) && (!status || r.status === status) && (!q || r.hay.includes(q.toLowerCase())))
		.sort((a, b) => ((sort === 'amount' ? num(a.amount) - num(b.amount) : code(a[key], b[key])) * dir) || a.ord - b.ord).map((r) => r.ref);
}

async function viewerState(b, pop, timeout = 20000) {
	await pop.waitFor(`document.body?.dataset.ready ?? null`, timeout);
	const wrapper = await pop.ev(`({ url: location.href, origin: location.origin, ready: document.body.dataset.ready, status: document.querySelector('#wrap-status')?.textContent ?? null, sandbox: document.querySelector('iframe#viewer')?.getAttribute('sandbox') ?? null, title: document.title, scripts: [...document.scripts].map((s) => s.src ? new URL(s.src).pathname : 'inline') })`);
	const f = await frameEvaluator(b, pop.sessionId, /\/_pdfjs\/[^/]+\/frame\.html/, 8000);
	const frame = await f(`({ origin: self.origin, url: location.pathname + location.hash, ready: document.body.dataset.ready ?? null, state: window.__viewer ? JSON.parse(JSON.stringify(window.__viewer)) : null,
		status: document.querySelector('#status')?.textContent ?? null, jsNote: document.querySelector('#js-note')?.hidden === false ? document.querySelector('#js-note').textContent : null,
		canvases: document.querySelectorAll('canvas').length, inlineScripts: document.querySelectorAll('script:not([src])').length, bodyText: document.body.innerText.slice(0, 200),
		page2: document.querySelector('#page-2') ? Math.round(document.querySelector('#page-2').getBoundingClientRect().top) : null, innerHeight })`);
	return { wrapper, frame, where: f.where, ev: f };
}
export { viewerState };

/** S1 + S1b: import through the form, validation report, candidate preview; nothing is activated. */
export async function s1(ctx) {
	const { A, b, R } = ctx;
	const main = ctx.main;
	const before = { active: await A.c.activeVersion(), root: (await A.c.get('/')).location, home: await A.c.home() };
	const p = (ctx.p = await openPage(b));
	await p.goto(`${A.origin}/import`, `!!document.querySelector('#import-form')`);
	await p.type('#caseFolder', main.caseDir);
	await p.type('#packageSource', main.pkgDir);
	const typed = await p.evaluate(`[document.querySelector('#caseFolder').value, document.querySelector('#packageSource').value]`);
	await p.click('#validate');
	await p.waitFor(`/^\\/import\\/\\d+$/.test(location.pathname) && !!document.querySelector('main[data-verdict]')`, 60000);
	const rep = await p.evaluate(`({ path: location.pathname, verdict: document.querySelector('main').dataset.verdict, candidate: document.querySelector('#candidate-heading')?.textContent.trim() ?? null,
		activeState: document.querySelector('#active-state')?.textContent.trim() ?? null, verify: document.querySelector('#verify-state')?.textContent.trim() ?? null,
		rv: document.querySelector('#results-version')?.textContent.trim() ?? null, ack: !!document.querySelector('#ack'), activate: !!document.querySelector('#activate'), preview: document.querySelector('#preview')?.getAttribute('href') ?? null })`);
	ctx.mainImport = { path: rep.path, id: Number(rep.path.split('/').pop()) };
	const afterImport = { active: await A.c.activeVersion(), home: await A.c.home(), attempts: A.results('SELECT id, outcome, verdict, results_version AS rv FROM import_attempt') };
	const s1ok = before.active === null && before.root === '/cases' && before.home === null && typed[0] === main.caseDir && typed[1] === main.pkgDir && rep.verdict === 'report' && rep.candidate === 'Candidate' &&
		rep.activeState === 'not active' && rep.verify === 'verified' && rep.rv === main.resultsVersion && rep.ack && rep.activate && afterImport.active === null && afterImport.home === ctx.mainImport.path &&
		afterImport.attempts.length === 1 && afterImport.attempts[0].outcome === 'stored';
	R.rec('S1', 'import a synthetic package through the UI form: validation report with verdict and Candidate section; nothing activated', s1ok ? 'PASS' : 'FAIL', { before, typed: typed.map((x) => x.slice(-40)), report: rep, afterImport });
	// S1b: Preview
	await p.click('#preview');
	await p.waitFor(`${ready('overview')} && !!document.querySelector('#candidate-banner')`, 20000);
	const pv = await p.evaluate(`({ path: location.pathname, banner: document.querySelector('#candidate-banner')?.textContent.trim().slice(0, 120) ?? null, activeBanner: !!document.querySelector('#active-banner'),
		count: Number(document.querySelector('#count-documents')?.dataset.count), rollback: !!document.querySelector('#rollback-form'), docs: performance.getEntriesByType('navigation').length })`);
	const after = { active: await A.c.activeVersion(), home: await A.c.home(), activePointers: A.work('SELECT * FROM active').length, log: A.work('SELECT * FROM activation_log').length };
	const ok = pv.path === `${vpath(main.resultsVersion)}/overview` && /^CANDIDATE PREVIEW/.test(pv.banner ?? '') && !pv.activeBanner && pv.count === main.chronology.length && !pv.rollback &&
		after.active === null && after.home === ctx.mainImport.path && after.activePointers === 0 && after.log === 0;
	return { pass: s1ok && ok, evidence: { preview: pv, expectedCount: main.chronology.length, after } };
}

/** Activation through the UI: refused without the acknowledgement (ACK_REQUIRED, nothing changes), then activated. */
export async function activation(ctx) {
	const { A, p, main } = ctx;
	await p.goto(`${A.origin}${ctx.mainImport.path}`, `!!document.querySelector('#activate')`);
	await p.click('#activate');
	await p.waitFor(`!!document.querySelector('#activate-error')`, 30000);
	const refused = await p.evaluate(`({ reasons: document.querySelector('#activate-error').dataset.reasons, text: document.querySelector('#activate-error').textContent.trim().slice(0, 200), ackChecked: document.querySelector('#ack')?.checked ?? null })`);
	const afterRefusal = { active: await A.c.activeVersion(), home: await A.c.home(), pointers: A.work('SELECT * FROM active').length, log: A.work('SELECT * FROM activation_log').length };
	await p.click('#ack');
	const checked = await p.evaluate(`document.querySelector('#ack').checked`);
	await p.click('#activate');
	await p.waitFor(`${ready('overview')} && !!document.querySelector('#active-banner')`, 60000);
	const ov = await p.evaluate(`({ path: location.pathname, activeBanner: document.querySelector('#active-banner')?.textContent.trim() ?? null, candidate: !!document.querySelector('#candidate-banner'), count: Number(document.querySelector('#count-documents')?.dataset.count) })`);
	const log = A.work('SELECT kind, version_id AS v, acknowledgement IS NOT NULL AS acked FROM activation_log');
	const active = await A.c.activeVersion();
	const ok = refused.reasons.split(' ').includes('ACK_REQUIRED') && /Nothing was changed/.test(refused.text) && refused.ackChecked === false &&
		afterRefusal.active === null && afterRefusal.home === ctx.mainImport.path && afterRefusal.pointers === 0 && afterRefusal.log === 0 && checked === true &&
		ov.path === `${vpath(main.resultsVersion)}/overview` && !!ov.activeBanner && !ov.candidate && ov.count === main.chronology.length &&
		active === main.resultsVersion && log.length === 1 && log[0].kind === 'activate' && log[0].v === main.resultsVersion && log[0].acked === 1;
	return { pass: ok, evidence: { refused, afterRefusal, ackChecked: checked, overview: ov, active, log, expectedCount: main.chronology.length } };
}

/** The chronology in the browser: filters, sorts (stable ties), row count, URL state, Back from a document. */
export async function chronology(ctx) {
	const { A, p, main } = ctx;
	const C = main.chronology;
	await p.goto(`${A.v(main.resultsVersion)}/overview`, ready('overview'));
	await p.click('#nav-chronology');
	await p.waitFor(`${ready('chronology')} && ${ROWS}.length === ${C.length}`);
	const state = () => p.evaluate(`({ rows: ${ROWS}, count: Number(document.querySelector('#row-count').dataset.count), search: location.search, q: document.querySelector('#f-q').value,
		bundle: document.querySelector('#f-bundle').value, type: document.querySelector('#f-type').value, status: document.querySelector('#f-status').value,
		sort: [...document.querySelectorAll('[role=columnheader][aria-sort]')].map((h) => h.textContent.trim() + ':' + h.getAttribute('aria-sort')) })`);
	const select = (id, v) => p.evaluate(`(() => { const s = document.querySelector('#${id}'); s.value = ${J(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
	const settle = (exp) => p.waitFor(`${J(exp)}.join() === ${ROWS}.join()`, 5000).catch(() => null);
	const checks = [];
	const check = async (name, query, params) => {
		const exp = expected(C, query);
		await settle(exp);
		const s = await state();
		const sp = Object.fromEntries(new URLSearchParams(s.search));
		const rowsOk = s.rows.join() === exp.join() && s.count === exp.length;
		const urlOk = J(sp) === J(params);
		checks.push({ name, rowsOk, urlOk, rows: s.rows, expected: exp, count: s.count, params: sp, expectedParams: params, sortHeader: s.sort });
	};
	await check('initial: date ascending, undated first, ties in source order', {}, {});
	if ((await select('f-bundle', ODD_BUNDLE)) !== ODD_BUNDLE) throw new Error('non-standard bundle is not selectable');
	await check('bundle (non-standard)', { bundle: ODD_BUNDLE }, { bundle: ODD_BUNDLE });
	await select('f-type', 'report');
	await check('bundle + type', { bundle: ODD_BUNDLE, type: 'report' }, { bundle: ODD_BUNDLE, type: 'report' });
	await select('f-bundle', ''); await select('f-type', '');
	await select('f-status', 'none');
	await check('text status none', { status: 'none' }, { status: 'none' });
	await select('f-status', '');
	await p.type('#f-q', 'ZEBRA');
	await check('text query (case-insensitive)', { q: 'ZEBRA' }, { q: 'ZEBRA' });
	await p.type('#f-q', 'em-000');
	await check('text query on ref', { q: 'em-000' }, { q: 'em-000' });
	await p.evaluate(`document.querySelector('#f-q').select(); true`);
	await p.key('Backspace');
	await check('query cleared', {}, {});
	await p.click('#sort-date');
	await check('date descending (ties keep source order)', { dir: -1 }, { dir: 'desc' });
	await p.click('#sort-amount');
	await check('amount ascending (empty = 0)', { sort: 'amount' }, { sort: 'amount' });
	await p.click('#sort-amount');
	await check('amount descending (ties keep source order, empty = 0)', { sort: 'amount', dir: -1 }, { sort: 'amount', dir: 'desc' });
	await select('f-bundle', ODD_BUNDLE);
	await check('bundle + amount descending', { bundle: ODD_BUNDLE, sort: 'amount', dir: -1 }, { bundle: ODD_BUNDLE, sort: 'amount', dir: 'desc' });
	// Back from a document returns the same filtered list
	const beforeDoc = await state();
	const doc0 = await p.evaluate('window.__ccDoc');
	const h0 = await p.evaluate('history.length');
	await p.click('[role=row][data-ref="EX-002"] a[href*="/doc/"]');
	await p.waitFor(docReady('EX-002'));
	const onDoc = await p.evaluate(`({ path: location.pathname, sameDocument: window.__ccDoc === ${J(doc0)}, history: history.length })`);
	await p.evaluate('history.back(); true');
	await p.waitFor(`${ready('chronology')} && ${J(beforeDoc.rows)}.join() === ${ROWS}.join()`, 10000).catch(() => null);
	const afterBack = await state();
	const backOk = onDoc.sameDocument && onDoc.history === h0 + 1 && J(afterBack) === J(beforeDoc);
	// Filters, sorts and counts (CHRON) are judged apart from the URL state and Back (CHRON-URL), so one defect does not hide the other.
	const urlChecks = [...checks.map((c) => ({ name: c.name, ok: c.urlOk, params: c.params, expectedParams: c.expectedParams })), { name: 'document then Back: same filters, sort and rows', ok: backOk, beforeDoc, onDoc, afterBack }];
	ctx.R.rec('CHRON-URL', 'chronology URL state: the address bar carries exactly the active filters and sort, and Back from a document restores the same filters, sort and rows', urlChecks.every((c) => c.ok) ? 'PASS' : 'FAIL',
		{ failed: urlChecks.filter((c) => !c.ok), passed: urlChecks.filter((c) => c.ok).map((c) => `${c.name}: ${J(c.params ?? {})}`) });
	return { pass: checks.every((c) => c.rowsOk), evidence: { failed: checks.filter((c) => !c.rowsOk), passed: checks.filter((c) => c.rowsOk).map((c) => `${c.name}: ${c.rows.join(' ')}`) } };
}

/** S25: div grid with content-visibility rows; per-version JSON private, no-cache, ETag = read-model digest, 304. */
export async function s25(ctx) {
	const { A, p, main } = ctx;
	const rv = main.resultsVersion;
	await p.goto(`${A.v(rv)}/chronology`, `${ready('chronology')} && ${ROWS}.length > 0`);
	const dom = await p.evaluate(`(() => { const t = document.querySelector('main [role=table]'); const rows = [...t.querySelectorAll('[role=row][data-ref]')]; const cs = getComputedStyle(rows[3]);
		return { tablesInMain: document.querySelectorAll('main table').length, tableTag: t.tagName, rowTag: rows[3].tagName, rows: rows.length, contentVisibility: cs.contentVisibility, containIntrinsicSize: cs.containIntrinsicSize, display: cs.display, gridColumns: cs.gridTemplateColumns.split(' ').length, styleAttrs: document.querySelectorAll('main [style]').length }; })()`);
	const url = `/api/v/${encodeURIComponent(rv)}/chronology`;
	const r1 = await A.c.get(url);
	const stored = A.results('SELECT read_model_sha256 AS rm, chronology_json AS cj FROM version WHERE id = ?', rv)[0];
	const r2 = await A.c.get(url, { headers: { 'if-none-match': r1.headers.etag } });
	const r3 = await A.c.get(url, { headers: { 'if-none-match': '"sha256:0000"' } });
	const cc = r1.headers['cache-control'] ?? '';
	const ok = dom.tablesInMain === 0 && dom.tableTag === 'DIV' && dom.rowTag === 'DIV' && dom.contentVisibility === 'auto' && dom.display === 'grid' && dom.gridColumns === (main.chronology.some((r) => r.date_type) ? 10 : 9) &&
		cc === 'private, no-cache' && r1.headers.etag === `"${stored.rm}"` && r2.status === 304 && r3.status === 200 && r1.text === stored.cj && JSON.parse(r1.text).length === main.chronology.length;
	return { pass: ok, evidence: { dom, cacheControl: cc, etag: r1.headers.etag, readModel: stored.rm, conditional: r2.status, wrongEtag: r3.status, bodyEqualsStored: r1.text === stored.cj } };
}

/** Citation to original: [[REF]] and [[REF#p2]] become app links; Open reaches the real viewer at that page. */
export async function citations(ctx) {
	const { A, b, p, main } = ctx;
	const rv = main.resultsVersion;
	const V = vpath(rv);
	await p.goto(`${A.v(rv)}/overview`, ready('overview'));
	const narrative = await p.evaluate(`({ links: [...document.querySelectorAll('.narrative a')].map((a) => ({ cls: a.className, href: a.getAttribute('href'), text: a.textContent })), broken: [...document.querySelectorAll('.narrative .cite-broken')].map((s) => s.textContent),
		tags: [...new Set([...document.querySelectorAll('.narrative *')].map((e) => e.tagName))] })`);
	const expectHrefs = [`${V}/doc/OD-001`, `${V}/doc/OD-001?page=2`, `${V}/doc/EM-0001`];
	const doc0 = await p.evaluate('window.__ccDoc');
	const h0 = await p.evaluate('history.length');
	await p.click(`.narrative a.cite[href=${J(expectHrefs[0])}]`);
	await p.waitFor(docReady('OD-001'));
	const nav1 = await p.evaluate(`({ path: location.pathname + location.search, sameDocument: window.__ccDoc === ${J(doc0)}, history: history.length, navEntries: performance.getEntriesByType('navigation').length,
		open: document.querySelector('#open-original')?.href ?? null, openText: document.querySelector('#open-original')?.textContent.trim() ?? null, target: document.querySelector('#open-original')?.target ?? null, rel: document.querySelector('#open-original')?.rel ?? null })`);
	const open = async () => {
		const pop = nextPopup(b, 10000);
		await p.click('#open-original');
		const w = await pop;
		try { await sleep(400); return await viewerState(b, w); } finally { await w.close(); }
	};
	const v1 = await open();
	await p.evaluate('history.back(); true');
	await p.waitFor(ready('overview'));
	await p.click(`.narrative a.cite[href=${J(expectHrefs[1])}]`);
	await p.waitFor(`${docReady('OD-001')} && location.search === '?page=2'`);
	const nav2 = await p.evaluate(`({ path: location.pathname + location.search, sameDocument: window.__ccDoc === ${J(doc0)}, open: document.querySelector('#open-original')?.href ?? null, openText: document.querySelector('#open-original')?.textContent.trim() ?? null })`);
	const v2 = await open();
	const viewerBase = `${A.orig}/view/${rv}/OD-001?k=`;
	const ok = J(narrative.links.map((l) => l.href)) === J(expectHrefs) && narrative.links.every((l) => l.cls === 'cite') && J(narrative.broken) === J(['[[ZZ-404]]']) &&
		narrative.tags.every((t) => ['P', 'BR', 'A', 'SPAN'].includes(t)) &&
		nav1.path === expectHrefs[0] && nav1.sameDocument && nav1.navEntries === 1 && nav1.history === h0 + 1 && nav1.open?.startsWith(viewerBase) && !nav1.open.includes('#') && nav1.target === '_blank' && /noopener/.test(nav1.rel) && /noreferrer/.test(nav1.rel) &&
		v1.wrapper.origin === A.orig && v1.wrapper.ready === '1' && v1.wrapper.sandbox === 'allow-scripts' && v1.frame.origin === 'null' && v1.frame.ready === '1' && v1.frame.state.current === 1 && v1.frame.state.numPages === 2 && v1.frame.canvases >= 1 &&
		nav2.path === expectHrefs[1] && nav2.sameDocument && nav2.open?.startsWith(viewerBase) && nav2.open.endsWith('#page=2') && nav2.openText === 'Open at page 2' &&
		v2.wrapper.ready === '1' && v2.frame.ready === '1' && v2.frame.state.current === 2 && v2.frame.status === 'Page 2 of 2' && v2.frame.page2 !== null && v2.frame.page2 >= 0 && v2.frame.page2 < v2.frame.innerHeight;
	const strip = (v) => ({ wrapper: v.wrapper, frame: { ...v.frame, state: v.frame.state && { numPages: v.frame.state.numPages, current: v.frame.state.current, rendered: v.frame.state.rendered, options: v.frame.state.options } }, where: v.where });
	return { pass: ok, evidence: { narrative, nav1, page1Viewer: strip(v1), nav2, page2Viewer: strip(v2) } };
}

async function tabTo(p, id, { shift = false, max = 90 } = {}) {
	const seen = [];
	for (let i = 0; i < max; i++) {
		await p.key('Tab', { shift });
		const a = await p.active();
		seen.push(a?.id ?? a?.tag);
		if (a?.id === id) return { presses: i + 1 };
	}
	throw new Error(`Tab never reached #${id}: ${seen.slice(-12).join(',')}`);
}

/**
 * BA-14: skip link first; Tab + Enter on nav links; focus on the page heading after each navigation and after Back,
 * including Back to the entry where the skip link was used, Back across a document boundary (a full load) and Back
 * from an in-page fragment link to the page's own entry.
 */
export async function keyboard(ctx) {
	const { A, p, main } = ctx;
	const ov = `${A.v(main.resultsVersion)}/overview`;
	const focusNow = `document.activeElement?.hasAttribute('data-page-heading') ? 'heading:' + document.activeElement.textContent.trim() : (document.activeElement?.id || document.activeElement?.tagName || null)`;
	await p.goto(ov, ready('overview'));
	const freshFocus = await p.evaluate(focusNow); // a fresh first visit keeps the browser's focus
	const hSkip = await p.evaluate('history.length');
	await p.key('Tab');
	const first = await p.evaluate(`(() => { const e = document.activeElement; const r = e.getBoundingClientRect(); return { cls: e.className, href: e.getAttribute('href'), text: e.textContent.trim(), left: r.left, top: r.top, w: r.width }; })()`);
	await p.key('Enter');
	await sleep(150);
	const afterSkip = await p.evaluate(`({ hash: location.hash, focused: document.activeElement?.id ?? null, added: history.length - ${hSkip} })`);
	// the plain keyboard sequence: skip link, Shift+Tab to Chronology, Enter, Back; the heading must end up focused
	const tSkip = await tabTo(p, 'nav-chronology', { shift: true });
	await p.key('Enter');
	await p.waitFor(ready('chronology'));
	await p.evaluate('history.back(); true');
	await p.waitFor(ready('overview'));
	await sleep(400); // SvelteKit's fragment focus reset runs in a later task
	const skipBack = { presses: tSkip.presses, ...(await p.evaluate(`({ path: location.pathname, hash: location.hash, focus: ${focusNow} })`)) };
	// Back across a document boundary, as a browser without a back/forward cache does it: pages are no-store, so Back
	// loads the chronology again (the bfcache-restored case is covered by BFCACHE and by the Back steps below).
	let crossBack;
	const nb = await launch({ profileRoot: join(ctx.tmp, 'chromium-no-bfcache'), extra: [`--disable-features=${DISABLED_FEATURES},BackForwardCache`] });
	try {
		const q = await openPage(nb);
		await q.goto(ov, ready('overview'));
		await tabTo(q, 'nav-chronology');
		await q.key('Enter');
		await q.waitFor(ready('chronology'));
		const crossDoc = await q.evaluate('window.__ccDoc');
		await q.goto(`${A.origin}/import`, ready('import'));
		await q.evaluate('history.back(); true');
		await q.waitFor(`location.pathname.endsWith('/chronology') && window.__ccMounted >= 1 && ${ready('chronology')}`, 15000);
		await sleep(400);
		crossBack = await q.evaluate(`({ path: location.pathname, newDocument: window.__ccDoc !== ${J(crossDoc)}, nav: performance.getEntriesByType('navigation')[0]?.type ?? null, focus: ${focusNow} })`);
	} finally { await nb.close().catch(() => {}); }
	// leave the overview first: a load of the URL already shown replaces its entry instead of pushing a new one
	await p.goto(`${A.origin}/import`, ready('import'));
	await p.goto(ov, ready('overview'));
	const h0 = await p.evaluate('history.length');
	const doc0 = await p.evaluate('window.__ccDoc');
	const heading = (label) => p.waitFor(`document.activeElement?.hasAttribute('data-page-heading') && document.activeElement.textContent.trim() === ${J(label)}`, 8000).then(() => true, () => false);
	const at = async () => p.evaluate(`({ path: location.pathname, history: history.length, sameDocument: window.__ccDoc === ${J(doc0)}, focus: document.activeElement?.hasAttribute('data-page-heading') ? 'heading:' + document.activeElement.textContent.trim() : (document.activeElement?.id || document.activeElement?.tagName) })`);
	const steps = [];
	const t1 = await tabTo(p, 'nav-chronology');
	await p.key('Enter');
	await p.waitFor(ready('chronology'));
	steps.push({ step: 'Tab to Chronology + Enter', presses: t1.presses, headingFocused: await heading('Chronology'), ...(await at()), wantHistory: h0 + 1 });
	// the example: the first registry view without an owner route (an unavailable one); 'none left' once all exist
	const { views, example: ex } = await modes(ctx);
	if (ex) {
		const before = views.findIndex((v) => v.id === ex.id) < views.findIndex((v) => v.id === 'chronology');
		const t2 = await tabTo(p, `nav-${ex.id}`, { shift: before });
		await p.key('Enter');
		await p.waitFor(ready(`view:${ex.id}`));
		steps.push({ step: `${before ? 'Shift+Tab' : 'Tab'} to ${ex.label} + Enter`, presses: t2.presses, headingFocused: await heading(ex.label), ...(await at()), wantHistory: h0 + 2 });
		await p.evaluate('history.back(); true');
		await p.waitFor(ready('chronology'));
		steps.push({ step: 'Back', headingFocused: await heading('Chronology'), ...(await at()), wantHistory: h0 + 2 });
	}
	await p.evaluate('history.back(); true');
	await p.waitFor(ready('overview'));
	steps.push({ step: 'Back', headingFocused: await heading('Overview'), ...(await at()), wantHistory: h0 + (ex ? 2 : 1) });
	const V = vpath(main.resultsVersion);
	const want = ex ? [`${V}/chronology`, `${V}${ex.route}`, `${V}/chronology`, `${V}/overview`] : [`${V}/chronology`, `${V}/overview`];
	// Back from an in-page fragment entry (the validation report's #code-<CODE> links) to the page's own entry: a
	// same-page traversal SvelteKit handles without a navigation; the heading must still take focus.
	await p.goto(`${A.origin}${ctx.mainImport.path}`, `document.querySelectorAll('main a[href^="#code-"]').length > 0`);
	const hFrag = await p.evaluate('history.length');
	await p.evaluate(`window.__ccFragHashchange = 0; addEventListener('hashchange', () => { window.__ccFragHashchange++; }, { once: true }); document.querySelector('main a[href^="#code-"]').focus(); true`);
	await p.key('Enter');
	// Back as a person presses it: after the fragment navigation has finished, i.e. its hashchange (and the router's
	// handler of it) ran. Back before that raced the router and hid a lost focus (DIAG-BA14).
	await p.waitFor(`location.hash.startsWith('#code-') && window.__ccFragHashchange === 1`);
	const fragHash = await p.evaluate('location.hash');
	await p.evaluate('history.back(); true');
	await p.waitFor(`location.hash === ''`);
	await sleep(400);
	const fragBack = { hash: fragHash, added: (await p.evaluate('history.length')) - hFrag, ...(await p.evaluate(`({ path: location.pathname, focus: ${focusNow} })`)) };
	const ok = first.cls === 'skip' && first.href === '#main' && first.left >= 0 && first.w > 0 && afterSkip.hash === '' && afterSkip.added === 0 && afterSkip.focused === 'main' &&
		freshFocus === 'BODY' && skipBack.path === `${vpath(main.resultsVersion)}/overview` && skipBack.focus === 'heading:Overview' &&
		crossBack.path === `${vpath(main.resultsVersion)}/chronology` && crossBack.newDocument && crossBack.nav === 'back_forward' && crossBack.focus === 'heading:Chronology' &&
		steps.length === want.length && steps.every((s, i) => s.headingFocused && s.sameDocument && s.history === s.wantHistory && s.path === want[i]) &&
		fragBack.path === ctx.mainImport.path && fragBack.added === 1 && /^heading:/.test(fragBack.focus ?? '');
	return { pass: ok, evidence: { example: ex?.id ?? 'none left', firstTab: first, freshFocus, afterSkip, skipBack, crossBack, steps, fragBack } };
}

/**
 * BA-16: titles name the document, section and case: '<document> · <section> · <case> · ClearCase'. The case part is
 * the package's view-content _shell.documentTitle, else the case name; the brand above the view navigation is
 * _shell.brandName, else the case name. The unavailable example is the first registry view without an owner route;
 * when every view has one, it is recorded as 'none left'.
 */
export async function titles(ctx) {
	const { A, p, main } = ctx;
	const V = A.v(main.resultsVersion);
	const kase = ctx.titleName(main);
	const { example: ex } = await modes(ctx);
	const want = {
		overview: `Overview · ${kase} · ClearCase`, chronology: `Chronology · ${kase} · ClearCase`,
		document: `OD-002 Synthetic subject OD-002 · Document · ${kase} · ClearCase`, unavailable: ex ? `${ex.label} (not yet available) · ${kase} · ClearCase` : 'none left',
	};
	const got = {};
	await p.goto(`${V}/overview`, ready('overview')); got.overview = await p.evaluate('document.title'); got.brand = await p.evaluate(`document.getElementById('case-brand')?.textContent.trim() ?? null`);
	await p.goto(`${V}/chronology`, ready('chronology')); got.chronology = await p.evaluate('document.title');
	await p.goto(`${V}/doc/OD-002`, docReady('OD-002')); got.document = await p.evaluate('document.title');
	if (ex) { await p.goto(`${V}${ex.route}`, ready(`view:${ex.id}`)); got.unavailable = await p.evaluate('document.title'); }
	else got.unavailable = 'none left';
	// after client-side navigation the title follows
	await p.click('#nav-overview');
	await p.waitFor(`${ready('overview')} && document.title === ${J(want.overview)}`, 8000).catch(() => null);
	got.overviewAfterClientNav = await p.evaluate('document.title');
	await p.click('#nav-chronology');
	await p.waitFor(`${ready('chronology')} && document.title === ${J(want.chronology)}`, 8000).catch(() => null);
	got.chronologyAfterClientNav = await p.evaluate('document.title');
	want.brand = ctx.brandName(main);
	const ok = got.brand === want.brand && got.overview === want.overview && got.chronology === want.chronology && got.document === want.document && got.unavailable === want.unavailable &&
		got.overviewAfterClientNav === want.overview && got.chronologyAfterClientNav === want.chronology;
	return { pass: ok, evidence: { example: ex?.id ?? 'none left', want, got, caseName: ctx.caseName(main), titleName: kase } };
}

/**
 * BA-18 + the 42 extension points. A view whose owner route exists in the tree under test must render its label as
 * the heading, data-ready="<id>", no unavailable state and aria-current on its entry; every other M2 view keeps the
 * unavailable state naming its owner. Implemented plus unavailable is 40. startServer passes the app no
 * CLEARCASE_ANALYSIS_ADDITIONS, so the analysis additions are off and Timeline, Defence & Rebuttal and Info Required keep
 * v5's heading (ADR 0003, GRS-48).
 */
export async function views42(ctx) {
	const { A, p, main, ROOT } = ctx;
	const rv = main.resultsVersion;
	const m = await modes(ctx);
	const byId = new Map(m.views.map((v) => [v.id, v]));
	const inv = readJson(join(ROOT, 'docs', 'plan', 'view-coverage.json')).views;
	const plan = new Map(readJson(join(ROOT, 'docs', 'plan', 'work-items.json')).items.map((i) => [i.key, i.linear?.identifier ?? null]));
	await p.goto(`${A.v(rv)}/overview`, ready('overview'));
	const nav = await p.evaluate(`[...document.querySelectorAll('nav.views a[id^="nav-"]')].map((a) => { const c = a.cloneNode(true); c.querySelectorAll('.visually-hidden').forEach((x) => x.remove()); return { id: a.id.slice(4), label: c.textContent.trim(), status: a.dataset.status, href: a.getAttribute('href') }; })`);
	const order = nav.length === 42 && inv.length === 42 && nav.every((n, i) => n.id === inv[i].id && n.label === inv[i].label);
	const per = [];
	for (const v of inv) {
		const owner = v.owner === 'CC-03' ? null : plan.get(v.owner);
		const kind = byId.has(v.id) ? readyKind(byId.get(v.id), m.implemented) : `view:${v.id}`;
		const heading = viewHeading(v, false);
		await p.click(`#nav-${v.id}`);
		await p.waitFor(`${ready(kind)} && document.querySelector('[data-page-heading]')?.textContent.trim() === ${J(heading)}`, 10000).catch(() => null);
		const s = await p.evaluate(`({ path: location.pathname, h1: document.querySelector('[data-page-heading]')?.textContent.trim() ?? null, ready: document.querySelector('main#main')?.dataset.ready ?? null,
			unavailable: document.querySelector('[data-unavailable]')?.dataset.unavailable ?? null, owner: document.querySelector('[data-unavailable]')?.dataset.owner ?? null,
			text: document.querySelector('[data-unavailable]')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? null, current: document.querySelector('nav.views a[aria-current="page"]')?.id ?? null })`);
		const n = nav.find((x) => x.id === v.id);
		const implemented = m.implemented.has(v.id);
		const ok = byId.has(v.id) && destinationOk({ ...byId.get(v.id), label: heading }, s, { owner, implemented: m.implemented, navStatus: n?.status });
		per.push({ id: v.id, ok, owner, implemented, ...s });
	}
	const unknown = {};
	for (const path of ['/analysis/no_such_view', '/no_such_category/matter', '/quantum/matter', '/evidence/chronology']) unknown[path] = (await A.c.get(`${vpath(rv)}${path}`)).status;
	const search = await A.c.get(`${vpath(rv)}/search`);
	const searchImplemented = m.implemented.has('search');
	await p.goto(`${A.v(rv)}/search`, ready(searchImplemented ? 'search' : 'view:search'));
	const searchBrowser = await p.evaluate(`({ path: location.pathname, unavailable: document.querySelector('[data-unavailable]')?.dataset.unavailable ?? null })`);
	const unavailableCount = per.filter((x) => x.unavailable).length;
	const implementedCount = per.filter((x) => x.implemented && x.unavailable === null).length;
	const ok = order && per.every((x) => x.ok) && implementedCount + unavailableCount === 40 && Object.values(unknown).every((s) => s === 404) &&
		[307, 308].includes(search.status) && search.location === `${vpath(rv)}/evidence/search` && searchBrowser.path === `${vpath(rv)}/evidence/search` && searchBrowser.unavailable === (searchImplemented ? null : 'search');
	return { pass: ok, evidence: { registryOrderAndLabels: order, navCount: nav.length, implementedCount, unavailableCount, modes: m.summary, failed: per.filter((x) => !x.ok), unknown, searchRedirect: { status: search.status, location: search.location }, searchBrowser } };
}

/**
 * BA-04: the date basis is shown only as supplied. v1 supplies none, so the Date basis column is hidden and undated rows
 * say 'undated' in the Date column; v2 supplies some, so the column shows dated rows 'unknown', undated 'undated' and
 * supplied values as supplied.
 */
export async function dateBasis(ctx) {
	const { A, p, main } = ctx;
	const basisOf = `[...document.querySelectorAll('[role=row][data-ref]')].map((r) => { const s = r.querySelector('[data-date-basis]'); return { ref: r.dataset.ref, date: r.querySelectorAll('[role=cell]')[1]?.textContent.trim() ?? null, basis: s?.dataset.dateBasis ?? null, text: s?.textContent.trim() ?? null, title: s?.title ?? null }; })`;
	await p.goto(`${A.v(main.resultsVersion)}/chronology`, `${ready('chronology')} && ${ROWS}.length > 0`);
	const v1 = await p.evaluate(basisOf);
	const v1ok = v1.length === main.chronology.length && v1.every((r) => r.basis === null && r.date === (main.chronology.find((x) => x.ref === r.ref).date || 'undated'));
	const docDate = async (rv, ref) => { await p.goto(`${A.v(rv)}/doc/${ref}`, docReady(ref)); return p.evaluate(`document.querySelector('#doc-date')?.textContent.replace(/\\s+/g, ' ').trim() ?? null`); };
	const docs = { dated: await docDate(main.resultsVersion, 'OD-002'), undated: await docDate(main.resultsVersion, 'OD-003') };
	// v2 of the same case: rows that carry date_type/date_source (via the fixture edit), previewed as a candidate
	const v2 = (ctx.v2 = await mainCase(join(ctx.tmp, 'main-v2'), { caseDir: main.caseDir, dated: true }));
	const imp = await A.c.importPkg(v2.caseDir, v2.pkgDir);
	ctx.v2Import = imp;
	if (!imp.importId) throw new Error(`v2 import failed: ${imp.status} ${imp.location}`);
	await p.goto(`${A.v(v2.resultsVersion)}/chronology`, `${ready('chronology')} && ${ROWS}.length > 0`);
	const v2rows = await p.evaluate(basisOf);
	const docsV2 = { supplied: await docDate(v2.resultsVersion, 'EM-0001'), typeOnly: await docDate(v2.resultsVersion, 'OD-002') };
	const em = v2rows.find((r) => r.ref === 'EM-0001'), od = v2rows.find((r) => r.ref === 'OD-002'), others = v2rows.filter((r) => !['EM-0001', 'OD-002'].includes(r.ref));
	const ok = v1ok && docs.dated === '2001-02-28 (basis unknown: the source gives no date type or provenance)' && docs.undated === 'undated (undated: the source gives no date)' &&
		em?.basis === 'supplied' && em.text === 'sent' && em.title === 'type sent, source message header' && od?.basis === 'supplied' && od.text === 'issue' && od.title === 'type issue' &&
		others.every((r) => r.basis === 'unknown' || r.basis === 'undated') && docsV2.supplied === '2001-02-03 (type sent, source message header)' && docsV2.typeOnly === '2001-02-28 (type issue)';
	return { pass: ok, evidence: { v1, docs, v2: { resultsVersion: v2.resultsVersion, import: imp.location, rows: v2rows.filter((r) => r.basis === 'supplied') }, docsV2 } };
}

/** BA-09: e-mail original plus attachments through the parent; negative control with a deleted original. */
export async function sourceRoutes(ctx) {
	const { A, b, p, main } = ctx;
	await p.goto(`${A.v(main.resultsVersion)}/doc/EM-0001`, docReady('EM-0001'));
	const em = await p.evaluate(`({ route: document.querySelector('#original-state [data-route]')?.dataset.route ?? null, state: document.querySelector('#original-state')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
		presentation: document.querySelector('section.original')?.dataset.presentation ?? null, open: document.querySelector('#open-original')?.href ?? null,
		attachments: [...document.querySelectorAll('#attachments li[data-route]')].map((li) => ({ key: li.dataset.attachment, route: li.dataset.route, href: li.querySelector('a')?.href ?? null, text: li.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90) })) })`);
	const pop = nextPopup(b);
	await p.click('#open-original');
	const w = await pop;
	let opened;
	try {
		await w.waitFor(`document.readyState === 'complete' && document.contentType`, 10000);
		opened = await w.ev(`({ origin: location.origin, contentType: document.contentType, text: document.body?.innerText.slice(0, 60) ?? null, scripts: document.scripts.length })`);
	} finally { await w.close(); }
	// negative control: one original deleted from a disposable case folder before import (candidate only)
	const neg = (ctx.missing = await missingCase(join(ctx.tmp, 'missing')));
	const imp = await A.c.importPkg(neg.caseDir, neg.pkgDir);
	const rep = await A.c.report(imp.importId);
	await p.goto(`${A.v(neg.resultsVersion)}/doc/${neg.goneRef}`, docReady(neg.goneRef));
	const miss = await p.evaluate(`({ route: document.querySelector('#original-state [data-route]')?.dataset.route ?? null, state: document.querySelector('#original-state')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
		file: document.querySelector('section.original')?.dataset.originalState ?? null, download: !!document.querySelector('#download-original'), open: !!document.querySelector('#open-original'),
		anyOriginalsLink: [...document.querySelectorAll('main a[href]')].filter((a) => a.href.startsWith(${J(A.orig)})).length })`);
	const name = encodeURIComponent(neg.gone.split('/').pop());
	const o410 = await A.o(`/o/${neg.resultsVersion}/${neg.goneRef}/${name}`);
	const present = await A.o(`/o/${main.resultsVersion}/${neg.goneRef}/${name}?download=1`);
	await p.goto(`${A.v(neg.resultsVersion)}/overview`, ready('overview'));
	const counts = await p.evaluate(`({ missing: document.querySelector('#count-missing')?.textContent.trim(), candidate: !!document.querySelector('#candidate-banner') })`);
	// An original removed AFTER activation (the active main case): the document page checks the file when it renders
	// and shows the missing state without links, the originals site answers 410, and restoring the file (the
	// documented recovery) brings the links back.
	const docState = `({ file: document.querySelector('section.original')?.dataset.originalState ?? null, onDisk: document.querySelector('section.original')?.dataset.onDisk ?? null,
		route: document.querySelector('#original-state [data-route]')?.dataset.route ?? null, path: document.querySelector('#original-state code')?.title ?? null,
		state: document.querySelector('#original-state')?.textContent.replace(/\\s+/g, ' ').trim() ?? null, open: !!document.querySelector('#open-original'), download: !!document.querySelector('#download-original'),
		anyOriginalsLink: [...document.querySelectorAll('main a[href]')].filter((a) => a.href.startsWith(${J(A.orig)})).length })`;
	const postDoc = `${A.v(main.resultsVersion)}/doc/OD-002`;
	await p.goto(postDoc, docReady('OD-002'));
	const post = { before: await p.evaluate(docState) };
	const postFile = join(main.caseDir, ...post.before.path.split('/'));
	const postBytes = readFileSync(postFile);
	rmSync(postFile);
	try {
		await p.goto(postDoc, docReady('OD-002'));
		post.removed = await p.evaluate(docState);
		const r = await A.o(`/o/${main.resultsVersion}/OD-002/${encodeURIComponent(post.before.path.split('/').pop())}`);
		post.originals = { status: r.status, text: r.text.slice(0, 80) };
	} finally { writeFileSync(postFile, postBytes); }
	await p.goto(postDoc, docReady('OD-002'));
	post.restored = await p.evaluate(docState);
	const postOk = post.before.file === 'present' && post.before.open && post.before.download && post.before.onDisk === null &&
		post.removed.file === 'missing' && post.removed.onDisk === 'unavailable' && post.removed.route === 'unavailable' && /missing on disk/.test(post.removed.state) &&
		!post.removed.open && !post.removed.download && post.removed.anyOriginalsLink === 0 && post.originals.status === 410 && post.originals.text === 'original not available: missing on disk' &&
		post.restored.file === 'present' && post.restored.open && post.restored.download && post.restored.onDisk === null;
	const ok = em.route === 'direct' && /^Direct original/.test(em.state) && em.presentation === 'text' && em.open?.startsWith(`${A.orig}/o/${main.resultsVersion}/EM-0001/`) &&
		em.attachments.length === 3 && em.attachments.every((x) => x.route === 'parent' && x.href === em.open) &&
		opened.origin === A.orig && opened.contentType === 'text/plain' && /^From: a@example\.invalid/.test(opened.text ?? '') &&
		rep.verdict === 'report' && rep.codes.ORIG_MISSING === 'warning' && miss.route === 'unavailable' && /^Original missing/.test(miss.state) && miss.file === 'missing' && !miss.download && !miss.open && miss.anyOriginalsLink === 0 &&
		o410.status === 410 && /^original not available/.test(o410.text) && present.status === 200 && counts.missing === '1' && counts.candidate && postOk;
	return { pass: ok, evidence: { email: em, openedParent: opened, negative: { report: { verdict: rep.verdict, ORIG_MISSING: rep.codes.ORIG_MISSING }, doc: miss, originalsStatus: o410.status, originalsBody: o410.text.slice(0, 80), sameRefInMainCase: present.status, overview: counts }, removedAfterActivation: post } };
}

/**
 * Overview widget slots (M2 extension point): exactly three, in order. A slot its owner's overview-widgets.ts fills
 * renders data-slot-status=filled under its heading; every other one renders unavailable and names its owner issue
 * (GRS-17 for deadlines and unbilled time, GRS-20 for rescan freshness); the retired combined card is gone.
 * The owners are cross-checked against docs/plan/work-items.json (CC-07 -> GRS-17, CC-10 -> GRS-20).
 */
export async function overviewSlots(ctx) {
	const { A, p, main, ROOT } = ctx;
	const plan = new Map(readJson(join(ROOT, 'docs', 'plan', 'work-items.json')).items.map((i) => [i.key, i.linear?.identifier ?? null]));
	const want = [
		{ id: 'deadlines', title: 'Open deadlines', owner: 'CC-07', linear: 'GRS-17' },
		{ id: 'unbilled-time', title: 'Unbilled time', owner: 'CC-07', linear: 'GRS-17' },
		{ id: 'rescan-freshness', title: 'Freshness', owner: 'CC-10', linear: 'GRS-20' },
	];
	await p.goto(`${A.v(main.resultsVersion)}/overview`, ready('overview'));
	const got = await p.evaluate(`({ slots: [...document.querySelectorAll('main section[data-slot]')].map((s) => ({ id: s.dataset.slot, status: s.dataset.slotStatus, h2: s.querySelector('h2')?.textContent.trim() ?? null,
		labelledBy: s.getAttribute('aria-labelledby'), text: s.querySelector('p')?.textContent.replace(/\\s+/g, ' ').trim() ?? null })),
		oldCard: [...document.querySelectorAll('main h2')].some((h) => /Deadlines and unbilled time/i.test(h.textContent)) })`);
	const { slots, filled } = await modes(ctx);
	const ok = got.slots.length === 3 && !got.oldCard && want.every((w, i) => {
		const s = got.slots[i];
		const decl = slots.find((d) => d.id === w.id);
		return s.id === w.id && !!decl && s.labelledBy === `slot-${w.id}` && plan.get(w.owner) === w.linear &&
			JSON.stringify(observedSlot({ id: s.id, status: s.status, heading: s.h2, text: s.text }, filled)) === JSON.stringify(expectedSlot(decl, filled));
	});
	return { pass: ok, evidence: { got, want, filled: [...filled], planOwners: Object.fromEntries(want.map((w) => [w.owner, plan.get(w.owner)])) } };
}
