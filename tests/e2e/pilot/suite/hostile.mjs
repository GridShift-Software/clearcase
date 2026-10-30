// S13 on its own app server B: the hostile package (lib/fixtures.ts hostileOriginals + hostileRows, a hostile
// narrative and a row whose declared filename lies) imports as a candidate, activates with the acknowledgement, renders
// inert everywhere, and none of its originals executes in any frame or tab when opened through the app UI.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nextPopup, openPage, sleep } from './browser.mjs';
import { HOSTILE_NARRATIVE, LYING_NAME, UNSAFE_LINK_NARRATIVE, hostileCase } from './cases.mjs';
import { ORIGINALS_HOSTNAME, vpath } from './context.mjs';
import { ready, viewerState } from './main-flow.mjs';

const J = JSON.stringify;
const docReady = (ref) => ready(`doc:${ref}`);

/** Expected presentation per hostile original, re-derived from its bytes, extension and declared type (independent table). */
const EXPECT = {
	'HX-001': { file: 'HOSTILE/HX-001 page.html', presentation: 'text', raw: ['text/plain; charset=utf-8', 'inline'] },
	'HX-002': { file: 'HOSTILE/HX-002 drawing.svg', presentation: 'download', raw: ['application/octet-stream', 'attachment'] },
	'HX-003': { file: 'HOSTILE/HX-003 notes.txt', presentation: 'text', raw: ['text/plain; charset=utf-8', 'inline'] },
	'HX-004': { file: 'HOSTILE/HX-004 polyglot.pdf', presentation: 'viewer', raw: ['application/octet-stream', 'attachment'], viewer: 'error' },
	'HX-005': { file: 'HOSTILE/HX-005 open-action.pdf', presentation: 'viewer', raw: ['application/octet-stream', 'attachment'], viewer: '1', js: true },
	'HX-006': { file: 'HOSTILE/HX-006 launch.pdf', presentation: 'viewer', raw: ['application/octet-stream', 'attachment'], viewer: '1' },
	'HX-007': { file: 'HOSTILE/HX-007 uri.pdf', presentation: 'viewer', raw: ['application/octet-stream', 'attachment'], viewer: '1' },
	'HX-008': { file: 'HOSTILE/HX-008 mail.eml', presentation: 'text', raw: ['text/plain; charset=utf-8', 'inline'] },
	'HX-009': { file: 'HOSTILE/HX-009 image.png', presentation: 'inline', raw: ['image/png', 'inline'] },
	'HX-010': { file: 'HOSTILE/HX-010 fake.png', presentation: 'download', raw: ['application/octet-stream', 'attachment'], flag: 'download-only' },
};

const PROBE = (allowed) => `(() => { const all = [...document.querySelectorAll('*')];
	return { onAttrs: all.filter((e) => [...e.attributes].some((x) => /^on/i.test(x.name))).map((e) => e.tagName).slice(0, 5),
		inlineScriptsNoNonce: [...document.scripts].filter((s) => !s.src && !s.nonce && s.type !== 'application/json').length,
		injected: [...document.querySelectorAll('body img, body svg:not(button.nav-toggle > svg), body iframe, body object, body embed, body style, base, body script:not([src]):not([nonce]), body meta, body link')].map((e) => e.tagName).slice(0, 5),
		badHrefs: [...document.querySelectorAll('a[href], area[href], form[action], [src]')].map((x) => x.getAttribute('href') ?? x.getAttribute('action') ?? x.getAttribute('src') ?? '')
			.filter((h) => /^\\s*(javascript|data|vbscript):/i.test(h) || (/^[a-z][a-z0-9+.-]*:/i.test(h) && !${J(allowed)}.some((o) => h.startsWith(o)))),
		literalScriptText: document.body.innerText.includes('<script>'), title: document.title }; })()`;

export async function s13(ctx) {
	const { B, b, L, R } = ctx;
	await B.start();
	const sc = await hostileCase(join(ctx.tmp, 'hostile'));
	const rv = sc.resultsVersion;
	const allowed = [B.origin, B.orig];
	const t0 = Date.now(), mk0 = b.mark();
	const p = await openPage(b);
	await p.goto(`${B.origin}/import`, `!!document.querySelector('#import-form')`);
	await p.evaluate(`localStorage.setItem('cc-sentinel', 'app'); true`);
	// a narrative with a javascript: markdown link is rejected outright (validator), nothing stored
	const unsafe = await hostileCase(join(ctx.tmp, 'hostile-unsafe'), { narrative: UNSAFE_LINK_NARRATIVE });
	const ui = await B.c.importPkg(unsafe.caseDir, unsafe.pkgDir);
	const unsafeRep = await B.c.report(ui.importId);
	const unsafeStored = B.results('SELECT count(*) AS n FROM version WHERE id = ?', unsafe.resultsVersion)[0].n;
	// S13a: UI import -> report (candidate) -> activation with the acknowledgement
	await p.type('#caseFolder', sc.caseDir);
	await p.type('#packageSource', sc.pkgDir);
	await p.click('#validate');
	await p.waitFor(`/^\\/import\\/\\d+$/.test(location.pathname) && !!document.querySelector('main[data-verdict]')`, 60000);
	const reportPath = await p.evaluate('location.pathname');
	const rep = await p.evaluate(`({ verdict: document.querySelector('main').dataset.verdict, candidate: document.querySelector('#candidate-heading')?.textContent.trim() ?? null, ack: !!document.querySelector('#ack') })`);
	const reportProbe = await p.evaluate(PROBE(allowed));
	await p.click('#ack');
	await p.click('#activate');
	await p.waitFor(`${ready('overview')} && !!document.querySelector('#active-banner')`, 60000);
	const active = await B.c.activeVersion();
	const aOk = unsafeRep.verdict === 'reject' && unsafeRep.codes.LINK_UNSAFE_SCHEME === 'error' && unsafeStored === 0 && !unsafeRep.canActivate &&
		rep.verdict === 'report' && rep.candidate === 'Candidate' && rep.ack && active === rv;
	R.rec('S13a', 'hostile package imports as a candidate (report) and activates with the acknowledgement; a javascript: narrative link package is rejected', aOk ? 'PASS' : 'FAIL',
		{ unsafeLinkPackage: { verdict: unsafeRep.verdict, LINK_UNSAFE_SCHEME: unsafeRep.codes.LINK_UNSAFE_SCHEME, stored: unsafeStored }, report: rep, active });

	// S13b: inert rendering on overview, chronology, every document page and the import report
	const pages = { overview: `${vpath(rv)}/overview`, chronology: `${vpath(rv)}/chronology`, importReport: reportPath };
	for (const r of Object.keys(EXPECT)) pages[`doc ${r}`] = `${vpath(rv)}/doc/${r}`;
	const narrative = { importReport: reportProbe };
	for (const [name, u] of Object.entries(pages)) {
		await p.goto(B.origin + u, name.startsWith('doc ') ? docReady(name.slice(4)) : name === 'overview' ? ready('overview') : name === 'chronology' ? ready('chronology') : 'true');
		await sleep(150);
		narrative[name] = await p.evaluate(PROBE(allowed));
	}
	await p.goto(`${B.origin}${vpath(rv)}/overview`, ready('overview'));
	const ov = await p.evaluate(`({ narrativeText: document.querySelector('.narrative')?.textContent ?? null, cites: [...document.querySelectorAll('.narrative a')].map((a) => a.getAttribute('href')), subtitle: document.querySelector('.subtitle')?.textContent ?? null })`);
	const ev1 = b.since(mk0);
	const n1 = L.since(t0);
	const inert = (x) => x.onAttrs.length === 0 && x.inlineScriptsNoNonce === 0 && x.injected.length === 0 && x.badHrefs.length === 0 && !/PWNED/.test(x.title);
	const bOk = Object.values(narrative).every(inert) && narrative.overview.literalScriptText && ov.narrativeText?.includes(`<script>document.title='PWNED narrative'</script>`) &&
		J(ov.cites) === J([`${vpath(rv)}/doc/HX-001`, `${vpath(rv)}/doc/HX-005?page=1`]) && ev1.dialogs.length === 0 && ev1.titles.every((t) => !/PWNED/.test(t.title)) && n1.realHits.length === 0 && n1.offOriginRequests.length === 0;
	R.rec('S13b', 'hostile narrative, filenames and links render inert on overview, chronology, document pages and the import report', bOk ? 'PASS' : 'FAIL',
		{ failedPages: Object.entries(narrative).filter(([, x]) => !inert(x)), overview: ov, dialogs: ev1.dialogs, pwnedTitles: ev1.titles.filter((t) => /PWNED/.test(t.title)), canary: n1.realHits, offOrigin: n1.offOriginRequests, narrativeSource: HOSTILE_NARRATIVE });

	// S13c-f: open every hostile original through the app UI
	const per = {};
	for (const [ref, exp] of Object.entries(EXPECT)) {
		await p.goto(`${B.origin}${vpath(rv)}/doc/${ref}`, docReady(ref));
		const d = await p.evaluate(`({ presentation: document.querySelector('section.original')?.dataset.presentation ?? null, path: document.querySelector('#original-state code')?.textContent ?? null, flag: document.querySelector('[data-flag]')?.dataset.flag ?? null,
			family: document.querySelector('#original-family')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 100) ?? null, open: document.querySelector('#open-original')?.href ?? null, download: document.querySelector('#download-original')?.href ?? null, filenameCell: [...document.querySelectorAll('table.fields tr')].find((tr) => tr.querySelector('th')?.textContent.startsWith('Filename'))?.querySelector('td')?.textContent ?? null })`);
		const o = { exp: exp.presentation, ...d };
		const rawPath = (d.download ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/&download=1$/, '');
		const r = rawPath ? await B.o(rawPath) : null;
		const h = r?.headers ?? {};
		o.http = r && { status: r.status, type: h['content-type'], disp: (h['content-disposition'] ?? '').split(';')[0], csp: h['content-security-policy'] ?? null, nosniff: h['x-content-type-options'], corp: h['cross-origin-resource-policy'], coop: h['cross-origin-opener-policy'], referrer: h['referrer-policy'], cache: h['cache-control'],
			bytesMatch: r.status === 200 && Buffer.compare(r.body, Buffer.from(sc.originals[exp.file])) === 0 };
		const t1 = Date.now(), mk = b.mark();
		if (d.open) {
			const pop = nextPopup(b, 10000);
			await p.click('#open-original');
			const w = await pop;
			try {
				await sleep(exp.presentation === 'viewer' ? 300 : 1500);
				if (exp.presentation === 'viewer') {
					const v = await viewerState(b, w);
					await sleep(1500); // let any PDF action fire
					const after = await v.ev(`({ ready: document.body.dataset.ready, url: location.pathname })`).catch((e) => ({ error: String(e) }));
					o.viewer = { wrapperOrigin: v.wrapper.origin, wrapperReady: v.wrapper.ready, wrapperUrlStays: (await w.ev('location.href')) === v.wrapper.url, frameOrigin: v.frame.origin, frameReady: v.frame.ready, frameAfter: after,
						status: v.frame.status, jsNote: v.frame.jsNote, jsActions: v.frame.state?.jsActions ?? null, options: v.frame.state?.options ?? null, error: v.frame.state?.error ?? null, inlineScripts: v.frame.inlineScripts, bodyText: v.frame.bodyText.slice(0, 120) };
				} else {
					await w.waitFor(`document.readyState === 'complete' && document.contentType`, 10000);
					o.page = await w.ev(`({ origin: self.origin, urlOrigin: location.origin, contentType: document.contentType, scripts: document.scripts.length, images: document.images.length, title: document.title, text: (document.body?.innerText ?? '').slice(0, 60) })`);
				}
			} finally { await w.close(); }
		} else if (d.download) {
			await p.click('#download-original');
			await sleep(1500);
			o.stayed = (await p.evaluate('location.pathname')) === `${vpath(rv)}/doc/${ref}`;
		}
		const ev = b.since(mk);
		const net = L.since(t1);
		o.browser = { dialogs: ev.dialogs.map((x) => x.message), pwned: ev.titles.filter((x) => /PWNED/.test(x.title)).map((x) => x.title), downloads: ev.downloads.map((x) => x.suggestedFilename), pages: ev.targets.filter((x) => x.type === 'page').length, canary: net.realHits, offOrigin: net.offOriginRequests };
		per[ref] = o;
	}
	await p.goto(`${B.origin}${vpath(rv)}/overview`, ready('overview'));
	const storage = await p.evaluate(`({ keys: Object.keys(localStorage), sentinel: localStorage.getItem('cc-sentinel'), pwned: localStorage.getItem('pwned'), cookie: document.cookie })`);
	await p.close();
	// opening one original creates exactly its own tab (viewer or raw) and nothing else; a download-only one none
	const executed = Object.entries(per).filter(([, o]) => o.browser.dialogs.length || o.browser.pwned.length || o.browser.canary.length || o.browser.offOrigin.length || o.browser.pages !== (o.open ? 1 : 0));
	const cOk = executed.length === 0 && storage.sentinel === 'app' && storage.pwned === null && J(storage.keys) === J(['cc-sentinel']);
	R.rec('S13c', 'no hostile original executes in any frame or tab when opened through the app UI; app storage untouched', cOk ? 'PASS' : 'FAIL', { executed: executed.map(([r, o]) => ({ ref: r, ...o.browser })), storage });

	// presentation from the verified mapping (path + family), never from the row's declared name
	const presOk = (ref, o) => {
		const e = EXPECT[ref];
		if (o.presentation !== e.presentation || o.path !== e.file) return false;
		if (e.flag && o.flag !== e.flag) return false;
		if (e.presentation === 'viewer') return !!o.open && o.open.includes(`/view/${rv}/${ref}?k=`) && !!o.viewer && o.viewer.wrapperOrigin === B.orig && o.viewer.frameOrigin === 'null' && o.viewer.wrapperReady === e.viewer && o.viewer.frameReady === e.viewer && o.viewer.wrapperUrlStays &&
			o.viewer.inlineScripts === 0 && o.viewer.options?.enableScripting === false &&
			(e.viewer === 'error' ? /cannot be displayed/.test(o.viewer.status ?? '') && !/polyglot\s*$/.test(o.viewer.bodyText) : true) &&
			(e.js ? /contains JavaScript/.test(o.viewer.jsNote ?? '') && /not run/.test(o.viewer.jsNote ?? '') && (o.viewer.jsActions?.document?.length ?? 0) > 0 : o.viewer.jsNote === null);
		if (e.presentation === 'text') return !!o.open && o.page?.origin === 'null' && o.page.contentType === 'text/plain' && o.page.scripts === 0;
		if (e.presentation === 'inline') return !!o.open && o.page?.contentType === 'image/png' && o.page.origin === 'null' && o.page.urlOrigin === B.orig;
		return !o.open && !!o.download && o.browser.downloads.length === 1 && o.stayed && o.browser.pages === 0;
	};
	const mism = Object.entries(per).filter(([r, o]) => !presOk(r, o));
	const lying = per['HX-001'];
	const dOk = mism.length === 0 && lying.path === 'HOSTILE/HX-001 page.html' && lying.presentation === 'text' && (lying.filenameCell ?? '').includes(LYING_NAME.replace('.pdf', ''));
	R.rec('S13d', 'hostile originals: html/eml/txt as sandboxed text/plain, svg and fake.png download-only, polyglot only in pdf.js (fails to render), JS/Launch/URI PDFs inert in the real viewer; labels from the verified mapping', dOk ? 'PASS' : 'FAIL',
		{ mismatches: mism.map(([r, o]) => ({ ref: r, ...o })), table: Object.fromEntries(Object.entries(per).map(([r, o]) => [r, { presentation: o.presentation, path: o.path, flag: o.flag, viewer: o.viewer && `${o.viewer.wrapperReady}/${o.viewer.frameReady} ${o.viewer.jsNote ?? ''} ${o.viewer.status ?? ''}`.trim(), page: o.page && `${o.page.contentType} origin=${o.page.origin}`, downloads: o.browser.downloads }])), lyingName: { declared: LYING_NAME, shownPath: lying.path, filenameCell: lying.filenameCell } });

	// headers: raw bytes from the originals site, and every 200 the browser received from it during this scenario
	const full = (x, corp = 'same-origin') => x.nosniff === 'nosniff' && /^sandbox\b/.test(x.csp ?? '') && x.corp === corp && x.coop === 'same-origin' && x.referrer === 'no-referrer' && x.cache === 'private, no-store';
	const rawBad = Object.entries(per).filter(([r, o]) => !(o.http && o.http.status === 200 && full(o.http) && o.http.type === EXPECT[r].raw[0] && o.http.disp === EXPECT[r].raw[1] && o.http.bytesMatch));
	const seen = L.originalsResponses.filter((x) => x.at >= t0 && x.status === 200 && new URL(x.url).port === String(B.origPort));
	const seenBad = seen.filter((x) => {
		const h = { nosniff: x.headers['x-content-type-options'], csp: x.headers['content-security-policy'], corp: x.headers['cross-origin-resource-policy'], coop: x.headers['cross-origin-opener-policy'], referrer: x.headers['referrer-policy'], cache: x.headers['cache-control'] };
		return !full(h, new URL(x.url).pathname.startsWith('/_pdfjs/') ? 'cross-origin' : 'same-origin');
	});
	const eOk = rawBad.length === 0 && seenBad.length === 0 && seen.length > 10;
	R.rec('S13e', 'every 200 from the originals site carries nosniff, a sandbox CSP, CORP (same-origin; cross-origin only for the bundled pdf.js), COOP, no-referrer and private no-store', eOk ? 'PASS' : 'FAIL',
		{ rawMismatches: rawBad.map(([r, o]) => ({ ref: r, http: o.http, expected: EXPECT[r].raw })), browserResponses200: seen.length, browserBad: seenBad.map((x) => ({ url: x.url.slice(0, 100), headers: x.headers })) });

	// positive control: the same OpenAction/Names JavaScript PDF DOES run in Chromium's own PDF viewer (PDFium)
	const ctl = await L.control('S13 PDFium control', async () => {
		const q = await openPage(b);
		const mk = b.mark();
		try { await q.navigate(`${ctx.sites.pdfium}/hx-005.pdf`); await sleep(3000); } finally { await q.close(); }
		return b.since(mk).dialogs.map((x) => x.message);
	});
	const fOk = ctl.includes('openaction') || ctl.includes('names');
	R.rec('S13-CONTROL', 'positive control (labelled): HX-005 served raw to PDFium executes its JavaScript (app.alert), so the viewer result above is meaningful', fOk ? 'PASS' : 'FAIL', { pdfiumDialogs: ctl });
	const rawCtx = readFileSync(join(ctx.tmp, 'hostile', 'case', ...EXPECT['HX-005'].file.split('/'))).length;
	return { pass: aOk && bOk && cOk && dOk && eOk && fOk, evidence: { summary: { S13a: aOk, S13b: bOk, S13c: cOk, S13d: dOk, S13e: eOk, control: fOk }, hx005Bytes: rawCtx, originalsHost: ORIGINALS_HOSTNAME } };
}
