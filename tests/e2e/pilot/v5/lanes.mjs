// The ten real-v5 lanes and the extra check groups (registry, dates, source routes, page provenance, shared
// contracts, isolation). Each body gets the run context `C` and a Lane; expectations are read at run time from the
// local fixture (inventory, v5 summary, expected examples) and from the package the app imported, never hard-coded.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { documentRoute } from '../../../../src/lib/case-package/browser.ts';
import { writePackageDir } from '../../../../src/lib/case-package/writer.ts';
import { viewHeading } from '../../../../src/lib/views/analysis/headings.ts';
import { editPackage } from '../../../case-package/fixtures/build.ts';
import { frameEvaluator } from '../lib/cdp.mjs';
import { vpath } from '../lib/client.mjs';
import { expectedSlot, filledSlots, firstUnimplemented, implementedViews, modeSummary, observedSlot, registryOf, slotsFromHtml } from '../lib/implemented.mjs';
import { attrById, decode, nextDownload, originalsGet, pageTargets, pathOf, popup } from './browser.mjs';
import { digestFile, listeners, REPO, treeStamp } from './env.mjs';
import { convert, examplesOfKind, expectOf, readPackage } from './fixture.mjs';

const enc = encodeURIComponent;
const ready = (v) => `document.querySelector('main[data-ready=${JSON.stringify(v)}]') !== null`;
const countBy = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
/** Independent statement of the title contract (BA-16): '<document> · <section> · <case> · ClearCase'. */
const clip = (s, n) => { const c = [...s.replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n - 1).join('') + '…' : c.join(''); };
export const expectedTitle = ({ section, caseName, document = null, status = null }) => [document ? clip(document, 80) : null, status ? `${section} (${status})` : section, caseName ? clip(caseName, 60) : null, 'ClearCase'].filter(Boolean).join(' · ');
/** Independent statement of the citation route contract: /v/<encoded rv>/doc/<encoded ref>[?page=N]. */
const citeRoute = (rv, ref, page = null) => `/v/${enc(rv)}/doc/${enc(ref)}${page ? `?page=${page}` : ''}`;
const docTitle = (row) => row.subject || row.filename;
const diagCounts = (html) => Object.fromEntries([...html.matchAll(/<tr><td><a href="#code-([A-Z0-9_]+)">[A-Z0-9_]+<\/a><\/td><td>[a-z]+<\/td><td class="num">(\d+)<\/td>/g)].map((m) => [m[1], Number(m[2])]));
const hidden = (html, name) => [...html.matchAll(new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`, 'g'))].map((m) => decode(m[1]));

/** The doc page of `ref` in version `rv`, parsed for the original-open contract. */
async function docPage(C, rv, ref, query = '') {
	const r = await C.c.get(`${citeRoute(rv, ref)}${query}`);
	const t = r.text;
	// the section may carry more classes after `original` (`original card` since the design system, ae27bf2)
	const section = /<section class="original(?: [^"]*)?"[^>]*data-original-state="([a-z]+)" data-presentation="([a-z]+)"/.exec(t);
	return {
		status: r.status, html: t, state: section?.[1] ?? null, presentation: section?.[2] ?? null,
		route: /<p[^>]*id="original-state"[^>]*><span class="route" data-route="([a-z]+)">([^<]*)</.exec(t)?.slice(1) ?? null,
		path: (() => { const m = /id="original-state"[\s\S]*?<code class="wrap" title="([^"]*)"/.exec(t); return m ? decode(m[1]) : null; })(),
		shaPrefix: /sha256 ([0-9a-f]{12})…\)/.exec(t)?.[1] ?? null,
		open: attrById(t, 'open-original', 'href'), openText: /id="open-original">([^<]*)</.exec(t)?.[1] ?? null, download: attrById(t, 'download-original', 'href'),
		title: decode(/<title>([^<]*)<\/title>/.exec(t)?.[1] ?? ''),
	};
}

/**
 * The active version's overview, reached the way the app leads there: the root lands on the case list since be66e49
 * (GRS-70 demo; it used to redirect to the active overview), whose Open goes to the active version's overview. The root
 * is requested here, with the case active, because the callers no longer navigate through it.
 */
async function activeOverview(C, L) {
	const root = await C.c.get('/');
	L.check('with the case active, the root still redirects to the case list (307 to /cases)', { status: 307, location: '/cases' }, { status: root.status, location: root.location });
	const home = await C.c.home();
	L.check('the case list (where the root lands) opens the active version\'s overview', `${vpath(C.fx.accepted.resultsVersion)}/overview`, home);
	return `${C.origin}${home}`;
}

// ---- lane 2: import and preview without activation ---------------------------------------------------------------
export async function lane2(C, L) {
	const { fx, pkgRun } = C;
	L.cmd(pkgRun.command);
	L.need('GRS-10 conversion of the main HTML exits 0', 0, pkgRun.exit);
	const conv = pkgRun.report;
	L.check('conversion verdict', 'report', conv?.verdict);
	L.check('conversion resultsVersion equals the accepted identity (GRS-38\'s with view-content, else GRS-10\'s)', fx.accepted.resultsVersion, conv?.resultsVersion);
	L.check('conversion diagnosticsSha256 equals GRS-10\'s accepted identity', fx.accepted.diagnosticsSha256, conv?.diagnosticsSha256);
	L.note(`conversion counts: ${JSON.stringify(conv.counts)}`);
	const P = C.P;
	L.cmd(`browser: ${C.origin}/import, type the case folder and package paths, click #validate`);
	await P.goto(`${C.origin}/import`, ready('import'));
	await P.type('#caseFolder', fx.caseFolder);
	await P.type('#packageSource', C.pkgDir);
	const t0 = performance.now();
	await P.click('#validate');
	await P.waitFor(`/^\\/import\\/\\d+$/.test(location.pathname) && document.querySelector('main[data-ready^="import:"]') !== null`, 300000);
	const importId = Number(await P.evaluate('location.pathname.split("/").pop()'));
	L.note(`import #${importId} reported after ${Math.round(performance.now() - t0)} ms`);
	C.S.importId = importId;
	await P.shot(L.file(join(C.out, 'lane-02-report.png')));
	const domVerdict = await P.evaluate(`document.querySelector('main').dataset.verdict`);
	L.check('validation report page: verdict (main[data-verdict])', 'report', domVerdict);
	L.check('validation report page title (BA-16)', expectedTitle({ section: `Validation report #${importId}`, caseName: C.caseName, status: 'report' }), await P.evaluate('document.title'));
	L.cmd(`GET /import/${importId}`);
	const rep = await C.c.report(importId);
	L.check('report shows the results version', fx.accepted.resultsVersion, rep.resultsVersion);
	L.check('report diagnosticsSha256 (activation form) equals GRS-10\'s accepted identity', [fx.accepted.diagnosticsSha256], hidden(rep.html, 'diagnosticsSha256'));
	L.check('report manifestSha256 equals the conversion\'s', [conv.manifestSha256], hidden(rep.html, 'manifestSha256'));
	L.check('report validatorVersion equals the conversion\'s', [conv.validatorVersion], hidden(rep.html, 'validatorVersion'));
	const counts = diagCounts(rep.html);
	L.check('report diagnostic counts per code equal the conversion report\'s (e.g. CITE_UNRESOLVED)', sortObj(conv.counts), sortObj(counts));
	L.check('every warning fingerprint is new on a first import (empty trusted baseline) and listed for acknowledgement', conv.warningFingerprints.length, hidden(rep.html, 'fp').length);
	L.check('acknowledgement checkbox offered', true, rep.needsAck);
	L.check('candidate state on the report', 'not active', /id="active-state">([^<]+)</.exec(rep.html)?.[1]);
	L.check('stored copy verifies', 'verified', rep.verify);
	const root = await C.c.get('/');
	L.cmd('GET /');
	L.check('the root redirects to the case list, and nothing is active there (307 to /cases, no active version)', { status: 307, location: '/cases', active: null }, { status: root.status, location: root.location, active: await C.c.activeVersion() });
	L.cmd('browser: click #preview');
	await P.click('#preview');
	await P.waitFor(`location.pathname === ${JSON.stringify(`${vpath(fx.accepted.resultsVersion)}/overview`)} && ${ready('overview')}`, 60000);
	const banner = await P.evaluate(`(() => { const c = document.getElementById('candidate-banner'); return { candidate: !!c && c.offsetHeight > 0 && c.textContent.includes('CANDIDATE PREVIEW'), active: !!document.getElementById('active-banner') }; })()`);
	L.check('preview shows the visible candidate banner and no active banner', { candidate: true, active: false }, banner);
	L.check('preview overview counts the documents', fx.summary.mainHtml.docCount, Number(await P.evaluate(`document.getElementById('count-documents').dataset.count`)));
	await P.shot(L.file(join(C.out, 'lane-02.png')));
	const after = await C.c.get('/');
	// the root lands on the case list since be66e49 (GRS-70 demo); the candidate is not active there, so the case's
	// Open still leads to its validation report, not to a version
	L.check('after previewing, the root still redirects to the case list, whose Open leads to the report, not the candidate', { status: 307, location: '/cases', open: `/import/${importId}` }, { status: after.status, location: after.location, open: await C.c.home() });
	const h = await C.c.health();
	L.check('health: no recovery, no storage error', { recovery: null, storageError: null }, { recovery: h.recovery, storageError: h.storageError });
}

// ---- lane 3: activate and see exactly 1,689 base records ---------------------------------------------------------
export async function lane3(C, L) {
	const { fx } = C;
	const id = L.need('lane 2 produced an import', true, Number.isInteger(C.S.importId), Number.isInteger(C.S.importId)) && C.S.importId;
	const rv = fx.accepted.resultsVersion;
	const expected = fx.summary.mainHtml.docCount;
	L.check('reference document count agrees: v5-summary, profile and inventory', [expected, expected], [fx.profile.mainHtml.docCount, fx.inventory.refs.length]);
	L.cmd(`POST /import/${id}?/activate without the acknowledgement`);
	const refused = await C.c.activate(id, { ack: false });
	L.check('activation without acknowledging the new warnings is refused (409, ACK_REQUIRED)', { status: 409, ack: true }, { status: refused.status, ack: refused.reasons.includes('ACK_REQUIRED') });
	L.check('still nothing active after the refusal', null, await C.c.activeVersion());
	const P = C.P;
	L.cmd(`browser: /import/${id}, tick #ack, click #activate`);
	await P.goto(`${C.origin}/import/${id}`, ready(`import:${id}`));
	L.need('acknowledgement checkbox present', true, await P.click('#ack'));
	L.check('acknowledgement ticked', true, await P.evaluate(`document.getElementById('ack').checked`));
	const t0 = performance.now();
	await P.click('#activate');
	await P.waitFor(`location.pathname === ${JSON.stringify(`${vpath(rv)}/overview`)} && ${ready('overview')}`, 300000);
	L.note(`activation redirect to the overview after ${Math.round(performance.now() - t0)} ms`);
	const ov = await P.evaluate(`({ active: !!document.getElementById('active-banner'), candidate: !!document.getElementById('candidate-banner'), count: Number(document.getElementById('count-documents').dataset.count), text: document.getElementById('count-documents').textContent.trim() })`);
	L.check('overview: active banner, no candidate banner', { active: true, candidate: false }, { active: ov.active, candidate: ov.candidate });
	L.check('overview shows exactly the reference count of base records', { count: expected, text: expected.toLocaleString('en') }, { count: ov.count, text: ov.text });
	await P.shot(L.file(join(C.out, 'lane-03.png')));
	L.cmd('GET /cases');
	L.check('the case list now opens the active version\'s overview', `${vpath(rv)}/overview`, await C.c.home());
	L.cmd(`browser: ${vpath(rv)}/chronology`);
	await P.goto(`${C.origin}${vpath(rv)}/chronology`, ready('chronology'), 60000);
	const ch = await P.settled(`({ count: Number(document.getElementById('row-count').dataset.count), text: document.getElementById('row-count').textContent.trim(), rows: document.querySelectorAll('.grid-table .grid-row[data-ref]').length })`);
	L.check('chronology row count and rendered rows', { count: expected, rows: expected, text: `${expected.toLocaleString('en')} of ${expected.toLocaleString('en')} documents` }, ch);
	await P.shot(L.file(join(C.out, 'lane-03-chronology.png')));
	C.S.activated = true;
}

// ---- lane 1: the complete import-to-document workflow against the reference ------------------------------------
export async function lane1(C, L) {
	const { fx, pkg } = C;
	const rv = fx.accepted.resultsVersion;
	L.note('workflow: import (lane 2) -> validation report (lane 2) -> candidate preview (lane 2) -> activation (lane 3) -> overview -> chronology -> document -> original, checked here against GRS-9\'s inventory and summary');
	L.need('lanes 2 and 3 imported and activated the v5 package', true, !!(C.S.importId && C.S.activated));
	const inv = fx.inventory.refs;
	const P = C.P;
	L.cmd(`browser: ${vpath(rv)}/overview`);
	await P.goto(`${C.origin}${vpath(rv)}/overview`, ready('overview'));
	const tables = await P.evaluate(`Object.fromEntries([...document.querySelectorAll('section.card')].filter((s) => /^By /.test(s.querySelector('h2')?.textContent ?? '')).map((s) => [s.querySelector('h2').textContent, Object.fromEntries([...s.querySelectorAll('tr')].map((tr) => [tr.cells[0].textContent === '(empty)' ? '' : tr.cells[0].textContent, Number(tr.cells[1].textContent)]))]))`);
	L.check('overview "By bundle" equals the inventory\'s per-bundle counts', sortObj(countBy(inv, (r) => r.bundle)), sortObj(tables['By bundle'] ?? {}));
	L.check('overview "By type" equals the inventory\'s per-type counts', sortObj(countBy(inv, (r) => r.docType)), sortObj(tables['By type'] ?? {}));
	L.check('overview "By text status" equals the inventory\'s per-status counts', sortObj(countBy(inv, (r) => r.textStatus)), sortObj(tables['By text status'] ?? {}));
	L.check('overview originals: verified count equals the inventory\'s resolved links, missing 0', { verified: inv.filter((r) => r.status === 'ok').length, missing: fx.inventory.missing.length }, await P.evaluate(`({ verified: Number(document.getElementById('count-verified').textContent), missing: Number(document.getElementById('count-missing').textContent) })`));
	L.cmd(`GET /api/v/${enc(rv)}/chronology`);
	const api = JSON.parse((await C.c.get(`/api/v/${enc(rv)}/chronology`)).text);
	L.check('chronology list: length equals the v5 summary\'s chronologyRows', fx.summary.mainHtml.chronologyRows, api.length);
	L.check('chronology list: refs in source order equal the package register order', pkg.chronology.map((r) => r.ref), [...api].sort((a, b) => a.ord - b.ord).map((r) => r.ref));
	L.check('chronology list: the set of refs equals the inventory\'s', [...new Set(inv.map((r) => r.ref))].sort(), api.map((r) => r.ref).sort());
	// sample: every k-th inventory ref, the non-ASCII names and the citation examples
	const k = Math.floor(inv.length / 20);
	const nonAscii = new Set(fx.inventory.names?.nonAscii ?? []);
	const cites = examplesOfKind(fx, 'citation').map((e) => expectOf(e)).filter((e) => e?.ref);
	const sample = [...new Set([...inv.filter((_, i) => i % k === 0).map((r) => r.ref), ...inv.filter((r) => nonAscii.has(r.path)).map((r) => r.ref), ...cites.map((e) => e.ref)])];
	L.note(`sample of ${sample.length} refs: every ${k}th inventory ref, ${nonAscii.size} non-ASCII names, ${cites.length} citation examples`);
	const byRef = new Map(inv.map((r) => [r.ref, r]));
	let agree = 0;
	for (const ref of sample) {
		const r = byRef.get(ref);
		const d = await docPage(C, rv, ref);
		const disk = await digestFile(join(fx.caseFolder, ...r.path.split('/')));
		const served = d.download ? await originalsGet(C.orig, pathOf(d.download)) : null;
		const want = { page: 200, state: 'present', route: 'direct', path: r.path, status: 200, size: r.size, crc32: r.crc32, sha256: disk.sha256, assetSha256: disk.sha256, shaPrefix: disk.sha256.slice(0, 12) };
		const got = { page: d.status, state: d.state, route: d.route?.[0] ?? null, path: d.path, status: served?.status ?? null, size: served?.size ?? null, crc32: served?.crc32 ?? null, sha256: served?.sha256 ?? null, assetSha256: pkg.assets[ref]?.sha256 ?? null, shaPrefix: d.shaPrefix };
		if (L.check(`${ref}: inventory path/size/CRC-32 and the file's sha256 equal what the app shows and serves`, want, got)) agree++;
	}
	for (const e of cites) {
		const d = await docPage(C, rv, e.ref);
		const served = await originalsGet(C.orig, pathOf(d.download));
		L.check(`citation example ${e.ref}: served original equals the expected path, size and sha256`, { path: e.path, size: e.size, sha256: e.sha256 }, { path: d.path, size: served.size, sha256: served.sha256 });
	}
	L.note(`${agree}/${sample.length} sampled refs agree`);
	// the browser leg: overview -> chronology -> document -> original
	const ref = sample[1] ?? sample[0];
	L.cmd(`browser: overview -> click #nav-chronology -> type ${ref} into #f-q -> click its row link -> document -> download link`);
	await P.click('#nav-chronology');
	await P.waitFor(ready('chronology'));
	await P.type('#f-q', ref);
	const link = await P.settled(`document.querySelector('.grid-row[data-ref=${JSON.stringify(ref)}] a')?.getAttribute('href') ?? null`);
	L.check('the row link is the citation route of the document', citeRoute(rv, ref), link);
	await P.click(`.grid-row[data-ref=${JSON.stringify(ref)}] a`);
	await P.waitFor(ready(`doc:${ref}`));
	const shown = await P.evaluate(`({ path: document.querySelector('#original-state code')?.title ?? null, route: document.querySelector('#original-state .route')?.dataset.route ?? null })`);
	L.check('document page names the inventory path as a direct original', { path: byRef.get(ref).path, route: 'direct' }, shown);
	await P.shot(L.file(join(C.out, 'lane-01.png')));
}

// ---- lane 4: sort and filter with the literal expected rows -----------------------------------------------------
export async function lane4(C, L) {
	const { fx } = C;
	const rv = fx.accepted.resultsVersion;
	const exs = examplesOfKind(fx, 'chronology-filter');
	L.need('the expected-examples file has the four chronology examples', 4, exs.length);
	const P = C.P;
	const base = `${C.origin}${vpath(rv)}/chronology`;
	const read = `({ refs: [...document.querySelectorAll('.grid-table .grid-row[data-ref]')].map((e) => e.dataset.ref), count: Number(document.getElementById('row-count').dataset.count), search: location.search, options: [...document.querySelectorAll('#f-bundle option')].map((o) => o.value) })`;
	const summary = (x) => ({ count: x.count, rendered: x.refs.length, firstRefs: x.refs.slice(0, 3), lastRef: x.refs.at(-1) ?? null });
	for (const ex of exs) {
		const f = ex.input.filter;
		const want = expectOf(ex);
		L.note(`example ${ex.key}: ${ex.describe}${ex.expect.rewrite ? ' (rewrite expectation)' : ''}`);
		L.cmd(`browser: ${base} then the filter controls: ${JSON.stringify(f)}`);
		await P.goto(base, ready('chronology'), 60000);
		if (f.bundle !== undefined) L.check(`${ex.key}: bundle select accepts ${f.bundle}`, 'ok', await P.select('#f-bundle', f.bundle));
		if (f.doc_type !== undefined) L.check(`${ex.key}: type select accepts ${f.doc_type}`, 'ok', await P.select('#f-type', f.doc_type));
		if (f.status !== undefined) L.check(`${ex.key}: text status select accepts ${f.status}`, 'ok', await P.select('#f-status', f.status));
		if (f.q !== undefined) L.check(`${ex.key}: text filter typed`, true, await P.type('#f-q', f.q));
		if (f.sort) {
			L.check(`${ex.key}: click sort ${f.sort}`, true, await P.click(`#sort-${f.sort}`));
			if (f.direction === -1) { await P.settled('1'); L.check(`${ex.key}: click sort ${f.sort} again (descending)`, true, await P.click(`#sort-${f.sort}`)); }
			L.check(`${ex.key}: aria-sort of the sorted column`, f.direction === -1 ? 'descending' : 'ascending', await P.settled(`document.querySelector('#sort-${f.sort}').parentElement.getAttribute('aria-sort')`));
		}
		const viaControls = await P.settled(read);
		const exp = { count: want.count, rendered: want.count, firstRefs: want.firstRefs.slice(0, ex.input.first ?? 3), lastRef: want.lastRef };
		L.check(`${ex.key} via the controls: count, first refs and last ref`, exp, summary(viaControls));
		if ('bundleOptionOffered' in want) L.check(`${ex.key}: the bundle select offers ${ex.input.bundleOption}`, want.bundleOptionOffered, viaControls.options.includes(ex.input.bundleOption));
		const params = new URLSearchParams();
		if (f.q) params.set('q', f.q);
		if (f.bundle) params.set('bundle', f.bundle);
		if (f.doc_type) params.set('type', f.doc_type);
		if (f.status) params.set('status', f.status);
		if (f.sort && f.sort !== 'date') params.set('sort', f.sort);
		if (f.direction === -1) params.set('dir', 'desc');
		const got = Object.fromEntries(new URLSearchParams(viaControls.search));
		L.check(`${ex.key}: the controls wrote the filter into the URL (replaceState)`, sortObj(Object.fromEntries(params)), sortObj(got));
		L.cmd(`browser: ${base}?${params}`);
		await P.goto(`${base}?${params}`, ready('chronology'), 60000);
		L.check(`${ex.key} via URL params: count, first refs and last ref`, exp, summary(await P.settled(read)));
	}
	await P.shot(L.file(join(C.out, 'lane-04.png')));
}

// ---- lane 5: open a cited PDF ------------------------------------------------------------------------------------
export async function lane5(C, L) {
	const { fx, pkg, b } = C;
	const rv = fx.accepted.resultsVersion;
	const tokens = Object.fromEntries(['matter', 'timeline-events', 'defence-matrix', 'bundles'].map((k) => [k, (JSON.stringify(pkg.dataset(k).data).match(/\[\[[^\]\n]{0,80}\]\]/g) ?? []).length]));
	const story = pkg.dataset('matter').data.storyline?.[0]?.t ?? '';
	L.note(`authored citation tokens [[REF]] in datasets: ${JSON.stringify(tokens)}; in the overview paragraph the pilot renders: ${(story.match(/\[\[[^\]\n]{0,80}\]\]/g) ?? []).length}; chronology rows with related refs: ${pkg.chronology.filter((r) => Array.isArray(r.refs) && r.refs.length).length}`);
	L.note('so the real v5 data gives the pilot no rendered narrative or related-ref citation; the cited PDF is reached through its chronology citation link (the same documentRoute contract), using GRS-9\'s citation example');
	const ex = examplesOfKind(fx, 'citation').map((e) => ({ key: e.key, field: e.input.field, ...expectOf(e) })).find((e) => /\.pdf$/i.test(e.path ?? ''));
	L.need('a citation example whose original is a PDF', true, !!ex);
	const events = pkg.dataset('timeline-events').data;
	L.check(`${ex.key}: the package carries the citation (${ex.field})`, ex.ref, events[0]?.ref);
	const P = C.P;
	L.cmd(`browser: chronology, type ${ex.ref} into #f-q, click the row's citation link, click #open-original`);
	await P.goto(`${C.origin}${vpath(rv)}/chronology`, ready('chronology'), 60000);
	await P.type('#f-q', ex.ref);
	L.check('citation link href is the document route', citeRoute(rv, ex.ref), await P.settled(`document.querySelector('.grid-row[data-ref=${JSON.stringify(ex.ref)}] a')?.getAttribute('href') ?? null`));
	await P.click(`.grid-row[data-ref=${JSON.stringify(ex.ref)}] a`);
	await P.waitFor(ready(`doc:${ex.ref}`));
	const dp = await P.evaluate(`({ presentation: document.querySelector('section.original').dataset.presentation, open: document.getElementById('open-original')?.getAttribute('href') ?? null, target: document.getElementById('open-original')?.target ?? null, rel: document.getElementById('open-original')?.rel ?? null })`);
	L.check('document offers the isolated viewer, in a new browsing context without opener or referrer', { presentation: 'viewer', target: '_blank', rel: 'noopener noreferrer', viewerUrl: true }, { presentation: dp.presentation, target: dp.target, rel: dp.rel, viewerUrl: String(dp.open).startsWith(`${C.orig}/view/${rv}/${ex.ref}?k=`) });
	const before = pageTargets(b);
	await P.click('#open-original');
	const pop = await popup(b, before, `${C.orig}/view/`);
	const st = await pop.waitFor(`document.body.dataset.ready === '1' || document.body.dataset.ready === 'error' ? document.body.dataset.ready : null`, 60000);
	L.check('the viewer wrapper reports its first rendered page (body[data-ready=1])', '1', st);
	const w = await pop.evaluate(`({ readyMs: Number(document.body.dataset.readyMs), src: document.body.dataset.src, sandbox: document.getElementById('viewer').getAttribute('sandbox'), opener: window.opener === null })`);
	L.note(`first rendered page ${w.readyMs} ms after the viewer's navigation start`);
	L.check('pdf.js frame is sandboxed with allow-scripts only; the popup has no opener', { sandbox: 'allow-scripts', opener: true }, { sandbox: w.sandbox, opener: w.opener });
	await pop.shot(L.file(join(C.out, 'lane-05.png')));
	const served = await originalsGet(C.orig, w.src);
	L.cmd(`GET ${C.orig}${w.src.replace(/k=[^&]+/, 'k=…')} (the bytes the viewer fetched)`);
	L.check('served PDF bytes: 200, attachment disposition (raw PDF never inline), sha256 equals the asset index and the example', { status: 200, attachment: true, sha256: pkg.assets[ex.ref].sha256, size: pkg.assets[ex.ref].size, expected: ex.sha256 }, { status: served.status, attachment: /^attachment/.test(served.headers['content-disposition'] ?? ''), sha256: served.sha256, size: served.size, expected: served.sha256 });
	await pop.close();
	C.S.citedPdf = ex.ref;
}

// ---- lane 6: open or download a non-PDF original -------------------------------------------------------------------
export async function lane6(C, L) {
	const { fx, pkg, b } = C;
	const rv = fx.accepted.resultsVersion;
	const P = C.P;
	const first = (mt) => pkg.chronology.find((r) => pkg.assets[r.ref]?.kind === 'file' && pkg.assets[r.ref].mediaType === mt)?.ref;
	const eml = first('message/rfc822');
	L.need('the v5 register has an e-mail original', true, !!eml);
	const d = await docPage(C, rv, eml);
	L.check(`${eml}: e-mail offered as text`, { state: 'present', presentation: 'text' }, { state: d.state, presentation: d.presentation });
	L.cmd(`browser: ${citeRoute(rv, eml)}, click #open-original`);
	await P.goto(`${C.origin}${citeRoute(rv, eml)}`, ready(`doc:${eml}`));
	const before = pageTargets(b);
	await P.click('#open-original');
	const pop = await popup(b, before, `${C.orig}/o/`);
	await pop.waitFor(`document.readyState === 'complete'`);
	const shown = await pop.evaluate(`({ contentType: document.contentType, scripts: document.scripts.length, opener: window.opener === null })`);
	L.check('the e-mail opens on the originals site as text/plain, with no scripts and no opener', { contentType: 'text/plain', scripts: 0, opener: true }, shown);
	await pop.shot(L.file(join(C.out, 'lane-06.png')));
	await pop.close();
	const r = await originalsGet(C.orig, pathOf(d.open));
	L.check(`${eml}: response headers and bytes`, { status: 200, type: true, sandbox: true, inline: true, nosniff: 'nosniff', sha256: pkg.assets[eml].sha256 }, { status: r.status, type: /^text\/plain/.test(r.headers['content-type'] ?? ''), sandbox: /(^|;)\s*sandbox/.test(r.headers['content-security-policy'] ?? ''), inline: !/^attachment/.test(r.headers['content-disposition'] ?? ''), nosniff: r.headers['x-content-type-options'], sha256: r.sha256 });
	let any = 0;
	for (const mt of ['application/vnd.ms-outlook', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) {
		const ref = first(mt);
		if (!ref) { L.note(`no original of type ${mt} in this register`); continue; }
		any++;
		const dd = await docPage(C, rv, ref);
		L.check(`${ref} (${mt}): download only, no Open link`, { presentation: 'download', open: null, download: true }, { presentation: dd.presentation, open: dd.open, download: !!dd.download });
		L.cmd(`browser: ${citeRoute(rv, ref)}, click #download-original`);
		await P.goto(`${C.origin}${citeRoute(rv, ref)}`, ready(`doc:${ref}`));
		const dl = nextDownload(b, (u) => u.includes(`/${ref}/`));
		const t0 = performance.now();
		await P.click('#download-original');
		const ev = await dl.catch((e) => ({ error: String(e) }));
		if (ev.guid) await b.send('Browser.cancelDownload', { guid: ev.guid }).catch(() => {});
		L.check(`${ref}: the click starts a download (Browser.downloadWillBegin)`, true, !!ev.guid);
		if (ev.guid) L.note(`download began ${Math.round(ev.at - t0)} ms after the click; suggested filename ${ev.suggestedFilename}`);
		if (any === 1) await P.shot(L.file(join(C.out, 'lane-06-download.png')));
		const h = await originalsGet(C.orig, pathOf(dd.download));
		L.check(`${ref}: octet-stream attachment headers and the asset's bytes`, { status: 200, type: 'application/octet-stream', attachment: true, sha256: pkg.assets[ref].sha256 }, { status: h.status, type: (h.headers['content-type'] ?? '').split(';')[0], attachment: /^attachment/.test(h.headers['content-disposition'] ?? ''), sha256: h.sha256 });
	}
	L.check('at least one non-inline type was exercised', true, any > 0);
}

// ---- lane 9: keyboard navigation and Back ----------------------------------------------------------------------------
export async function lane9(C, L) {
	const { fx, b } = C;
	const rv = fx.accepted.resultsVersion;
	const { openPage } = await import('./browser.mjs');
	const P = await openPage(b, { fresh: true });
	try {
		L.cmd(`browser (fresh context): the active overview, where the case list's Open goes`);
		await P.goto(await activeOverview(C, L), ready('overview'));
		const focus = `(() => { const e = document.activeElement; return e ? { tag: e.tagName.toLowerCase(), id: e.id || null, cls: e.className || null, heading: e.hasAttribute('data-page-heading'), text: (e.textContent || '').trim().slice(0, 60) } : null; })()`;
		await P.key('Tab');
		L.check('first Tab focuses the skip link', { tag: 'a', cls: 'skip' }, (({ tag, cls }) => ({ tag, cls }))(await P.evaluate(focus)));
		let tabs = 0;
		for (; tabs < 80; tabs++) { await P.key('Tab'); if ((await P.evaluate('document.activeElement?.id')) === 'nav-chronology') break; }
		L.check('Tab reaches the Chronology navigation link', 'nav-chronology', await P.evaluate('document.activeElement?.id'));
		L.note(`${tabs + 1} more Tab presses from the skip link to the Chronology link`);
		await P.key('Enter');
		await P.waitFor(`location.pathname.endsWith('/chronology') && ${ready('chronology')}`, 60000);
		const f1 = await P.waitFor(`document.activeElement?.hasAttribute('data-page-heading') ? document.activeElement.textContent.trim() : null`, 5000).catch(() => null);
		L.check('after Enter: chronology, focus on its page heading', 'Chronology', f1);
		L.check('chronology title', expectedTitle({ section: 'Chronology', caseName: C.titleName }), await P.evaluate('document.title'));
		let t2 = 0;
		for (; t2 < 80; t2++) { await P.key('Tab'); if (await P.evaluate(`!!document.activeElement?.closest?.('.grid-table .grid-row[data-ref]') && document.activeElement.tagName === 'A'`)) break; }
		const ref = await P.evaluate(`document.activeElement?.closest?.('.grid-row[data-ref]')?.dataset.ref ?? null`);
		const firstSorted = C.pkg.chronology.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.i - b.i))[0].r.ref;
		L.check('Tab reaches the first document link of the chronology (default sort: date ascending, stable)', firstSorted, ref);
		L.note(`${t2 + 1} Tab presses from the heading to the first document link (${ref})`);
		await P.key('Enter');
		await P.waitFor(ready(`doc:${ref}`), 60000);
		const row = C.pkg.chronology.find((r) => r.ref === ref);
		const f2 = await P.waitFor(`document.activeElement?.hasAttribute('data-page-heading') ? document.activeElement.textContent.trim() : null`, 5000).catch(() => null);
		L.check('after Enter: the document, focus on its heading', `${ref} ${docTitle(row)}`.trim(), f2);
		L.check('document title names document, section and case', expectedTitle({ section: 'Document', caseName: C.titleName, document: `${ref} ${docTitle(row)}` }), await P.evaluate('document.title'));
		await P.shot(L.file(join(C.out, 'lane-09.png')));
		const hist = await P.s('Page.getNavigationHistory');
		const paths = hist.entries.slice(0, hist.currentIndex + 1).map((e) => { try { return new URL(e.url).pathname; } catch { return e.url; } });
		L.check('history entries: overview, chronology and the document are separate entries (BA-16)', [`${vpath(rv)}/overview`, `${vpath(rv)}/chronology`, citeRoute(rv, ref)], [...new Set(paths)].slice(-3));
		L.cmd('browser Back (Page.navigateToHistoryEntry to the previous entry)');
		await P.back();
		await P.waitFor(`location.pathname.endsWith('/chronology') && ${ready('chronology')}`, 60000);
		L.check('Back 1: chronology, focus on its heading', 'Chronology', await P.waitFor(`document.activeElement?.hasAttribute('data-page-heading') ? document.activeElement.textContent.trim() : null`, 5000).catch(() => null));
		L.check('Back 1: chronology title', expectedTitle({ section: 'Chronology', caseName: C.titleName }), await P.evaluate('document.title'));
		L.cmd('browser Back');
		await P.back();
		await P.waitFor(`location.pathname.endsWith('/overview') && ${ready('overview')}`, 60000);
		L.check('Back 2: overview, focus on its heading', 'Overview', await P.waitFor(`document.activeElement?.hasAttribute('data-page-heading') ? document.activeElement.textContent.trim() : null`, 5000).catch(() => null));
		L.check('Back 2: overview title', expectedTitle({ section: 'Overview', caseName: C.titleName }), await P.evaluate('document.title'));
	} finally { await P.close(); }
	const Q = await openPage(b, { fresh: true });
	try {
		L.cmd('browser (fresh context): overview, Tab to the skip link, Enter');
		await Q.goto(await activeOverview(C, L), ready('overview'));
		const h0 = await Q.evaluate('history.length');
		await Q.key('Tab');
		await Q.key('Enter');
		L.check('Enter on the skip link moves focus to the main content without a history entry', { id: 'main', hash: '', added: 0 }, await Q.settled(`({ id: document.activeElement?.id ?? null, hash: location.hash, added: history.length - ${h0} })`));
		await Q.click('#nav-chronology');
		await Q.waitFor(ready('chronology'));
		await Q.back();
		await Q.waitFor(`location.pathname.endsWith('/overview') && ${ready('overview')}`, 60000);
		await new Promise((r) => setTimeout(r, 300));
		const f = await Q.evaluate(`({ id: document.activeElement?.id ?? null, heading: !!document.activeElement?.hasAttribute('data-page-heading'), hash: location.hash })`);
		L.check('Back to the overview after using the skip link: focus on its heading', { heading: true, hash: '' }, { heading: f.heading, hash: f.hash });
	} finally { await Q.close(); }
}

// ---- lane 7: missing original (negative control) ---------------------------------------------------------------
export async function lane7(C, L) {
	const { fx, pkg } = C;
	const copy = join(C.work, 'case-missing');
	rmSync(copy, { recursive: true, force: true });
	// the copy takes default modes (--no-preserve=mode), so it is writable when the case folder is read-only (files
	// 0444, folders 0555); the source keeps its own (as verify:package lane 09 copies it)
	L.cmd(`cp -a --reflink=always --no-preserve=mode ${fx.caseFolder} ${copy}`);
	const cp = spawnSync('cp', ['-a', '--reflink=always', '--no-preserve=mode', fx.caseFolder, copy], { encoding: 'utf8' });
	L.need('disposable reflink copy of the case folder (the filesystem must support reflinks; no full copy)', 0, cp.status);
	C.cleanup.push(copy);
	const pathCount = countBy(Object.values(pkg.assets).filter((a) => a.kind === 'file'), (a) => a.path);
	const cited = new Set(examplesOfKind(fx, 'citation').map((e) => expectOf(e)?.ref));
	const target = pkg.chronology.find((r) => { const a = pkg.assets[r.ref]; return a?.kind === 'file' && a.mediaType === 'application/pdf' && a.size < 2e6 && pathCount[a.path] === 1 && !cited.has(r.ref) && r.ref !== C.S.citedPdf; });
	L.need('a PDF original to remove', true, !!target);
	const rel = pkg.assets[target.ref].path;
	L.cmd(`rm <copy>/<original of ${target.ref}>`);
	rmSync(join(copy, ...rel.split('/')));
	L.check('removed only in the copy; the canonical fixture still has it', { copy: false, canonical: true }, { copy: existsSync(join(copy, ...rel.split('/'))), canonical: existsSync(join(fx.caseFolder, ...rel.split('/'))) });
	const caseId = `${fx.caseId}-missing-control`;
	const out = join(C.work, 'pkg-missing');
	const conv = convert({ html: fx.cfg.mainHtml.path, caseFolder: copy, caseId, out, report: `${out}.convert-report.json` });
	L.cmd(conv.command);
	L.need('conversion of the control exits 0 (a missing original is a warning)', 0, conv.exit);
	const missCodes = Object.keys(conv.report.counts).filter((k) => /MISSING/.test(k));
	L.check('control conversion reports the missing original', true, missCodes.length > 0);
	L.note(`control counts: ${JSON.stringify(conv.report.counts)}`);
	L.cmd(`POST /import?/import caseFolder=<copy> packageSource=<control package>`);
	const imp = await C.c.importPkg(copy, out);
	L.need('control import stored as a candidate', true, Number.isInteger(imp.importId));
	const rep = await C.c.report(imp.importId);
	const rv2 = rep.resultsVersion;
	L.check('control: verdict report, its own results version, missing-original code listed', { verdict: 'report', own: true, missing: true }, { verdict: rep.verdict, own: rv2 === conv.report.resultsVersion && rv2 !== fx.accepted.resultsVersion, missing: missCodes.every((k) => k in rep.codes) });
	const d = await docPage(C, rv2, target.ref);
	L.check(`${target.ref} in the control: "Original missing", data-route=unavailable, nothing to open or download`, { state: 'missing', route: ['unavailable', 'Original missing'], open: null, download: null }, { state: d.state, route: d.route, open: d.open, download: d.download });
	const o = await originalsGet(C.orig, `/o/${rv2}/${target.ref}/x`);
	const v = await originalsGet(C.orig, `/view/${rv2}/${target.ref}`);
	L.check('the originals site answers 410 for the missing original (bytes and viewer)', { o: 410, view: 410 }, { o: o.status, view: v.status });
	const same = await originalsGet(C.orig, `/o/${fx.accepted.resultsVersion}/${target.ref}/x`);
	L.check('the same ref in the active v5 version is still served (200, its sha256)', { status: 200, sha256: pkg.assets[target.ref].sha256 }, { status: same.status, sha256: same.sha256 });
	const P = C.P;
	await P.goto(`${C.origin}${citeRoute(rv2, target.ref)}`, ready(`doc:${target.ref}`));
	L.check('browser: the control document shows the missing state under a candidate banner', { missing: true, candidate: true }, await P.evaluate(`({ missing: document.querySelector('#original-state .route')?.dataset.route === 'unavailable' && /Original missing/.test(document.getElementById('original-state').textContent), candidate: !!document.getElementById('candidate-banner') })`));
	await P.shot(L.file(join(C.out, 'lane-07.png')));
	L.check('the active version is unchanged by the control import', fx.accepted.resultsVersion, await C.c.activeVersion());
	C.S.missing = { rv: rv2, ref: target.ref };
}

// ---- lane 8: reject broken candidates while the active version stays usable ------------------------------------
export async function lane8(C, L) {
	const { fx } = C;
	const rv = fx.accepted.resultsVersion;
	const ident = async () => {
		const ch = await C.c.get(`/api/v/${enc(rv)}/chronology`);
		const h = await C.c.health();
		return { active: await C.c.activeVersion(), readModel: ch.headers.etag, chronologyStatus: ch.status, recovery: h.recovery, storageError: h.storageError };
	};
	const before = await ident();
	L.check('before: v5 is active and its read model digest (chronology ETag) is known', { active: rv, chronologyStatus: 200 }, { active: before.active, chronologyStatus: before.chronologyStatus });
	L.note(`read model digest before: ${before.readModel}`);
	const files = new Map();
	const m = JSON.parse(readFileSync(join(C.pkgDir, 'manifest.json'), 'utf8'));
	files.set('manifest.json', readFileSync(join(C.pkgDir, 'manifest.json')));
	for (const f of m.files) files.set(f.path, readFileSync(join(C.pkgDir, ...f.path.split('/'))));
	const trunc = join(C.work, 'pkg-broken-truncated');
	const counted = join(C.work, 'pkg-broken-count');
	rmSync(trunc, { recursive: true, force: true }); rmSync(counted, { recursive: true, force: true });
	await writePackageDir(trunc, files);
	const chron = join(trunc, 'datasets', 'chronology.json');
	L.cmd(`copy of the package; truncate datasets/chronology.json to half (${Math.floor(statSync(chron).size / 2)} bytes)`);
	truncateSync(chron, Math.floor(statSync(chron).size / 2));
	await writePackageDir(counted, editPackage(files, 'datasets/chronology.json', (v) => { v.count += 1; }));
	L.cmd('copy of the package with datasets/chronology.json count + 1, manifest resealed (GRS-10 test helper editPackage)');
	const P = C.P;
	let n = 0;
	for (const [label, dir] of [['truncated dataset', trunc], ['changed count', counted]]) {
		L.cmd(`POST /import?/import caseFolder=<v5 tree> packageSource=<${label} copy>`);
		const imp = await C.c.importPkg(fx.caseFolder, dir);
		const rep = imp.importId ? await C.c.report(imp.importId) : null;
		const errors = Object.entries(rep?.codes ?? {}).filter(([, s]) => s === 'error').map(([k]) => k);
		L.check(`${label}: rejected, no activation form, errors listed`, { verdict: 'reject', canActivate: false, errors: true }, { verdict: rep?.verdict ?? null, canActivate: rep?.canActivate ?? null, errors: errors.length > 0 });
		L.note(`${label}: error codes ${errors.join(', ')}`);
		const msg = decode((/id="verdict-msg"[^>]*>([^<]*)</.exec(rep?.html ?? '')?.[1] ?? '').trim());
		L.check(`${label}: the report says nothing was stored and the active version is unchanged`, true, /nothing of this package was stored and the active version is unchanged/.test(msg));
		L.note(`${label}: rejection message ${msg.includes(rv) ? 'names' : 'does not name'} the active version`);
		const after = await ident();
		L.check(`${label}: active version, read model digest and health unchanged`, before, after);
		if (n++ === 0) { await P.goto(`${C.origin}/import/${imp.importId}`, ready(`import:${imp.importId}`)); await P.shot(L.file(join(C.out, 'lane-08-rejected.png'))); }
	}
	await P.goto(await activeOverview(C, L), ready('overview'));
	L.check('the active v5 version stays usable: overview counts and the active banner', { count: fx.summary.mainHtml.docCount, active: true }, await P.evaluate(`({ count: Number(document.getElementById('count-documents').dataset.count), active: !!document.getElementById('active-banner') })`));
	await P.goto(`${C.origin}${vpath(rv)}/chronology`, ready('chronology'), 60000);
	L.check('and its chronology lists every record', fx.summary.mainHtml.docCount, await P.settled(`document.querySelectorAll('.grid-table .grid-row[data-ref]').length`));
	await P.shot(L.file(join(C.out, 'lane-08.png')));
	C.cleanup.push(trunc, counted);
}

// ---- lane 10: restart offline and recover the active case with user work unchanged -------------------------------
export async function lane10(C, L) {
	const { fx } = C;
	const rv = fx.accepted.resultsVersion;
	const ref = C.S.citedPdf ?? C.pkg.chronology[0].ref;
	const P = C.P;
	const body = `Synthetic lane-10 note ${new Date().toISOString()}`;
	L.cmd(`browser: ${citeRoute(rv, ref)}, type a note into #note-body, click #note-add`);
	await P.goto(`${C.origin}${citeRoute(rv, ref)}`, ready(`doc:${ref}`));
	await P.type('#note-body', body);
	await P.click('#note-add');
	const id = await P.waitFor(`[...document.querySelectorAll('#notes li[data-note]')].find((li) => li.textContent.includes(${JSON.stringify(body)}))?.dataset.note ?? null`, 20000);
	L.check('note saved and shown', true, !!id);
	const noteOf = async () => { const t = (await C.c.get(citeRoute(rv, ref))).text; const mm = new RegExp(`<li data-note="([^"]+)" data-anchor="([a-z]+)"><span class="wrap">([^<]*)</span>`).exec(t); return mm ? { id: mm[1], anchor: mm[2], body: decode(mm[3]) } : null; };
	const before = { note: await noteOf(), active: await C.c.activeVersion(), readModel: (await C.c.get(`/api/v/${enc(rv)}/chronology`)).headers.etag };
	L.check('before restart: the note on the document (HTTP)', { id, anchor: 'here', body }, before.note);
	const pid1 = C.srv.pid;
	L.cmd(`kill -TERM ${pid1}`);
	const stop = await C.srv.stop('SIGTERM');
	L.check('SIGTERM: graceful exit 0, both listeners closed', { graceful: true, code: 0, app: 'ECONNREFUSED', orig: 'ECONNREFUSED' }, { graceful: stop.graceful, code: stop.exit?.code, app: stop.appPort, orig: stop.origPort });
	L.cmd(`${C.serverCommand} (same data directory, same ports, still inside the offline namespace)`);
	await C.restart();
	const h = await C.c.health();
	L.check('restarted: a new process from the same build and data directory', { newPid: true, dataDir: C.dataDir, build: C.build.stamp?.buildId ?? null }, { newPid: h.instance.pid !== pid1, dataDir: h.instance.dataDir, build: h.instance.build?.buildId ?? null });
	L.check('health after restart: no recovery banner, no warnings, no storage error, the active version verified at startup', { recovery: null, warnings: [], storageError: null, verified: true }, { recovery: h.recovery, warnings: h.warnings, storageError: h.storageError, verified: h.startup?.checked?.[rv]?.ok === true });
	const after = { note: await noteOf(), active: await C.c.activeVersion(), readModel: (await C.c.get(`/api/v/${enc(rv)}/chronology`)).headers.etag };
	L.check('after restart: same active version, same read model digest, same note (id, anchor, body)', before, after);
	await P.goto(`${C.origin}${citeRoute(rv, ref)}`, ready(`doc:${ref}`));
	L.check('browser after restart: the note is shown, no recovery banner', { note: true, recovery: false }, await P.evaluate(`({ note: !!document.querySelector('#notes li[data-note=${JSON.stringify(id)}]'), recovery: !!document.getElementById('recovery-banner') })`));
	await P.shot(L.file(join(C.out, 'lane-10.png')));
	await P.goto(await activeOverview(C, L), ready('overview'));
	const ov = await P.evaluate(`({ total: document.getElementById('notes-total').textContent.trim(), link: [...document.querySelectorAll('section[aria-labelledby=kpi-notes] a.cite')].map((a) => a.getAttribute('href')) })`);
	L.check('overview "My notes": one note, linked by the citation route', { one: true, link: [citeRoute(rv, ref)] }, { one: /^1 note for this case/.test(ov.total), link: ov.link });
	C.S.noteLink = ov.link[0] ?? null;
	const proof = await (await import('../lib/netproof.mjs')).proveOffline();
	L.check('still offline after the restart (only lo, outbound and DNS fail, loopback works)', true, proof.pass);
}

// ---- extra checks -----------------------------------------------------------------------------------------------
const OWNER_CATEGORY = { 'CC-04': 'evidence', 'CC-05': 'analysis', 'CC-06': 'quantum', 'CC-07': 'registers', 'CC-08': 'litigation', 'CC-09': 'bundles', 'CC-10': 'system' };
const linearOf = (owner) => `GRS-${10 + Number(owner.slice(3))}`;

export async function checkRegistry(C, L) {
	const rv = C.fx.accepted.resultsVersion;
	const cov = JSON.parse(readFileSync(join(REPO, 'docs', 'plan', 'view-coverage.json'), 'utf8'));
	L.need('accepted inventory: 42 views', 42, cov.views.length);
	const P = C.P;
	await P.goto(`${C.origin}${vpath(rv)}/overview`, ready('overview'));
	// the routes as a fresh tab shows them: a sidebar link carries its view's last query of this tab session
	// (ViewNav.svelte), and lane 4 left the chronology filtered
	await P.evaluate(`Object.keys(sessionStorage).filter((k) => k.startsWith('clearcase:view-query:')).forEach((k) => sessionStorage.removeItem(k))`);
	await P.goto(`${C.origin}${vpath(rv)}/overview`, ready('overview'));
	const nav = await P.evaluate(`[...document.querySelectorAll('nav.views a[data-view]')].map((a) => { const c = a.cloneNode(true); c.querySelectorAll('.visually-hidden').forEach((x) => x.remove()); return { id: a.dataset.view, label: c.textContent.trim(), group: a.closest('section').querySelector('h2').textContent.trim(), status: a.dataset.status, href: a.getAttribute('href') }; })`);
	// a view whose owner route exists in the build's tree is implemented; its entry is available once its owner added it to
	// generate-view-registry.ts AVAILABLE (quantum and litigation have not yet), else it keeps its unavailable entry
	const reg = await registryOf(C.build.root);
	const implemented = implementedViews(C.build.root, reg.views);
	const want = cov.views.map((v) => ({ id: v.id, label: v.label, group: v.group, status: v.owner === 'CC-03' || (implemented.has(v.id) && reg.views.find((x) => x.id === v.id)?.status === 'available') ? 'available' : `unavailable-until:${linearOf(v.owner)}`, href: `${vpath(rv)}${v.owner === 'CC-03' ? `/${v.id}` : `/${OWNER_CATEGORY[v.owner]}/${v.id}`}` }));
	L.check('navigation: all 42 entries in inventory order with id, task label, group, status and route', want, nav);
	// heading = label, data-ready="<id>", no unavailable state and aria-current on an implemented view's entry; every
	// other M2 view keeps the unavailable state and its owner. The app runs without CLEARCASE_ANALYSIS_ADDITIONS, so
	// Timeline, Defence & Rebuttal and Info Required keep v5's heading (ADR 0003, GRS-48)
	L.note(`tree under test: ${JSON.stringify(modeSummary(reg.views, implemented, filledSlots(C.build.root, reg.slots)))}`);
	let ok = 0, implOk = 0, unavailOk = 0;
	for (const v of want) {
		const r = await C.c.get(v.href);
		const h1 = decode(/<h1[^>]*data-page-heading[^>]*>([^<]*)</.exec(r.text)?.[1] ?? '');
		const title = decode(/<title>([^<]*)<\/title>/.exec(r.text)?.[1] ?? '');
		const owner = /data-unavailable="([^"]+)" data-owner="([^"]+)"/.exec(r.text);
		if (implemented.has(v.id)) {
			const navTag = new RegExp(`<a [^>]*id="nav-${v.id}"[^>]*>`).exec(r.text)?.[0] ?? '';
			const got = { status: r.status, heading: h1, ready: /<main[^>]*data-ready="([^"]*)"/.exec(r.text)?.[1] ?? null, unavailable: /data-unavailable=/.test(r.text), current: /aria-current="page"/.test(navTag) };
			if (L.check(`${v.id}: implemented (owner route present): heading matches the label (BA-18), data-ready, no unavailable state, aria-current`, { status: 200, heading: viewHeading(v, false), ready: v.id, unavailable: false, current: true }, got)) { ok++; implOk++; }
			continue;
		}
		const avail = v.status === 'available';
		const exp = { status: 200, heading: v.label, title: expectedTitle({ section: v.label, caseName: C.titleName, status: avail ? null : 'not yet available' }), unavailable: avail ? null : [v.id, v.status.split(':')[1]] };
		if (L.check(`${v.id}: destination heading matches the label (BA-18), title, unavailable state and owner`, exp, { status: r.status, heading: h1, title, unavailable: owner ? [owner[1], owner[2]] : null })) { ok++; if (!avail) unavailOk++; }
	}
	L.note(`${ok}/42 destinations agree (${implOk} implemented, ${unavailOk} unavailable)`);
	L.check('implemented plus unavailable views outside the pilot: 40', 40, implOk + unavailOk);
	const ex = firstUnimplemented(reg.views, implemented);
	const first = ex && want.find((v) => v.id === ex.id);
	if (!first) L.note('clicking an unavailable entry: none left (every M2 view has its owner route)');
	else {
		const len0 = await P.evaluate('history.length');
		await P.click(`#nav-${first.id}`);
		await P.waitFor(ready(`view:${first.id}`));
		L.check('clicking an unavailable entry is a real navigation with its own history entry', { path: first.href, grew: true }, { path: await P.evaluate('location.pathname'), grew: (await P.evaluate('history.length')) > len0 });
	}
	await P.shot(L.file(join(C.out, 'check-registry.png')));
}

export async function checkDates(C, L) {
	const rv = C.fx.accepted.resultsVersion;
	const doc = readFileSync(join(REPO, 'docs', 'reference', 'audit-dispositions.md'), 'utf8');
	const baseline = Number(/(\d+) of 1,689 rows are undated/.exec(doc)?.[1] ?? NaN);
	const undated = C.pkg.chronology.filter((r) => r.date === '').length;
	L.check('undated rows: the package register equals the GRS-9 baseline (audit dispositions, BA-04)', baseline, undated);
	const withType = C.pkg.chronology.filter((r) => r.date_type || r.date_source).length;
	L.note(`rows with a supplied date type or provenance: ${withType}`);
	const P = C.P;
	await P.goto(`${C.origin}${vpath(rv)}/chronology`, ready('chronology'), 60000);
	const g = await P.settled(`(() => { const rows = [...document.querySelectorAll('.grid-table .grid-row[data-ref]')]; const b = rows.map((r) => r.querySelector('[data-date-basis]')).filter(Boolean); const by = {}; for (const x of b) by[x.dataset.dateBasis] = (by[x.dataset.dateBasis] ?? 0) + 1; return { column: [...document.querySelectorAll('.grid-table [role=columnheader]')].some((h) => h.textContent.trim() === 'Date basis'), by, undatedText: rows.filter((r) => r.querySelector('[role=cell]').textContent.trim() === 'undated').length, unknownLabel: b.filter((x) => x.dataset.dateBasis === 'unknown' && x.textContent.trim() === 'unknown' && /basis unknown/.test(x.title)).length }; })()`);
	const dated = C.pkg.chronology.length - undated;
	// the Date basis column is shown only when some row has a supplied basis; the Date column says 'undated' either way
	const want = withType ? { column: true, by: sortObj({ undated, unknown: dated - withType, supplied: withType }), undatedText: undated, unknownLabel: dated - withType } : { column: false, by: {}, undatedText: undated, unknownLabel: 0 };
	L.check(withType ? 'chronology: every dated row says basis unknown, every undated row says undated (none inferred)' : 'chronology: no row has a supplied basis, so the Date basis column is hidden; every undated row says undated', want, { ...g, by: sortObj(g.by) });
	const ov = (await C.c.get(`${vpath(rv)}/overview`)).text;
	L.check('overview date span states the undated count and that the basis is not supplied', true, new RegExp(`${undated.toLocaleString('en')} documents? undated\\. Dates are shown as the source gives them; their basis`).test(ov));
	const d1 = C.pkg.chronology.find((r) => r.date !== '');
	const d0 = C.pkg.chronology.find((r) => r.date === '');
	for (const [r, want] of [[d1, /basis unknown/], [d0, /^undated \(undated: the source gives no date\)$/]]) {
		const t = (await C.c.get(citeRoute(rv, r.ref))).text;
		const cell = decode((/<td id="doc-date">([\s\S]*?)<\/td>/.exec(t)?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
		L.check(`${r.ref} (${r.date ? 'dated' : 'undated'}): document date shows the source value and its basis`, true, want.test(cell) && (r.date === '' || cell.startsWith(r.date)));
		L.note(`${r.ref} date cell: ${cell}`);
	}
	await P.shot(L.file(join(C.out, 'check-dates.png')));
}

export async function checkRoutes(C, L) {
	const { pkg } = C;
	const rv = C.fx.accepted.resultsVersion;
	const direct = pkg.chronology.find((r) => pkg.assets[r.ref]?.kind === 'file');
	const d = await docPage(C, rv, direct.ref);
	L.check(`direct original: ${direct.ref}`, { state: 'present', route: ['direct', 'Direct original'] }, { state: d.state, route: d.route });
	const embedded = Object.entries(pkg.assets).filter(([, a]) => a.kind === 'embedded');
	const parents = countBy(embedded, ([, a]) => a.parentRef);
	const parent = pkg.chronology.find((r) => parents[r.ref] && pkg.assets[r.ref]?.mediaType === 'message/rfc822')?.ref;
	L.need('an e-mail with attachments inside it', true, !!parent);
	const p = await docPage(C, rv, parent);
	const li = [...p.html.matchAll(/<li data-attachment="([^"]+)" data-route="([a-z]+)">[\s\S]*?<\/li>/g)];
	L.check(`parent route: every attachment of ${parent} is listed as inside the message`, { n: parents[parent], routes: ['parent'] }, { n: li.length, routes: [...new Set(li.map((m) => m[2]))] });
	const href = decode(/href="([^"]+)" rel="noopener noreferrer" target="_blank">the parent original</.exec(li[0][0])?.[1] ?? '');
	L.check('the attachment links to its parent e-mail\'s original (the Open link of the parent)', p.open, href);
	const r = await originalsGet(C.orig, pathOf(href));
	L.check('the parent original is served with its sha256', { status: 200, sha256: pkg.assets[parent].sha256 }, { status: r.status, sha256: r.sha256 });
	L.note(`attachments in the register: ${embedded.length}, inside ${Object.keys(parents).length} parent originals`);
	L.check('unavailable source: lane 07 (negative control) showed data-route=unavailable and 410', true, !!C.S.missing && C.lanes.get(7)?.status === 'PASS');
	const P = C.P;
	await P.goto(`${C.origin}${citeRoute(rv, parent)}`, ready(`doc:${parent}`));
	await P.evaluate(`document.getElementById('attachments')?.scrollIntoView()`);
	await P.shot(L.file(join(C.out, 'check-routes.png')));
}

export async function checkPages(C, L) {
	const { pkg, b } = C;
	const rv = C.fx.accepted.resultsVersion;
	const re = /\[\[([A-Z]{1,8}-[0-9]{1,8})#p([1-9][0-9]{0,4})\]\]/g;
	const found = {};
	for (const f of readdirSync(join(C.pkgDir, 'datasets'))) { const n = (readFileSync(join(C.pkgDir, 'datasets', f), 'utf8').match(re) ?? []).length; if (n) found[f] = n; }
	L.note(`[[REF#pN]] page citations in the authored datasets: ${Object.keys(found).length ? JSON.stringify(found) : 'none'}`);
	L.check('search for page citations ran over every dataset', true, readdirSync(join(C.pkgDir, 'datasets')).length > 0);
	if (!Object.keys(found).length) L.note('the real data has no page citation, so the page route is proved with a constructed URL /v/<rv>/doc/<ref>?page=N');
	const pdfs = pkg.chronology.filter((r) => pkg.assets[r.ref]?.mediaType === 'application/pdf' && pkg.assets[r.ref].size > 150000 && pkg.assets[r.ref].size < 3e6).slice(0, 8);
	const P = C.P;
	for (const r of pdfs) {
		const page = 2;
		const url = `${citeRoute(rv, r.ref, page)}`;
		L.cmd(`browser: ${url}, click #open-original`);
		await P.goto(`${C.origin}${url}`, ready(`doc:${r.ref}`));
		const link = await P.evaluate(`({ text: document.getElementById('open-original')?.textContent.trim(), href: document.getElementById('open-original')?.getAttribute('href') })`);
		const before = pageTargets(b);
		await P.click('#open-original');
		const pop = await popup(b, before, `${C.orig}/view/`);
		const st = await pop.waitFor(`document.body.dataset.ready === '1' || document.body.dataset.ready === 'error' ? document.body.dataset.ready : null`, 60000);
		const fr = await frameEvaluator(b, pop.sessionId, /\/_pdfjs\/[^/]+\/frame\.html/);
		const v = await fr('({ numPages: window.__viewer.numPages, current: window.__viewer.current })');
		if (v.numPages < page) { L.note(`${r.ref} has ${v.numPages} page(s); trying the next PDF`); await pop.close(); continue; }
		L.check(`${r.ref}: ?page=${page} gives "Open at page ${page}" with #page=${page} on the viewer URL`, { text: `Open at page ${page}`, hash: true }, { text: link.text, hash: String(link.href).endsWith(`#page=${page}`) });
		L.check(`${r.ref}: the viewer renders and shows page ${page} first (pdf.js frame state)`, { ready: '1', current: page }, { ready: st, current: v.current });
		await pop.shot(L.file(join(C.out, 'check-pages.png')));
		await pop.close();
		return;
	}
	L.check('a multi-page PDF was found for the page route', true, false);
}

export async function checkContracts(C, L) {
	const rv = C.fx.accepted.resultsVersion;
	const P = C.P;
	await P.goto(`${C.origin}${vpath(rv)}/chronology`, ready('chronology'), 60000);
	const hrefs = await P.settled(`[...document.querySelectorAll('.grid-table .grid-row[data-ref]')].map((r) => [r.dataset.ref, r.querySelector('a').getAttribute('href')])`);
	const bad = hrefs.filter(([ref, h]) => h !== citeRoute(rv, ref) || h !== documentRoute(rv, ref));
	L.check('citation links: every chronology row links to /v/<encoded rv>/doc/<encoded ref> (= GRS-10 documentRoute)', { rows: C.pkg.chronology.length, bad: [] }, { rows: hrefs.length, bad: bad.slice(0, 5) });
	L.check('citation links: the overview note link uses the same route (lane 10)', citeRoute(rv, C.S.citedPdf ?? C.pkg.chronology[0].ref), C.S.noteLink);
	const files = await P.settled(`(() => { const by = {}; for (const e of document.querySelectorAll('[data-file]')) { const k = e.dataset.file + ':' + e.textContent.trim(); by[k] = (by[k] ?? 0) + 1; } return by; })()`);
	const exp = {};
	for (const r of C.pkg.chronology) { const a = C.pkg.assets[r.ref]; const k = a?.kind === 'file' ? `present:${['application/pdf', 'message/rfc822', 'image/jpeg'].includes(a.mediaType) ? 'open' : 'download'}` : 'missing:missing'; exp[k] = (exp[k] ?? 0) + 1; }
	L.check('chronology "Original" column: open / download / missing per row agrees with the asset media types', sortObj(exp), sortObj(files));
	const states = { viewer: C.lanes.get(5)?.status, text: C.lanes.get(6)?.status, download: C.lanes.get(6)?.status, missing: C.lanes.get(7)?.status, parent: C.lanes.get('routes')?.status };
	L.check('original-open states exercised on real data or the control: viewer (05), text (06), download (06), missing (07), parent (routes)', { viewer: 'PASS', text: 'PASS', download: 'PASS', missing: 'PASS', parent: 'PASS' }, states);
	L.check('title format checked on report (02), sections and document (09) and all 42 destinations (registry)', ['PASS', 'PASS', 'PASS'], [C.lanes.get(2)?.status, C.lanes.get(9)?.status, C.lanes.get('registry')?.status]);
	const ov = (await C.c.get(`${vpath(rv)}/overview`)).text;
	const narr = /<div class="narrative">([\s\S]*?)<\/div>/.exec(ov)?.[1] ?? '';
	const tags = [...new Set([...narr.matchAll(/<([a-z0-9]+)[\s>]/g)].map((m) => m[1]))].sort();
	L.check('rendered narrative uses only the allowlisted elements (p, br, a.cite, span.cite-broken)', true, tags.every((t) => ['a', 'br', 'p', 'span'].includes(t)));
	const base = `${C.origin}${vpath(rv)}/overview`;
	const ext = [...ov.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => decode(m[1])).filter((h) => { const u = new URL(h, base); return u.origin !== C.origin && u.origin !== C.orig; });
	L.check('overview links and assets: the app origin or the originals site only', [], ext);
}

export async function checkIsolation(C, L) {
	L.check('offline proof at start: only lo, outbound TCP and DNS fail, loopback works', true, C.proof.pass);
	L.note(`proof: ${JSON.stringify(C.proof)}`);
	const ls = listeners([C.port, C.origPort]);
	L.check('the server listens on 127.0.0.1 only (ss inside the namespace)', { n: 2, loopback: true }, { n: Array.isArray(ls) ? ls.length : 0, loopback: Array.isArray(ls) && ls.every((a) => a.startsWith('127.0.0.1:')) });
	// Chromium's own service pings (network time, component and account services) carry no app origin or referer;
	// they are contained by the canary and listed. Anything else (an app page, an original, the viewer) fails.
	const svc = /^(?:[a-z0-9-]+\.)*(?:google\.com|googleapis\.com|gstatic\.com|googleusercontent\.com|gvt1\.com|chromium\.org)(?::\d+)?$/;
	const hits = C.canary.hits.map((h) => ({ kind: h.kind, host: h.host ?? h.sni ?? null, path: h.path ? h.path.replace(/\?.*/, '?…') : null, origin: h.origin ?? null, referer: h.referer ?? null }));
	const browserOwn = hits.filter((h) => h.host && svc.test(h.host) && !h.origin && !h.referer);
	L.check('no app-originated request reached the canary (no exfiltration attempt by the server, an app page, an original or the viewer)', [], hits.filter((h) => !browserOwn.includes(h)));
	L.note(`Chromium background requests contained by the canary (never left the namespace): ${browserOwn.length ? JSON.stringify(browserOwn) : 'none'}`);
	const real = (p) => { try { return spawnSync('realpath', [p], { encoding: 'utf8' }).stdout.trim(); } catch { return p; } };
	L.check('originals live outside the repository (case folder not inside the worktree)', false, (real(C.fx.caseFolder) + '/').startsWith(real(REPO) + '/'));
	const tracked = spawnSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
	const names = new Set(C.fx.inventory.refs.map((r) => r.path.split('/').pop()));
	L.check('no tracked file in the repository has the name of an original', [], tracked.filter((t) => names.has(t.split('/').pop())).slice(0, 5));
	const after = treeStamp(C.fx.caseFolder);
	L.check('the canonical fixture case folder is unchanged by the run (find stamp)', C.treeBefore, after);
	L.check('Bun runs the server (health)', C.bun.version, (await C.c.health()).instance.bun);
}


// ---- the overview's widget slots (M2 extension point): unfilled slots name their owner, never look finished --------
export async function checkSlots(C, L) {
	const rv = C.fx.accepted.resultsVersion;
	// the slot declaration and the filled slots of the build's tree: a slot its owner's overview-widgets.ts fills must
	// render filled under its heading; every other one stays unfilled and names its owning issue
	const { slots: OVERVIEW_SLOTS } = await registryOf(C.build.root);
	const filled = filledSlots(C.build.root, OVERVIEW_SLOTS);
	L.need('the slot declaration lists at least one slot', true, OVERVIEW_SLOTS.length > 0);
	L.note(`filled slots in the tree under test: ${JSON.stringify([...filled])}`);
	const want = OVERVIEW_SLOTS.map((s) => expectedSlot(s, filled));
	L.cmd(`GET ${vpath(rv)}/overview (server-rendered slots)`);
	const html = (await C.c.get(`${vpath(rv)}/overview`)).text;
	const ssr = slotsFromHtml(html, decode).map((o) => observedSlot(o, filled));
	L.check('server-rendered overview: every declared slot, in order, filled by its owner or unfilled with its owning issue', want, ssr);
	const P = C.P;
	L.cmd(`browser: ${vpath(rv)}/overview, read section[data-slot]`);
	await P.goto(`${C.origin}${vpath(rv)}/overview`, ready('overview'));
	const dom = (await P.settled(`[...document.querySelectorAll('section[data-slot]')].map((s) => ({ id: s.dataset.slot, status: s.dataset.slotStatus, heading: s.querySelector('h2')?.textContent.trim() ?? null, text: s.querySelector('p')?.textContent.trim() ?? null }))`)).map((o) => observedSlot(o, filled));
	L.check('hydrated overview: the same slots and states (GRS-17 registers, GRS-20 system)', want, dom);
	L.check('slot owners are the issues the brief names (GRS-17, GRS-20)', ['GRS-17', 'GRS-20'], [...new Set(OVERVIEW_SLOTS.map((s) => s.linear))].sort());
	await P.evaluate(`document.querySelector('section[data-slot]')?.scrollIntoView()`);
	await P.shot(L.file(join(C.out, 'check-slots.png')));
}
