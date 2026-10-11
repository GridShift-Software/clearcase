// State scenarios on app server A: rollback and stale rollback forms (S27/S60), link capability across a restart
// (S18), Back with the back/forward cache (BFCACHE), and each view's query kept for the tab session (NAV-STATE).
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, sleep } from './browser.mjs';
import { vpath } from './context.mjs';
import { ready, ROWS } from './main-flow.mjs';

const J = JSON.stringify;
const docReady = (ref) => ready(`doc:${ref}`);

/** S27 + S60: one-click rollback to the previous version; a replayed form changes nothing; Back shows the current state. */
export async function rollback(ctx) {
	const { A, p, main, v2 } = ctx;
	const act = await A.c.activate(ctx.v2Import.importId, { ack: true });
	const activeV2 = await A.c.activeVersion();
	// S8 (notes survive a new version): the S4 note written under v1 shows on the same document under v2
	await p.goto(`${A.v(v2.resultsVersion)}/doc/OD-001`, docReady('OD-001'));
	const noteUnderV2 = await p.evaluate(`[...document.querySelectorAll('#notes li[data-note]')].map((li) => ({ anchor: li.dataset.anchor, text: li.querySelector('.wrap').textContent }))`);
	const log0 = A.work('SELECT id, kind, version_id AS v FROM activation_log ORDER BY id');
	await p.goto(`${A.v(v2.resultsVersion)}/overview`, `${ready('overview')} && !!document.querySelector('#rollback-form')`);
	const form = await p.evaluate(`({ expect: document.querySelector('#rollback-form [name=expect]')?.value, to: document.querySelector('#rollback-form [name=to]')?.value, label: document.querySelector('#rollback')?.textContent.trim(), banner: !!document.querySelector('#active-banner') })`);
	await p.click('#rollback');
	await p.waitFor(`location.pathname === ${J(`${vpath(main.resultsVersion)}/overview`)} && ${ready('overview')} && !!document.querySelector('#active-banner')`, 30000);
	const afterClick = { active: await A.c.activeVersion(), path: await p.evaluate('location.pathname'), rollbackOffered: await p.evaluate(`document.querySelector('#rollback-form [name=to]')?.value ?? null`) };
	const log1 = A.work('SELECT id, kind, version_id AS v FROM activation_log ORDER BY id');
	// the same form replayed (second tab, double submit): refused, nothing changes
	const stale = await A.c.form(`${vpath(v2.resultsVersion)}/overview?/rollback`, { expect: form.expect, to: form.to });
	const bare = await A.c.form(`${vpath(v2.resultsVersion)}/overview?/rollback`, {});
	const afterStale = { active: await A.c.activeVersion(), log: A.work('SELECT count(*) AS n FROM activation_log')[0].n };
	// S60: six concurrent identical rollback posts (a double click across tabs) apply exactly once; then six back again
	const burst = async (expect, to) => {
		const st = (await Promise.all(Array.from({ length: 6 }, () => A.c.form(`${vpath(expect)}/overview?/rollback`, { expect, to })))).map((r) => r.status).sort();
		return { statuses: st, active: await A.c.activeVersion(), log: A.work('SELECT count(*) AS n FROM activation_log')[0].n };
	};
	const race1 = await burst(main.resultsVersion, v2.resultsVersion);
	const race2 = await burst(v2.resultsVersion, main.resultsVersion);
	const raceOk = J(race1.statuses) === J([303, 409, 409, 409, 409, 409]) && race1.active === v2.resultsVersion && race1.log === afterStale.log + 1 &&
		J(race2.statuses) === J([303, 409, 409, 409, 409, 409]) && race2.active === main.resultsVersion && race2.log === afterStale.log + 2;
	// Back to the v2 overview: it must show the current state (candidate, no rollback button), never the stale page
	await p.evaluate('history.back(); true');
	await p.waitFor(`location.pathname === ${J(`${vpath(v2.resultsVersion)}/overview`)} && ${ready('overview')}`, 15000);
	await sleep(1200); // a restored page checks /api/state and reloads; let it settle
	await p.waitFor(`document.readyState === 'complete' && ${ready('overview')} && window.__ccMounted >= 1`, 15000);
	const back = await p.evaluate(`({ path: location.pathname, nav: performance.getEntriesByType('navigation')[0]?.type ?? null, candidate: !!document.querySelector('#candidate-banner'), active: !!document.querySelector('#active-banner'), rollback: !!document.querySelector('#rollback') })`);
	const last = log1.at(-1);
	const ok = act.status === 303 && activeV2 === v2.resultsVersion && log0.at(-1)?.kind === 'activate' && log0.at(-1)?.v === v2.resultsVersion &&
		form.expect === v2.resultsVersion && form.to === main.resultsVersion && form.banner &&
		afterClick.active === main.resultsVersion && last.kind === 'rollback' && last.v === main.resultsVersion && log1.length === log0.length + 1 &&
		stale.status === 409 && /Nothing was changed/.test(stale.text) && bare.status === 409 && afterStale.active === main.resultsVersion && afterStale.log === log1.length &&
		back.candidate && !back.active && !back.rollback && noteUnderV2.some((n) => n.text === ctx.uiNote) && raceOk;
	return { pass: ok, evidence: { activateV2: { status: act.status, reasons: act.reasons }, noteUnderV2, concurrentRollbacks: [race1, race2], form, afterClick, activationLog: log1, stale: { status: stale.status, says: /Nothing was changed/.test(stale.text) }, withoutExpect: bare.status, afterStale, back } };
}

/** S18: capability links rendered before a restart work cross-site after it; the key lives in the data directory. */
export async function restartLinks(ctx) {
	const { A, b, p, main, sites } = ctx;
	const rv = main.resultsVersion;
	const links = async () => { await p.goto(`${A.v(rv)}/doc/EM-0001`, docReady('EM-0001')); return p.evaluate(`({ open: document.querySelector('#open-original').href, download: document.querySelector('#download-original').href })`); };
	const before = await links();
	const pid0 = A.srv.pid;
	const stop = await A.stop();
	await A.start();
	const after = await links();
	const key = statSync(join(A.dataDir, 'link-key'));
	const XS_DOC = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
	const path = (u) => { const x = new URL(u); return x.pathname + x.search; };
	const raw = (await A.o(path(before.open), XS_DOC)).status;
	const x = await openPage(b);
	const seen = [];
	const off = b.on((m) => { if (m.method === 'Network.responseReceived' && m.sessionId === x.sessionId && m.params.type === 'Document') seen.push(`${m.params.response.status} ${m.params.response.url.slice(0, 60)}`); });
	let nav;
	try {
		await x.navigate(`${sites.xsite}/`);
		await x.evaluate(`location.href = ${J(before.open)}; true`);
		await x.waitFor(`location.href === ${J(before.open)} && document.readyState === 'complete'`, 10000);
		nav = { url: await x.evaluate('location.href'), contentType: await x.evaluate('document.contentType'), text: await x.evaluate('document.body.innerText.slice(0, 40)') };
	} finally { off(); await x.close(); }
	const ok = stop.graceful && A.srv.pid !== pid0 && before.open === after.open && before.download === after.download && (key.mode & 0o777) === 0o600 && raw === 200 &&
		seen.some((s) => s.startsWith('200 ')) && nav.contentType === 'text/plain';
	return { pass: ok, evidence: { stop, pids: [pid0, A.srv.pid], sameLinksAfterRestart: before.open === after.open, linkKeyMode: (key.mode & 0o777).toString(8), rawCrossSite: raw, browser: { responses: seen, ...nav } } };
}

/**
 * BFCACHE: leave a document page (full navigation) and come Back. Measured, not assumed: whether Chromium restored
 * it from the back/forward cache (window state survives) is recorded; when restored and nothing changed it must not
 * reload (typed text survives); when the state changed meanwhile (a note added over HTTP) the page must show it.
 */
export async function bfcache(ctx) {
	const { A, b, main } = ctx;
	const rv = main.resultsVersion;
	const p = await openPage(b);
	const notUsed = [];
	const off = b.on((m) => { if (m.method === 'Page.backForwardCacheNotUsed' && m.sessionId === p.sessionId) notUsed.push({ at: Date.now(), reasons: m.params.notRestoredExplanations?.map((x) => x.reason) ?? [] }); });
	const out = {};
	try {
		const leaveAndBack = async (between) => {
			await p.goto(`${A.v(rv)}/doc/OD-002`, docReady('OD-002'));
			await p.type('#note-body', 'typed, not saved');
			await p.evaluate(`window.__bfMarker = 'kept'; true`);
			const doc = await p.evaluate('window.__ccDoc');
			const n0 = notUsed.length;
			await p.goto(`${A.origin}/import`, `!!document.querySelector('#import-form')`);
			await between?.();
			await p.evaluate('history.back(); true');
			await p.waitFor(`location.pathname.endsWith('/doc/OD-002') && document.readyState === 'complete' && !!document.querySelector('#note-body')`, 15000);
			await sleep(1500);
			await p.waitFor(`document.readyState === 'complete' && ${docReady('OD-002')}`, 15000);
			return { notRestored: notUsed.slice(n0), ...(await p.evaluate(`({ marker: window.__bfMarker ?? null, sameDocument: window.__ccDoc === ${J(doc)}, typed: document.querySelector('#note-body').value, nav: performance.getEntriesByType('navigation')[0]?.type ?? null,
				notes: [...document.querySelectorAll('#notes li[data-note] .wrap')].map((s) => s.textContent) })`)) };
		};
		out.unchanged = await leaveAndBack();
		out.unchanged.restored = out.unchanged.marker === 'kept' && out.unchanged.notRestored.length === 0;
		const note = `added over HTTP while away ${Date.now()}`;
		out.changed = await leaveAndBack(async () => { const r = await A.c.form(`${vpath(rv)}/doc/OD-002?/note`, { body: note }); out.noteStatus = r.status; });
		out.changed.restoredThenReloaded = out.changed.nav === 'reload';
		out.note = note;
	} finally { off(); await p.close(); }
	const u = out.unchanged, c = out.changed;
	// restored: no reload, typed text kept. Not restored: recorded with Chromium's reasons; Back shows the current page.
	const unchangedOk = u.restored ? u.sameDocument && u.typed === 'typed, not saved' : u.notRestored.length > 0 && u.typed === '';
	const changedOk = out.noteStatus === 200 && c.notes.includes(out.note) && c.marker === null && (u.restored ? c.nav === 'reload' : true);
	return { pass: unchangedOk && changedOk, evidence: out };
}

/** S4: a note typed through the document page's form (progressive enhancement, no reload) shows in the list and persists. */
export async function notesUi(ctx) {
	const { A, p, main } = ctx;
	const rv = main.resultsVersion;
	const body = `UI note <b>not markup</b> ${Date.now()}`;
	ctx.uiNote = body;
	await p.goto(`${A.v(rv)}/doc/OD-001`, docReady('OD-001'));
	const doc0 = await p.evaluate('window.__ccDoc');
	await p.type('#note-body', body);
	await p.click('#note-add');
	await p.waitFor(`[...document.querySelectorAll('#notes li[data-note] .wrap')].some((s) => s.textContent === ${J(body)})`, 10000);
	const after = await p.evaluate(`({ sameDocument: window.__ccDoc === ${J(doc0)}, notes: [...document.querySelectorAll('#notes li[data-note]')].map((li) => ({ anchor: li.dataset.anchor, text: li.querySelector('.wrap').textContent, bold: !!li.querySelector('.wrap b') })), cleared: document.querySelector('#note-body').value })`);
	await p.goto(`${A.v(rv)}/doc/OD-001`, docReady('OD-001'));
	const reloaded = await p.evaluate(`[...document.querySelectorAll('#notes li[data-note] .wrap')].map((s) => s.textContent)`);
	const n = after.notes.find((x) => x.text === body);
	const ok = after.sameDocument && !!n && n.anchor === 'here' && !n.bold && after.cleared === '' && reloaded.includes(body);
	return { pass: ok, evidence: { after, reloaded, body } };
}

/**
 * NAV-STATE (CC-04 verification lane 01): the sidebar keeps each view's last query per case for the tab session. A text
 * filter on the chronology survives a trip to Advanced Search and back by the sidebar, and by Back; a chronology opened
 * with its own query keeps that query; opening it plainly forgets the saved one. Only sessionStorage holds it.
 */
export async function navState(ctx) {
	const { A, p, main } = ctx;
	const V = A.v(main.resultsVersion);
	const chronology = `${vpath(main.resultsVersion)}/chronology`;
	const state = () => p.evaluate(`({ path: location.pathname, search: location.search, q: document.querySelector('#f-q')?.value ?? null, rows: ${ROWS}, link: document.querySelector('#nav-chronology').getAttribute('href') })`);
	const atChronology = (search) => `location.pathname === ${J(chronology)} && location.search === ${J(search)} && ${ready('chronology')}`;
	const atSearch = `location.pathname.endsWith('/evidence/search') && /^(view:)?search$/.test(document.querySelector('main#main')?.dataset.ready ?? '')`;
	const linkIs = (search) => `document.querySelector('#nav-chronology').getAttribute('href') === ${J(chronology + search)}`;
	const stored = () => p.evaluate(`({ session: Object.keys(sessionStorage).filter((k) => k.startsWith('clearcase:view-query:')).map((k) => [k.split(':').at(-1), sessionStorage.getItem(k)]), local: Object.keys(localStorage).filter((k) => k.startsWith('clearcase:')).length })`);
	await p.goto(`${V}/chronology`, ready('chronology'));
	const all = (await state()).rows;
	await p.type('#f-q', 'ZEBRA');
	await p.waitFor(`location.search === '?q=ZEBRA' && ${ROWS}.length < ${all.length} && ${linkIs('?q=ZEBRA')}`, 5000).catch(() => null);
	const filtered = await state();
	await p.click('#nav-search');
	await p.waitFor(atSearch, 15000).catch(() => null);
	const onSearch = await state();
	const storedOnSearch = await stored();
	await p.click('#nav-chronology');
	await p.waitFor(`${atChronology('?q=ZEBRA')} && ${ROWS}.length === ${filtered.rows.length}`, 15000).catch(() => null);
	const viaSidebar = await state();
	// Back to Advanced Search, Back again to the filtered chronology entry
	await p.evaluate('history.back(); true');
	await p.waitFor(atSearch, 15000).catch(() => null);
	await p.evaluate('history.back(); true');
	await p.waitFor(`${atChronology('?q=ZEBRA')} && ${ROWS}.length === ${filtered.rows.length}`, 15000).catch(() => null);
	const viaBack = await state();
	// opened with its own query: that query, not the saved one; then opened plainly: the saved query is forgotten
	await p.goto(`${V}/chronology?q=em-000`, atChronology('?q=em-000'));
	await p.waitFor(linkIs('?q=em-000'), 5000).catch(() => null);
	const explicit = await state();
	await p.goto(`${V}/chronology`, atChronology(''));
	await p.waitFor(`!Object.keys(sessionStorage).some((k) => k.startsWith('clearcase:view-query:'))`, 5000).catch(() => null);
	const plain = await state();
	const storedAfter = await stored();
	const same = (x) => x.path === chronology && x.search === '?q=ZEBRA' && x.q === 'ZEBRA' && J(x.rows) === J(filtered.rows);
	const checks = {
		filtered: filtered.search === '?q=ZEBRA' && filtered.rows.length > 0 && filtered.rows.length < all.length && filtered.link === `${chronology}?q=ZEBRA`,
		searchLinkCarriesQuery: onSearch.path.endsWith('/evidence/search') && onSearch.link === `${chronology}?q=ZEBRA`,
		storedInSessionOnly: J(storedOnSearch.session) === J([['chronology', '?q=ZEBRA']]) && storedOnSearch.local === 0,
		backViaSidebar: same(viaSidebar),
		backViaHistory: same(viaBack),
		explicitQueryKept: explicit.search === '?q=em-000' && explicit.q === 'em-000' && explicit.link === `${chronology}?q=em-000`,
		plainForgets: plain.search === '' && plain.q === '' && J(plain.rows) === J(all) && plain.link === chronology && storedAfter.session.length === 0 && storedAfter.local === 0,
	};
	return { pass: Object.values(checks).every(Boolean), evidence: { checks, rows: { all: all.length, filtered: filtered.rows }, filtered, onSearch, storedOnSearch, viaSidebar, viaBack, explicit, plain: { ...plain, rows: plain.rows.length }, storedAfter } };
}
