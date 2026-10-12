// Drive steps: the user path through the pilot, one entry per action, in order. Each step names its feature file
// (features/<feature>.md), acts the way a user does (clicks and form input in Chromium over CDP), checks the
// resulting state and returns its evidence; a thrown error fails it and every later step is NOT RUN.
// These are the pilot's steps. An owner's steps live beside its feature file in features/<feature>.steps.mjs and are
// appended after these, in name order (lib/features.mjs; see SKILL.md, Extending).
//
// The context x: x.page (the main tab: evaluate, waitFor, navigate, sessionId), x.b (the browser), x.c (HTTP client
// of tests/e2e/pilot/lib/client.mjs), x.app and x.orig (origins), x.synth (the synthetic case: caseDir, pkgDir,
// resultsVersion, rows), x.state (values shared between steps), x.click(sel), x.fill(sel, value), x.text(sel),
// x.waitReady(value), x.shot(name[, sessionId]) -> evidence path, x.tab(sessionId) -> evaluate/waitFor of another tab.

import { driveSteps } from './features.mjs';

const enc = encodeURIComponent;
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

export const pilotSteps = [
	{
		id: 'import-form', feature: 'import-validation', title: 'Import results: fill the case folder and package, choose Validate package',
		async run(x) {
			await x.page.navigate(`${x.app}/import`);
			await x.waitReady('import');
			// The import page marks itself ready in its server HTML, before hydration, and hydrating `value={...}` resets
			// what was typed (finding reported to the app owner). Fill, then require both values to survive 300 ms.
			const want = { '#caseFolder': x.synth.caseDir, '#packageSource': x.synth.pkgDir };
			let refills = -1;
			for (let stable = false; !stable && refills < 10; refills++) {
				for (const [sel, v] of Object.entries(want)) await x.fill(sel, v);
				await new Promise((r) => setTimeout(r, 300));
				stable = (await x.page.evaluate(`[${Object.keys(want).map((s) => `document.querySelector(${JSON.stringify(s)}).value`)}]`)).every((v, i) => v === Object.values(want)[i]);
				must(stable || refills < 9, 'the import form keeps losing its input');
			}
			const filled = await x.shot('import-form-filled');
			await x.click('#validate');
			const ready = await x.page.waitFor(`/^\\/import\\/\\d+$/.test(location.pathname) && document.querySelector('main[data-ready^="import:"]')?.dataset.ready`, 60000);
			x.state.importId = Number(ready.split(':')[1]);
			return { filled, refills, importId: x.state.importId, url: await x.page.evaluate('location.href') };
		},
	},
	{
		id: 'validation-report', feature: 'import-validation', title: 'Validation report shows the verdict, results version and a verified candidate',
		async run(x) {
			const r = await x.page.evaluate(`(() => { const m = document.querySelector('main'); return { verdict: m.dataset.verdict, rv: document.getElementById('results-version')?.textContent, verify: document.getElementById('verify-state')?.textContent, active: document.getElementById('active-state')?.textContent, summary: document.getElementById('diag-summary')?.textContent, codes: [...document.querySelectorAll('[data-code]')].map((e) => e.dataset.code + ':' + e.dataset.severity), canActivate: !!document.getElementById('activate'), title: document.title }; })()`);
			must(r.verdict === 'accept' || r.verdict === 'report', `verdict ${r.verdict}, expected accept or report`);
			must(r.rv === x.synth.resultsVersion, `results version ${r.rv}, expected ${x.synth.resultsVersion}`);
			must(r.verify === 'verified', `stored copy ${r.verify}`);
			must(r.active === 'not active' && r.canActivate, `candidate state ${r.active}, activate button ${r.canActivate}`);
			// side effect, second view: nothing is active yet, so / still sends the user to Import results
			const root = await x.c.get('/');
			must(root.location === '/import', `/ redirects to ${root.location} before activation`);
			x.state.vid = r.rv;
			return { ...r, rootBeforeActivation: root.location, shot: await x.shot('validation-report') };
		},
	},
	{
		id: 'preview', feature: 'preview-activation', title: 'Preview the candidate: read-only overview with the CANDIDATE PREVIEW banner',
		async run(x) {
			await x.click('#preview');
			await x.waitReady('overview');
			const r = await x.page.evaluate(`({ path: location.pathname, banner: document.getElementById('candidate-banner')?.textContent.trim(), active: !!document.getElementById('active-banner'), docs: document.getElementById('count-documents')?.dataset.count })`);
			must(r.path === `/v/${enc(x.state.vid)}/overview`, `preview path ${r.path}`);
			must(r.banner?.startsWith('CANDIDATE PREVIEW') && !r.active, `banner ${r.banner}`);
			must(Number(r.docs) === x.synth.rows, `documents ${r.docs}, expected ${x.synth.rows}`);
			const after = await x.c.activeVersion();
			must(after === null, `previewing activated ${after}`);
			return { ...r, activeAfterPreview: after, shot: await x.shot('preview-candidate') };
		},
	},
	{
		id: 'activate', feature: 'preview-activation', title: 'Back to the report, acknowledge the new warnings, Activate this version',
		async run(x) {
			await x.click('#candidate-banner a');
			await x.waitReady(`import:${x.state.importId}`);
			// The synthetic case brings warnings that are new for the case, so activation needs the acknowledgement.
			const ack = await x.page.evaluate(`!!document.getElementById('ack')`);
			must(ack, 'no acknowledgement checkbox (#ack), but the synthetic package has new warnings');
			await x.click('#ack');
			const checked = ack ? await x.page.evaluate(`document.getElementById('ack').checked`) : null;
			const before = await x.shot('activation-form');
			await x.click('#activate');
			await x.page.waitFor(`location.pathname.endsWith('/overview') && document.getElementById('active-banner') && document.querySelector('main')?.dataset.ready === 'overview'`, 60000);
			const banner = await x.text('#active-banner');
			const active = await x.c.activeVersion();
			must(active === x.state.vid, `active version ${active}, expected ${x.state.vid}`);
			// side effect, second view: / now redirects to the activated version's overview
			const root = await x.c.get('/');
			must(root.location === `/v/${enc(x.state.vid)}/overview`, `/ redirects to ${root.location} after activation`);
			return { ackRequired: ack, ackChecked: checked, before, banner, activeVersion: active, rootAfterActivation: root.location, shot: await x.shot('activated-overview') };
		},
	},
	{
		id: 'overview-slots', feature: 'overview', title: 'Overview widget slots: each unfilled M2 slot names its owning issue',
		async run(x) {
			// src/lib/components/overview-slots.ts declares the slots. Until an owner fills one from
			// src/lib/views/<category>/overview-widgets*.ts it renders "Not yet available — owned by GRS-nn (CC-nn)".
			const slots = await x.page.evaluate(`[...document.querySelectorAll('main section[data-slot]')].map((e) => ({ slot: e.dataset.slot, status: e.dataset.slotStatus, heading: e.querySelector('h2')?.textContent.trim(), text: e.querySelector('p')?.textContent.trim() ?? null }))`);
			const owners = { deadlines: 'GRS-17', 'unbilled-time': 'GRS-17', 'rescan-freshness': 'GRS-20' };
			must(slots.length === Object.keys(owners).length && slots.every((s) => s.slot in owners), `slots ${JSON.stringify(slots)}`);
			// a filled slot shows its owner's widget; an unfilled one must say who owns it, never look finished
			for (const s of slots) if (s.status !== 'filled') must(s.status === 'unavailable' && s.text?.startsWith(`Not yet available — owned by ${owners[s.slot]}`), `slot ${JSON.stringify(s)}`);
			return { slots };
		},
	},
	{
		id: 'chronology', feature: 'chronology', title: 'Open Chronology from the case navigation: every document of the version is listed',
		async run(x) {
			await x.click('#nav-chronology');
			await x.waitReady('chronology');
			const r = await x.page.evaluate(`({ count: Number(document.getElementById('row-count')?.dataset.count), refs: [...document.querySelectorAll('[data-ref]')].map((e) => e.dataset.ref), current: document.querySelector('[aria-current=page]')?.id })`);
			must(r.count === x.synth.rows, `row count ${r.count}, expected ${x.synth.rows}`);
			must(r.refs.includes('OD-001'), `OD-001 not listed: ${r.refs}`);
			must(r.current === 'nav-chronology', `aria-current is on ${r.current}`);
			return { ...r, shot: await x.shot('chronology') };
		},
	},
	{
		id: 'citation', feature: 'overview', title: 'Overview narrative: follow the [[OD-001]] citation to its document',
		async run(x) {
			await x.click('#nav-overview');
			await x.waitReady('overview');
			const cite = await x.page.evaluate(`(() => { const a = [...document.querySelectorAll('.narrative a.cite')].find((e) => e.textContent.trim() === 'OD-001'); return a ? { href: a.getAttribute('href'), text: document.querySelector('.narrative').textContent.trim() } : null; })()`);
			must(cite?.href === `/v/${enc(x.state.vid)}/doc/OD-001`, `citation link ${JSON.stringify(cite)}`);
			const overview = await x.shot('overview-narrative');
			await x.page.evaluate(`[...document.querySelectorAll('.narrative a.cite')].find((e) => e.textContent.trim() === 'OD-001').click()`);
			await x.waitReady('doc:OD-001');
			const doc = await x.page.evaluate(`({ path: location.pathname, heading: document.querySelector('h1')?.textContent.trim(), state: document.querySelector('section.original')?.dataset.originalState, presentation: document.querySelector('section.original')?.dataset.presentation, open: (() => { const a = document.getElementById('open-original'); return a && { href: a.href, target: a.target, rel: a.rel }; })() })`);
			must(doc.path === cite.href && doc.heading?.startsWith('OD-001'), `document page ${JSON.stringify(doc)}`);
			x.state.doc = doc;
			return { cite, overview, doc, shot: await x.shot('document-OD-001') };
		},
	},
	{
		id: 'viewer', feature: 'document-originals', title: 'Open the cited PDF: the isolated originals-site viewer renders it',
		async run(x) {
			const o = x.state.doc;
			must(o.state === 'present' && o.presentation === 'viewer', `original state ${o.state}, presentation ${o.presentation}`);
			must(o.open?.href.startsWith(`${x.orig}/view/`) && o.open.target === '_blank' && /noopener/.test(o.open.rel) && /noreferrer/.test(o.open.rel), `open link ${JSON.stringify(o.open)}`);
			const sid = await x.openTab('#open-original', `${x.orig}/view/`);
			const tab = x.tab(sid);
			const ready = await tab.waitFor(`document.body?.dataset.ready === '1' || document.body?.dataset.ready === 'error' ? document.body.dataset.ready : null`, 30000);
			must(ready === '1', `viewer wrapper body[data-ready] is ${ready}`);
			const wrapper = await tab.evaluate(`({ url: location.href, origin: location.origin, opener: window.opener === null, title: document.title, readyMs: document.body.dataset.readyMs })`);
			const frame = await x.frame(sid, /\/frame\.html/);
			const viewer = await frame(`({ state: window.__viewer && { numPages: window.__viewer.numPages, rendered: window.__viewer.rendered, error: window.__viewer.error }, text: document.querySelector('.textLayer')?.textContent ?? null })`);
			must(viewer.state?.numPages >= 1 && viewer.state.rendered >= 1, `pdf.js frame state ${JSON.stringify(viewer.state)}`);
			must(wrapper.origin === x.orig && wrapper.opener, `wrapper ${JSON.stringify(wrapper)}`);
			return { wrapper, frame: frame.where, viewer, shot: await x.shot('viewer-OD-001', sid) };
		},
	},
	{
		id: 'unavailable-view', feature: 'unavailable-views', title: 'A registry view owned by a later ticket shows its explicit not-yet-available state',
		async run(x) {
			await x.click('#nav-matter');
			await x.waitReady('view:matter');
			const r = await x.page.evaluate(`({ owner: document.querySelector('[data-unavailable=matter]')?.dataset.owner, entries: document.querySelectorAll('nav.views a[data-view]').length, available: [...document.querySelectorAll('nav.views a[data-status=available]')].map((a) => a.dataset.view) })`);
			must(r.owner === 'GRS-15', `matter owner ${r.owner}`);
			must(r.entries === 42, `navigation has ${r.entries} entries, expected 42`);
			return { ...r, shot: await x.shot('unavailable-matter') };
		},
	},
];

/** The pilot's steps, then every features/<feature>.steps.mjs in name order; throws on an invalid module or a duplicate id. */
export const steps = () => driveSteps(pilotSteps);
