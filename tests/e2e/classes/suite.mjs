#!/usr/bin/env bun
// Offline browser suite of the UI bug classes (GRS-59), run by `bun run --bun test:e2e` in its own network namespace.
// One shared check per class in REVIEW.md "UI classes", run over every target the app's own definitions name
// (targets.mjs: page routes, routes with form actions and their rendered POST forms, CSV exports):
//   inflight  text typed while a save is in flight is kept (or the field is inert), whether the save succeeds or fails;
//   nojs      without JavaScript a refused save (the work store held busy from outside) keeps its message and typed
//             values through another row's action on the page;
//   dialog    a question answered while a save is in flight, or a save started while it is open, never leaves that
//             save's error beside another entry;
//   csv       every CSV export of a case whose free-text fields carry a formula after ;, tab, CR and LF (and a typed
//             entry that does, on pages with a form) has no unneutralised formula start after one of them;
//   narrow    no page of a case with a 64-character id without break opportunity scrolls sideways at 320 or 390 px;
//   back      after Back to a page, focus is on an element of the page, never <body>; after Back with typed input
//             answered "keep" or "stay", focus returns to the typed field.
// A target a class does not apply to is listed with its reason (declared.mjs, or what the page showed). The in-flight
// window is made in the browser (CDP Fetch holds the action's request), so it is the same for every form.
// Synthetic data only. Results: $CLEARCASE_E2E_OUT/classes/<scenario>.json and summary.json ({scenarios, excluded}).
// CLASSES_ONLY=<class,...> runs only those classes (for the proof runs; the summary records it).
process.env.CANARY_PORT ??= '43899';
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { Database } = await import('bun:sqlite');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { launch, sleep } = await import('../pilot/lib/cdp.mjs');
const { INIT, openPage } = await import('../pilot/suite/browser.mjs');
const { appServer, vpath } = await import('../pilot/suite/context.mjs');
const { buildCase } = await import('../pilot/lib/fixtures.ts');
const { VIEWS } = await import('../../../src/lib/components/view-registry.ts');
const { csvExports, hasActions, pageTargets } = await import('./targets.mjs');
const { NO_FORM, NOT_APPLICABLE, NOT_CSV, QUERY } = await import('./declared.mjs');

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..'));
const BUILD = resolve(process.env.E2E_BUILD_DIR ?? join(ROOT, 'build'));
const OUT = join(process.env.CLEARCASE_E2E_OUT ?? join(ROOT, '.local', 'e2e'), 'classes');
mkdirSync(OUT, { recursive: true });
const CLOCK = '2026-10-08T09:00:00Z';
const J = JSON.stringify;
const CLASSES = ['inflight', 'nojs', 'dialog', 'csv', 'narrow', 'back'];
const ONLY = process.env.CLASSES_ONLY ? process.env.CLASSES_ONLY.split(',') : CLASSES;
const runs = (c) => ONLY.includes(c);
/** The formula payload: one segment after each of ;, tab, CR and LF. A text input drops CR and LF; a textarea keeps them. */
const PAYLOAD = ' Syn;=CCX(1)\t+CCX(2)\r-CCX(3)\n@CCX(4)';
const UNBROKEN = 'syn_unbroken_case_id_'.padEnd(64, '0123456789abcdefghijklmnopqrstuvwxyz');

const results = [];
const excluded = [];
const exclude = (cls, target, reason) => { excluded.push({ class: cls, target, reason }); console.log(`N/A     ${cls} ${target}: ${reason}`); };
async function scenario(id, view, title, fn) {
	const t0 = Date.now();
	let pass = false, evidence = {};
	try {
		await fresh();
		const r = await fn();
		evidence = r;
		pass = Object.values(r.checks ?? {}).length > 0 && Object.values(r.checks).every((x) => x === true);
	} catch (e) { evidence = { error: String(e?.stack ?? e).slice(0, 4000) }; }
	results.push({ id, view, pass, ms: Date.now() - t0 });
	writeFileSync(join(OUT, `${id.replace(/[^\w.-]+/g, '_')}.json`), J({ id, view, title, pass, ms: Date.now() - t0, ...evidence }, null, 1));
	const failed = pass ? '' : ` ${J(Object.fromEntries(Object.entries(evidence.checks ?? {}).filter(([, v]) => v !== true)))}${evidence.error ? ' ' + evidence.error.split('\n')[0] : ''}`;
	console.log(`${pass ? 'PASS' : 'FAIL'}    ${id} [${view}] ${title}${failed}`);
	return pass;
}

/** Blob downloads (<a download> of an object URL) are kept as text in window.__downloads (test instrumentation). */
const HOOK = `(() => { window.__downloads = []; const C = URL.createObjectURL.bind(URL); const blobs = new Map();
	URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
	const click = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { o.text().then((t) => window.__downloads.push({ name: this.download, type: o.type, text: t })); return; } return click.call(this); };
})();`;

let p, b, A, tmp;
/**
 * A new tab for each scenario: a page left with typed input keeps a leave guard (beforeunload), which the shared CDP
 * layer answers "stay", so the next navigation would be refused. Closing the tab skips it.
 */
async function fresh() {
	const old = p;
	p = await openPage(b, { initScript: `${INIT};${HOOK}` });
	await old?.close();
}

// ---- page helpers --------------------------------------------------------------------------------------------------

const settle = () => p.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
const open = async (url) => { await p.goto(A.origin + url, 'true', 20000); await settle(); };
/** Without JavaScript: load and wait for the server-rendered page. */
const openNoJs = async (url) => { await p.navigate(A.origin + url); await p.waitFor(`!!document.querySelector('main#main')`, 20000); };
/** Submit without JavaScript by clicking `sel`, and wait for the next document. */
const clickNoJs = async (sel) => {
	await p.evaluate('window.__nojs = 1');
	await p.click(sel).catch(() => p.evaluate(`document.querySelector(${J(sel)}).click()`));
	await p.waitFor(`window.__nojs !== 1 && !!document.querySelector('main#main') && document.readyState === 'complete'`, 20000);
	// an answer that redirects loads one more document: wait until none follows for 300 ms
	for (;;) { await p.evaluate('window.__nojs = 2'); await sleep(300); if (await p.evaluate('window.__nojs === 2 && document.readyState === "complete"').catch(() => false)) break; await p.waitFor(`document.readyState === 'complete' && !!document.querySelector('main#main')`, 20000); }
};
/**
 * The POST forms of the page, one per action (the first form that posts to it): each form gets data-cc="<i>", its
 * typed fields data-cc-f="<i>-<j>" and its submit button data-cc-s="<i>"; another POST submit control on the page (a
 * row's Delete, another form) is marked data-cc-o<i>="<k>". Test instrumentation: attributes only.
 */
const FORMS = `(() => {
	const post = [...document.querySelectorAll('form')].filter((f) => (f.getAttribute('method') || '').toUpperCase() === 'POST');
	const seen = new Map();
	for (const f of post) { const a = f.getAttribute('action') || ''; if (!seen.has(a)) seen.set(a, f); }
	const textLike = (e) => (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && ['text', 'search', ''].includes(e.getAttribute('type') || ''))) && !!e.name;
	const isSubmit = (e) => (e.tagName === 'BUTTON' && e.type === 'submit') || (e.tagName === 'INPUT' && e.type === 'submit');
	const out = [];
	let i = 0;
	for (const [a, f] of seen) {
		const action = a;
		f.dataset.cc = String(i);
		const els = [...f.elements];
		const fields = els.filter(textLike);
		fields.forEach((e, j) => (e.dataset.ccF = i + '-' + j));
		const sub = els.find((e) => isSubmit(e) && !e.hasAttribute('formaction') && e.offsetParent !== null) ?? els.find((e) => isSubmit(e) && !e.hasAttribute('formaction'));
		if (sub) sub.dataset.ccS = String(i);
		const others = [...document.querySelectorAll('button, input[type=submit]')].filter((e) => isSubmit(e) && e !== sub && e.form && (e.form.getAttribute('method') || '').toUpperCase() === 'POST' && e.offsetParent !== null && (e.form !== f || (e.hasAttribute('formaction') && e.getAttribute('formaction') !== a)) && !/retry|discard/i.test(e.textContent || e.value || ''));
		others.forEach((e, k) => e.setAttribute('data-cc-o' + i, String(k)));
		out.push({ i, action, id: f.id || null, fields: fields.map((e) => ({ sel: '[data-cc-f="' + i + '-' + fields.indexOf(e) + '"]', name: e.name, tag: e.tagName, disabled: e.disabled || e.readOnly })), submit: sub ? '[data-cc-s="' + i + '"]' : null, others: others.map((e, k) => ({ sel: '[data-cc-o' + i + '="' + k + '"]', text: (e.textContent || e.value || '').trim().slice(0, 40), formaction: e.getAttribute('formaction') })) });
		i++;
	}
	return out;
})()`;
/**
 * Fill every field of form `i` as a user would: typed text gets `text(name, tag)` (source of a page function), a number-like name a number, a date a
 * date, a select its first non-empty option, a checkbox is ticked. Values are set with input and change events.
 */
const fillForm = (i, text) => p.evaluate(`(() => {
	const f = document.querySelector('[data-cc="${i}"]');
	const set = (e, v) => { const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
	const filled = {};
	for (const e of f.elements) {
		if (!e.name || e.disabled || e.type === 'hidden' || e.type === 'file' || e.type === 'submit' || e.tagName === 'BUTTON') continue;
		const num = /amount|hours|rate|sum|value|qty|number/i.test(e.name);
		if (e.type === 'checkbox') { if (!e.checked) { e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); } filled[e.name] = 'on'; continue; }
		const v = e.tagName === 'SELECT' ? ([...e.options].find((o) => o.value)?.value ?? '') : e.type === 'date' ? '2026-10-01' : num ? '10' : (${text})(e.name, e.tagName);
		set(e, v); filled[e.name] = v;
	}
	return filled;
})()`);
const value = (sel) => p.evaluate(`document.querySelector(${J(sel)})?.value ?? null`);
/** Every typed value on the page (inputs and textareas), to look for text that must not be lost. */
const allValues = () => p.evaluate(`[...document.querySelectorAll('input, textarea')].filter((e) => !['hidden', 'checkbox', 'radio', 'submit', 'file'].includes(e.type)).map((e) => e.value)`);
/** The visible error and alert messages on the page, and notes on an entry carried back unsaved ([data-unsaved]). */
const errors = () => p.evaluate(`[...document.querySelectorAll('[role=alert], [id$="-error"], .error, [data-unsaved]')].filter((e) => e.offsetParent !== null && e.textContent.trim()).map((e) => ({ id: e.id || null, text: e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 200), form: e.closest('form')?.dataset.cc ?? null }))`);
/** Click at the end of a field and type `text` there (CDP insertText, as from a keyboard). Returns the field's value. */
async function typeAtEnd(sel, text) {
	await p.click(sel).catch(() => {});
	await p.evaluate(`(() => { const e = document.querySelector(${J(sel)}); if (e && document.activeElement === e) e.setSelectionRange?.(e.value.length, e.value.length); return true; })()`);
	const focused = await p.evaluate(`document.activeElement === document.querySelector(${J(sel)})`);
	if (focused) await p.s('Input.insertText', { text });
	return { focused, value: await value(sel) };
}
/** Hold the next action request (POST to ?/...) in the browser; `release(fail)` lets it through or fails it. */
async function holdAction() {
	await p.s('Fetch.enable', { patterns: [{ urlPattern: '*?/*', requestStage: 'Request' }] });
	const paused = b.once((m) => m.method === 'Fetch.requestPaused' && m.sessionId === p.sessionId, 8000);
	let done = false;
	return {
		paused: paused.then((m) => m.params, () => null),
		async release(fail = false) {
			if (done) return; done = true;
			const m = await paused.then((x) => x.params, () => null);
			if (m) await p.s(fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', fail ? { requestId: m.requestId, errorReason: 'ConnectionRefused' } : { requestId: m.requestId }).catch(() => {});
			await p.s('Fetch.disable').catch(() => {});
		},
	};
}
/** The work store held with BEGIN IMMEDIATE from outside the app (a busy store): the next write is refused. */
const holdStore = () => { const l = new Database(join(A.dataDir, 'work.sqlite')); l.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); let held = true; return () => { if (held) { held = false; l.exec('ROLLBACK'); l.close(); } }; };
/** Wait until no request of the page is in flight for 400 ms (a save and the reload it triggers). */
async function quiet(timeout = 15000) {
	const t0 = Date.now();
	let last = Date.now(), inflight = new Set();
	const off = b.on((m) => {
		if (m.sessionId !== p.sessionId) return;
		if (m.method === 'Network.requestWillBeSent') { inflight.add(m.params.requestId); last = Date.now(); }
		if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inflight.delete(m.params.requestId); last = Date.now(); }
	});
	try { while (Date.now() - t0 < timeout && (inflight.size || Date.now() - last < 400)) await sleep(50); } finally { off(); }
	await settle();
}

// ---- targets -------------------------------------------------------------------------------------------------------

/** Every page URL of a version, with the route it comes from. */
const pagesOf = (rv, importId) => pageTargets(ROOT, { vpath, rv, ref: 'OD-001', importId, views: VIEWS });
/** One form target per (route, action) on the main case: the page's POST forms, or the declared reason it has none. */
async function formTargets(pages) {
	const out = [];
	for (const t of pages) {
		if (!hasActions(ROOT, t.route) || !t.url) continue;
		await open(t.url);
		const forms = await p.evaluate(FORMS);
		if (!forms.length) {
			if (NO_FORM[t.route]) for (const c of ['inflight', 'nojs', 'dialog']) exclude(c, t.route, NO_FORM[t.route]);
			else for (const c of ['inflight', 'nojs', 'dialog']) if (runs(c)) await scenario(`${c}:${t.route}`, t.view, 'a route with form actions renders a POST form to drive', async () => ({ evidence: { url: t.url }, checks: { formFound: false, declared: false } }));
			continue;
		}
		for (const f of forms) out.push({ ...t, action: f.action, key: `${t.route} ${f.action}`, form: f });
	}
	return out;
}
const na = (t, cls) => NOT_APPLICABLE[t.key]?.[cls];

// ---- the classes ---------------------------------------------------------------------------------------------------

/** inflight: type while the save is held, then let it succeed (ok) or fail (fail): the typed text is kept or never accepted. */
async function inflight(t, mode) {
	return scenario(`inflight-${mode}:${t.key}`, t.view, `text typed while the ${t.action} save is in flight is kept when the save ${mode === 'ok' ? 'succeeds' : 'fails'}, or the field takes no input`, async () => {
		await open(t.url);
		const [f] = (await p.evaluate(FORMS)).filter((x) => x.action === t.action);
		const field = f.fields.find((x) => !x.disabled);
		await fillForm(f.i, '(n) => `Synthetic ${n}`');
		const h = await holdAction();
		let typed = null, paused = null;
		try {
			await p.click(f.submit);
			paused = await h.paused;
			if (paused) typed = await typeAtEnd(field.sel, ' TYPED-IN-FLIGHT');
		} finally { await h.release(mode === 'fail'); }
		await quiet();
		const values = await allValues();
		const accepted = !!typed?.value?.includes('TYPED-IN-FLIGHT');
		const kept = values.some((v) => v.includes('TYPED-IN-FLIGHT'));
		return { evidence: { url: t.url, field: field.name, request: paused?.request?.url ?? null, typed, accepted, kept, errors: await errors() },
			checks: { requestHeld: !!paused, notLost: !accepted || kept } };
	});
}

/** nojs: a refused save keeps its message and typed values through another row's action on the page. */
async function nojs(t) {
	return scenario(`nojs:${t.key}`, t.view, `without JavaScript a refused ${t.action} save keeps its message and typed values through another row's action`, async () => {
		await p.s('Emulation.setScriptExecutionDisabled', { value: true });
		try {
			await openNoJs(t.url);
			let forms = await p.evaluate(FORMS);
			let f = forms.find((x) => x.action === t.action);
			// another row first: a saved entry gives the page a row action to take
			let seeded = false;
			if (!f.others.length) {
				await fillForm(f.i, '(n) => `Synthetic seed ${n}`');
				await clickNoJs(f.submit);
				seeded = true;
				forms = await p.evaluate(FORMS);
				f = forms.find((x) => x.action === t.action);
			}
			const typed = `Synthetic refused ${t.action.replace(/\W/g, '')}`;
			const filled = await fillForm(f.i, `() => ${J(typed)}`);
			const release = holdStore();
			try { await clickNoJs(f.submit); } finally { release(); }
			forms = await p.evaluate(FORMS);
			f = forms.find((x) => x.action === t.action);
			const refused = { errors: await errors(), kept: (await allValues()).includes(typed) };
			const other = f?.others[0] ?? null;
			let after = null, otherDisabled = null;
			if (other) {
				otherDisabled = await p.evaluate(`document.querySelector(${J(other.sel)})?.disabled ?? null`);
				if (!otherDisabled) await clickNoJs(other.sel);
				after = { errors: await errors(), kept: (await allValues()).includes(typed) };
			}
			const hydrated = await p.evaluate('!!window.__ccMounted');
			return { evidence: { url: t.url, seeded, filled, refused, other, otherDisabled, after },
				checks: { noScripts: !hydrated, refusedShown: refused.errors.length > 0, refusedKept: refused.kept,
					// a page with no other row action, even with a saved entry, keeps only the refusal checks
					keptAfterOther: !other || otherDisabled === true || (!!after && after.kept && after.errors.length > 0) } };
		} finally { await p.s('Emulation.setScriptExecutionDisabled', { value: false }); }
	});
}

/**
 * dialog: the page's question (Back with typed input, or Edit on another row) and a failing save in flight, in both
 * orders. After the failure, an error on the page means the form still holds the submitted entry (its typed text).
 */
async function dialog(t) {
	const ASK = `[...document.querySelectorAll('[role=alertdialog], [role=dialog], dialog[open]')].find((e) => e.offsetParent !== null)`;
	const answer = (re) => p.evaluate(`(() => { const d = ${ASK}; const btn = d && [...d.querySelectorAll('button')].find((x) => ${re}.test(x.textContent)); if (!btn || btn.disabled) return btn ? 'disabled' : null; btn.click(); return btn.id || btn.textContent.trim(); })()`);
	/** Open the page by client navigation, so Back stays in the app, and edit the first row when rows are editable. */
	const start = async () => {
		await open(t.url.replace(/\/[^/]+$/, '/overview').replace(/\/v\/([^/]+)\/.*$/, '/v/$1/overview'));
		const nav = await p.evaluate(`(() => { const a = [...document.querySelectorAll('a[href]')].find((x) => new URL(x.href).pathname === ${J(t.url)}); if (!a) return false; a.click(); return true; })()`);
		if (!nav) await open(t.url);
		else { await p.waitFor(`location.pathname === ${J(t.url)} && !!document.querySelector('main#main')`, 15000); await settle(); }
		const edits = await p.evaluate(`document.querySelectorAll('[data-edit]').length`);
		if (edits >= 2) { await p.click('[data-edit]'); await sleep(150); }
		const all = await p.evaluate(FORMS);
		// an edited row may post to another action of the same form (filings: ?/add becomes ?/save)
		const f = all.find((x) => x.action === t.action) ?? all.find((x) => t.form.id && x.id === t.form.id);
		const field = f.fields.find((x) => !x.disabled);
		const typed = `Synthetic asked ${t.action.replace(/\W/g, '')}`;
		if (edits < 2) await fillForm(f.i, '(n) => `Synthetic ${n}`');
		await p.type(field.sel, typed);
		return { f, field, typed, edits };
	};
	const trigger = async (edits) => {
		if (edits >= 2) await p.evaluate(`document.querySelectorAll('[data-edit]')[1]?.click()`);
		else await p.evaluate('history.back()');
		try { await p.waitFor(`!!(${ASK})`, 2000); return true; } catch { return false; }
	};
	const outcome = async (typed, field) => {
		const errs = await errors();
		const here = await p.evaluate('location.pathname');
		const holds = (await value(field.sel)) === typed || (await allValues()).includes(typed);
		return { errors: errs, path: here, holds };
	};
	// probe: does any question guard this form at all?
	await fresh();
	const probe = await start();
	const asks = await trigger(probe.edits);
	if (asks) await answer('/keep|stay/i');
	if (!asks) { exclude('dialog', t.key, 'no question opens for Back or another row\'s Edit while the form holds typed input'); return true; }
	let ok = true;
	for (const order of ['ask-then-save', 'save-then-ask']) {
		ok = (await scenario(`dialog-${order}:${t.key}`, t.view, order === 'ask-then-save' ? 'a save started while the question is open, then the question answered with discard while it is in flight, then the save fails: its error stays with the submitted entry' : 'the question raised and answered with discard while a save is in flight, then the save fails: its error stays with the submitted entry', async () => {
			const { f, field, typed, edits } = await start();
			const h = await holdAction();
			let asked = false, answered = null, paused = null;
			try {
				if (order === 'ask-then-save') {
					asked = await trigger(edits);
					await p.evaluate(`document.querySelector(${J(f.submit)})?.click()`);
					paused = await h.paused;
					answered = await answer('/discard/i');
				} else {
					await p.click(f.submit);
					paused = await h.paused;
					asked = await trigger(edits);
					answered = asked ? await answer('/discard/i') : null;
				}
				await sleep(150);
			} finally { await h.release(true); }
			await quiet();
			const o = await outcome(typed, field);
			const onPage = o.path === t.url;
			return { evidence: { url: t.url, edits, asked, answered, request: paused?.request?.url ?? null, ...o },
				checks: { requestHeld: !!paused, errorWithItsEntry: !onPage || o.errors.length === 0 || o.holds } };
		})) && ok;
		// leave the page settled for the next order (answer any open question, no pending input)
		await answer('/discard/i').catch(() => {});
	}
	return ok;
}

/** csv: every CSV download of the page (and a typed entry first, where the page has a form) is checked. */
async function csv(route, url, viewId, forms) {
	return scenario(`csv:${route}`, viewId, 'no formula starts unneutralised after ;, tab, CR or LF in any column of the export', async () => {
		await open(url + (QUERY[route] ? `?${QUERY[route]}` : ''));
		const typed = [];
		for (const f of (await p.evaluate(FORMS)).filter((x) => x.fields.length && forms.has(x.action))) {
			const filled = await fillForm(f.i, `(n, tag) => 'Synthetic ' + n + (tag === 'TEXTAREA' ? ${J(PAYLOAD)} : ${J(PAYLOAD.split('\r')[0])})`);
			await p.click(f.submit);
			await quiet();
			typed.push({ action: f.action, filled, errors: await errors() });
		}
		await p.evaluate('window.__downloads.length = 0');
		const controls = await p.evaluate(`[...document.querySelectorAll('main button, main a')].filter((e) => /export|csv/i.test((e.id || '') + ' ' + e.textContent) && e.offsetParent !== null && !e.disabled).map((e, i) => { e.dataset.ccX = String(i); return { sel: '[data-cc-x="' + i + '"]', id: e.id || null, text: e.textContent.trim().slice(0, 40) }; })`);
		for (const c of controls) { await p.click(c.sel); await sleep(300); }
		await p.waitFor('window.__downloads.length > 0', 5000).catch(() => {});
		await sleep(300);
		const files = (await p.evaluate('window.__downloads')).filter((d) => /\.csv$/i.test(d.name) || /csv/.test(d.type));
		const checked = files.map((d) => {
			const marks = [...d.text.matchAll(/[=+\-@"]CCX\(/g)];
			const bad = marks.filter((m) => /[;\t\r\n] *$/.test(d.text.slice(Math.max(0, m.index - 20), m.index)));
			return { name: d.name, bytes: d.text.length, marks: marks.length, bad: bad.length, sample: bad.slice(0, 3).map((m) => J(d.text.slice(Math.max(0, m.index - 30), m.index + 8))) };
		});
		return { evidence: { url, typed, controls, files: checked },
			checks: { exported: checked.length > 0, hostileReached: checked.every((c) => c.marks > 0), noFormula: checked.every((c) => c.bad === 0) } };
	});
}

/** The page's width at 320 and 390 px: its scroll width, what sticks out, and whether the 64-character id does. */
async function measure(url) {
	const layouts = {};
	try {
		for (const width of [320, 390]) {
			await p.s('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
			await open(url);
			layouts[width] = await p.evaluate(`(() => { const de = document.documentElement; const vw = de.clientWidth; const out = (e) => e.getBoundingClientRect().right > vw + 1 && getComputedStyle(e).position !== 'fixed';
				const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '');
				const holders = [...document.querySelectorAll('body *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes(${J(UNBROKEN)})) || (e.value ?? '').includes?.(${J(UNBROKEN)}));
				return { vw, scrollWidth: de.scrollWidth, wide: [...document.querySelectorAll('body *')].filter(out).slice(0, 3).map(name), idShown: holders.length > 0, idOut: holders.filter(out).map(name) }; })()`);
		}
	} finally { await p.s('Emulation.clearDeviceMetricsOverride').catch(() => {}); }
	return layouts;
}

/**
 * narrow: at 320 and 390 px the page of the 64-character id case does not scroll sideways; where the same page of
 * the short-id case is wider than the viewport too (a wide table), the id must not widen it further.
 */
async function narrow(t, base) {
	return scenario(`narrow:${t.route}${t.route.endsWith('[view]') ? ':' + t.view : ''}`, t.view, 'a 64-character case id without break opportunity does not make the page scroll sideways at 320 or 390 px', async () => {
		const layouts = await measure(t.url);
		const fits = Object.values(layouts).every((l) => l.scrollWidth <= l.vw);
		const short = fits ? null : await base();
		const sameAsShort = !!short && Object.entries(layouts).every(([w, l]) => l.scrollWidth <= Math.max(l.vw, short[w]?.scrollWidth ?? 0));
		return { evidence: { url: t.url, layouts, short, wideWithShortId: !fits && sameAsShort }, checks: { noSidewaysFromId: fits || sameAsShort } };
	});
}

/** back: Back to the page focuses an element of it; Back with typed input answered keep/stay returns focus to the field. */
async function back(t, form) {
	return scenario(`back:${t.route}${t.route.endsWith('[view]') ? ':' + t.view : ''}`, t.view, 'after Back to the page focus is on the page, never <body>; with typed input, keep or stay after Back returns focus to the typed field', async () => {
		await open(t.url);
		const away = await p.evaluate(`(() => { const a = [document.querySelector('#nav-overview'), ...document.querySelectorAll('nav a[href^="/"], main a[href^="/"]')].find((x) => x && new URL(x.href).pathname !== location.pathname && !x.target && !x.hasAttribute('download')); if (!a) return null; a.dataset.ccAway = '1'; return new URL(a.href).pathname; })()`);
		if (!away) return { evidence: { url: t.url }, checks: { linkAway: false } };
		await p.click('[data-cc-away]');
		await p.waitFor(`location.pathname !== ${J(t.url)}`, 15000);
		await settle();
		await p.evaluate('history.back()');
		await p.waitFor(`location.pathname === ${J(t.url)} && !!document.querySelector('main#main')`, 15000);
		await settle(); await sleep(150);
		const focus = await p.active();
		const onBody = await p.evaluate('document.activeElement === document.body || !document.activeElement');
		let guard = null;
		if (form) {
			const [f] = (await p.evaluate(FORMS)).filter((x) => x.action === form.action);
			const field = f?.fields.find((x) => !x.disabled);
			if (field) {
				await p.type(field.sel, 'Synthetic typed before Back');
				await p.evaluate('history.back()');
				const asked = await p.waitFor(`!![...document.querySelectorAll('[role=alertdialog], [role=dialog], dialog[open]')].find((e) => e.offsetParent !== null)`, 2000).then(() => true, () => false);
				if (asked) {
					const answered = await p.evaluate(`(() => { const d = [...document.querySelectorAll('[role=alertdialog], [role=dialog], dialog[open]')].find((e) => e.offsetParent !== null); const btn = [...d.querySelectorAll('button')].find((x) => /keep|stay/i.test(x.textContent)); btn?.focus(); btn?.click(); return btn?.id ?? null; })()`);
					await settle(); await sleep(150);
					guard = { asked, answered, path: await p.evaluate('location.pathname'), onField: await p.evaluate(`document.activeElement === document.querySelector(${J(field.sel)})`), focus: await p.active() };
				} else guard = { asked, path: await p.evaluate('location.pathname') };
			}
		}
		return { evidence: { url: t.url, away, focus, guard },
			checks: { focusOnPage: !onBody, keepReturnsFocus: !guard?.asked || (guard.path === t.url && guard.onField) } };
	});
}

// ---- run -----------------------------------------------------------------------------------------------------------

const offline = await proveOffline();
writeFileSync(join(OUT, 'offline.json'), J(offline, null, 1));
if (!offline.pass) { console.error('classes suite: not offline'); writeFileSync(join(OUT, 'summary.json'), J({ ok: false, offline: false, scenarios: [] })); process.exit(1); }
tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-classes-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
const t0 = Date.now();
let ok = false;
try {
	A = appServer({ name: 'classes', root: ROOT, buildDir: BUILD, port: 43800, origPort: 43801, dir: tmp, env: { CLEARCASE_FIXED_NOW: CLOCK, TZ: 'UTC' } });
	await A.start();
	const main = await buildCase(join(tmp, 'case'), { caseId: 'e2e-classes' });
	const imp = await A.c.importPkg(main.caseDir, main.pkgDir);
	await A.c.activate(imp.importId);
	const rv = await A.c.activeVersion();
	if (rv !== main.resultsVersion) throw new Error(`activation failed: ${J({ status: imp.status, id: imp.importId })}`);
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	await fresh();
	const pages = pagesOf(rv, imp.importId);
	// narrow: each page outside a case version at the short id, before a 64-character id is imported and listed
	const baseline = new Map();
	if (runs('narrow')) for (const t of pages.filter((x) => x.url && !x.url.startsWith('/v/') && !x.route.includes('['))) baseline.set(t.route, await measure(t.url));
	// the narrow case: the main case's data under a 64-character id without break opportunity (a candidate)
	const long = await buildCase(join(tmp, 'long'), { caseId: UNBROKEN });
	const limp = await A.c.importPkg(long.caseDir, long.pkgDir);
	if (!limp.importId) throw new Error(`64-character id import failed: ${limp.status} ${limp.location}`);
	// the hostile case: every free-text field of the workspace data carries the formula payload (a candidate)
	let hostileFields = 0;
	// (free text: letters and a space, not a path, URL or date; and the invoice numbers and bundle names, which the
	// quantum exports carry)
	const addPayload = (o) => { for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'string') { if ((/^(invoice_no|no|bundle)$/.test(k) && v) || (/[A-Za-z]{3,}/.test(v) && / /.test(v) && !/^(\.\/|https?:)/.test(v) && !/^\d{4}-\d\d/.test(v))) { o[k] = v + PAYLOAD; hostileFields++; } } else if (v && typeof v === 'object') addPayload(v); } };
	const hostile = await buildCase(join(tmp, 'hostile'), { caseId: 'e2e-classes-hostile', edit: (r) => addPayload(r.DATA) });
	const himp = await A.c.importPkg(hostile.caseDir, hostile.pkgDir);
	if (!himp.importId) throw new Error(`hostile import failed: ${himp.status} ${himp.location}`);
	console.log(`classes: the hostile case carries the formula payload in ${hostileFields} fields`);
	for (const t of pages.filter((x) => !x.url)) for (const c of ['narrow', 'back']) exclude(c, t.route, t.reason);
	const targets = await formTargets(pages);
	console.log(`classes: ${pages.length} pages, ${targets.length} forms (${targets.map((t) => t.key).join('; ')})`);
	const formOf = (route) => targets.find((t) => t.route === route && t.form.fields.length);

	for (const t of targets) {
		const textual = t.form.fields.length > 0 && !!t.form.submit;
		for (const c of ['inflight', 'nojs', 'dialog']) {
			if (!runs(c)) continue;
			if (na(t, c)) { exclude(c, t.key, na(t, c)); continue; }
			if (!textual) { exclude(c, t.key, t.form.submit ? 'the form has no typed field' : 'the form has no submit button'); continue; }
			if (c === 'inflight') { await inflight(t, 'ok'); await inflight(t, 'fail'); }
			if (c === 'nojs') await nojs(t);
			if (c === 'dialog') await dialog(t);
		}
	}

	if (runs('csv')) {
		const ex = csvExports(ROOT);
		const hpages = pagesOf(hostile.resultsVersion, himp.importId);
		// a server export counts for the page that requests it (its parent route)
		for (const s of ex.servers) { const parent = s.replace(/\/[^/]+$/, ''); if (!ex.pages.includes(parent)) await scenario(`csv:${s}`, s, 'a server CSV export is requested by a page that is checked', async () => ({ evidence: { parent }, checks: { pageChecked: false } })); }
		for (const route of ex.pages) {
			if (NOT_CSV[route]) { exclude('csv', route, NOT_CSV[route]); continue; }
			const t = hpages.find((x) => x.route === route);
			const actions = new Set(targets.filter((x) => x.route === route).map((x) => x.action));
			await csv(route, t.url, t.view, actions);
		}
	}
	if (runs('narrow')) for (const t of pagesOf(long.resultsVersion, limp.importId).filter((x) => x.url)) {
		const short = pages.find((x) => x.route === t.route && x.view === t.view);
		await narrow(t, () => baseline.get(t.route) ?? (short?.url ? measure(short.url) : null));
	}
	if (runs('back')) for (const t of pages.filter((x) => x.url)) {
		if (!t.url.startsWith('/v/')) { exclude('back', t.route, 'outside a case version there is no case navigation to leave by and come back'); continue; }
		const f = formOf(t.route);
		await back(t, f && !na(f, 'dialog') ? f : null);
	}
	ok = results.length > 0 && results.every((r) => r.pass);
} catch (e) {
	results.push({ id: 'HARNESS', view: '-', pass: false });
	writeFileSync(join(OUT, 'HARNESS.json'), J({ error: String(e?.stack ?? e).slice(0, 4000) }, null, 1));
	console.error(`FAIL    HARNESS ${String(e?.stack ?? e).slice(0, 2000)}`);
} finally {
	await b?.close().catch(() => {});
	await A?.stop().catch(() => {});
	if (tmp) rmSync(tmp, { recursive: true, force: true });
}
const byClass = Object.fromEntries(CLASSES.map((c) => [c, { pass: results.filter((r) => r.id.startsWith(c)).filter((r) => r.pass).length, fail: results.filter((r) => r.id.startsWith(c) && !r.pass).length, excluded: excluded.filter((x) => x.class === c).length }]));
writeFileSync(join(OUT, 'summary.json'), J({ ok, offline: true, clock: CLOCK, only: ONLY, ms: Date.now() - t0, byClass, excluded, scenarios: results }, null, 1));
console.log(`classes: ${results.filter((r) => r.pass).length} PASS, ${results.filter((r) => !r.pass).length} FAIL, ${excluded.length} not applicable in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${Object.entries(byClass).map(([c, n]) => `${c} ${n.pass}/${n.pass + n.fail} (${n.excluded} n/a)`).join(', ')} -> ${join(OUT, 'summary.json')}`);
process.exit(ok ? 0 : 1);
