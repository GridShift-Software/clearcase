#!/usr/bin/env bun
// Offline browser suite of the registers (GRS-17, CC-07), run by `bun run --bun test:e2e` in its own network namespace.
// It starts the production entry (bun scripts/pilot/start.ts) on ./build with a fresh data directory, the parity clock
// (CLEARCASE_FIXED_NOW=2026-10-08T09:00:00Z, TZ=UTC), imports and activates a synthetic case built by GRS-10's
// converter (tests/e2e/pilot/lib/fixtures.ts), and drives every register through Chromium: open, add, edit, delete,
// export, the overview tiles, a restart (SIGKILL and graceful) and failed writes caused from outside the app (a busy
// work.sqlite, a stopped server). Synthetic data only. Results: $CLEARCASE_E2E_OUT/registers/<scenario>.json and
// summary.json ({scenarios: [{id, view, pass}]}); synthetic screenshots under registers/screens/. Exit 0 only when every
// scenario passed.
process.env.CANARY_PORT ??= '43199';
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { Database } = await import('bun:sqlite');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { launch, sleep } = await import('../pilot/lib/cdp.mjs');
const { INIT, openPage } = await import('../pilot/suite/browser.mjs');
const { appServer, vpath } = await import('../pilot/suite/context.mjs');
const { startServer } = await import('../pilot/lib/server.mjs');
const { buildCase } = await import('../pilot/lib/fixtures.ts');
const { parseCsv, parseIcs } = await import('../../../scripts/parity/lib/exports.mjs');
const { VIEWS } = await import('../../../src/lib/components/view-registry.ts');

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..'));
const BUILD = join(ROOT, 'build');
const OUT = join(process.env.CLEARCASE_E2E_OUT ?? join(ROOT, '.local', 'e2e'), 'registers');
const SCREENS = join(OUT, 'screens');
mkdirSync(SCREENS, { recursive: true });
const CLOCK = '2026-10-08T09:00:00Z';
const J = JSON.stringify;
const REGISTER_VIEWS = ['disbursements_tab', 'timesheet_tab', 'deadlines_tab', 'privilege_tab', 'popia_tab', 'annotations_tab', 'transcriptions_tab'];
const LABEL = Object.fromEntries(VIEWS.map((v) => [v.id, v.label]));
const EMPTY = { disbursements_tab: 'No disbursements recorded.', timesheet_tab: 'No time recorded.', deadlines_tab: 'No deadlines yet.', privilege_tab: 'No privilege entries.', popia_tab: 'No POPIA records.', annotations_tab: 'No annotations yet.', transcriptions_tab: 'No transcripts stored.' };
const STORE = { disbursements_tab: 'disbursements', timesheet_tab: 'timesheet', deadlines_tab: 'deadlines', privilege_tab: 'privilege', popia_tab: 'popia', annotations_tab: 'annotations', transcriptions_tab: 'transcripts' };
const AUTOMATED = 'no-reply@synthetic.invalid';

const results = [];
/** One scenario: its checks (all must hold) and evidence, written to registers/<id>.json. */
async function scenario(id, view, title, fn) {
	const t0 = Date.now();
	let pass = false, evidence = {};
	try {
		const r = await fn();
		evidence = r;
		pass = Object.values(r.checks ?? {}).length > 0 && Object.values(r.checks).every((x) => x === true);
	} catch (e) { evidence = { error: String(e?.stack ?? e).slice(0, 4000) }; }
	results.push({ id, view, pass });
	writeFileSync(join(OUT, `${id}.json`), J({ id, view, title, pass, ms: Date.now() - t0, ...evidence }, null, 1));
	console.log(`${pass ? 'PASS' : 'FAIL'}    ${id} [${view}] ${title}`);
	return pass;
}

// ---- page helpers --------------------------------------------------------------------------------------------------

/** Downloads made through an <a download> blob link are kept as text in window.__downloads (test instrumentation). */
const HOOK = `(() => { window.__downloads = []; const C = URL.createObjectURL.bind(URL); const blobs = new Map();
	URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
	const click = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { o.text().then((t) => window.__downloads.push({ name: this.download, type: o.type, text: t })); return; } return click.call(this); };
})();`;

let p, A, rv, titleName, tmp, b;
const base = () => `${A.origin}${vpath(rv)}`;
const ready = (view) => `document.querySelector('main#main')?.dataset.ready === ${J(view)}`;
const rows = () => p.evaluate(`[...document.querySelectorAll('#register-table tbody tr[data-row-id]')].map((r) => ({ id: r.dataset.rowId, cells: [...r.cells].slice(0, -1).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()), link: r.cells[0]?.querySelector('a')?.getAttribute('href') ?? null, broken: !!r.cells[0]?.querySelector('.cite-broken') }))`);
const emptyRow = () => p.evaluate(`document.querySelector('#register-table tbody tr:not([data-row-id])')?.textContent.trim() ?? null`);
const fieldValues = () => p.evaluate(`Object.fromEntries([...document.querySelectorAll('#register-form [name]')].map((e) => [e.name, e.value]))`);
const errorText = () => p.evaluate(`document.getElementById('register-error')?.textContent.trim() ?? null`);
const openView = async (view) => { await p.goto(`${base()}/registers/${view}`, `${ready(view)} && !!document.querySelector('main#main[data-hydrated]')`); };
const screenshot = async (name) => { const r = await p.s('Page.captureScreenshot', { format: 'png' }); const f = join(SCREENS, `${name}.png`); writeFileSync(f, Buffer.from(r.data, 'base64')); return f; };

/** Fill fields by v5 key: text inputs and textareas are typed, dates and selects are set as a user agent does. */
async function fill(entry) {
	for (const [k, v] of Object.entries(entry)) {
		const kind = await p.evaluate(`(() => { const e = document.getElementById('in-${k}'); return e ? (e.tagName === 'SELECT' ? 'select' : e.type) : null; })()`);
		if (!kind) throw new Error(`no field ${k}`);
		if ((kind === 'text' || kind === 'textarea') && v !== '') await p.type(`#in-${k}`, v);
		else await p.evaluate(`(() => { const e = document.getElementById('in-${k}'); e.value = ${J(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
	}
}
const count = () => p.evaluate(`document.querySelectorAll('#register-table tbody tr[data-row-id]').length`);
/** Press Add (or Save while editing) and wait until the save finished: `n` rows, not editing, not busy, or an error. */
async function save(n) {
	await p.click('#register-save');
	await p.waitFor(`(document.querySelectorAll('#register-table tbody tr[data-row-id]').length === ${n} && !document.querySelector('#register-form[data-editing]') && !document.querySelector('#register-save[disabled]')) || !!document.getElementById('register-error')`, 30000);
	await sleep(50);
}
async function add(entry) { const n = await count(); await fill(entry); await save(n + 1); return rows(); }
async function del(rowId) { const n = await count(); await p.click(`#register-table tr[data-row-id="${rowId}"] [data-delete]`); await p.waitFor(`document.querySelectorAll('#register-table tbody tr[data-row-id]').length === ${n - 1} || !!document.getElementById('register-error')`, 30000); }
async function exportNow() {
	await p.evaluate('window.__downloads.length = 0');
	await p.click('#register-export');
	await p.waitFor('window.__downloads.length > 0', 5000);
	return p.evaluate('window.__downloads[0]');
}
/** The store's rows read from work.sqlite (read-only; the server keeps running). */
const stored = (store) => A.work('SELECT row_id, fields, anchor FROM register_row WHERE store = ? ORDER BY row_id', store).map((r) => ({ id: r.row_id, fields: JSON.parse(r.fields), anchor: r.anchor ? JSON.parse(r.anchor) : null }));
const tiles = async () => {
	await p.goto(`${base()}/overview`, ready('overview'));
	return p.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-slot]')].map((s) => [s.dataset.slot, { status: s.dataset.slotStatus, value: s.querySelector('.num')?.textContent.trim() ?? null, sub: s.querySelector('p:not(.num)')?.textContent.trim() ?? null }]))`);
};
async function clearView(view) { await openView(view); for (const r of await rows()) await del(r.id); return count(); }

// ---- run -----------------------------------------------------------------------------------------------------------

const offline = await proveOffline();
writeFileSync(join(OUT, 'offline.json'), J(offline, null, 1));
if (!offline.pass) { console.error('registers suite: not offline'); writeFileSync(join(OUT, 'summary.json'), J({ ok: false, offline: false, scenarios: [] })); process.exit(1); }
tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-registers-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
let ok = false;
try {
	A = appServer({ name: 'registers', root: ROOT, buildDir: BUILD, port: 43100, origPort: 43101, dir: tmp });
	// the pilot's restartable server, started with the parity clock and timezone
	A.start = async () => {
		A.srv = await startServer({ root: ROOT, port: A.port, origPort: A.origPort, dataDir: A.dataDir, buildDir: BUILD, logFile: A.logFile, env: { CLEARCASE_FIXED_NOW: CLOCK, TZ: 'UTC' } });
		A.starts.push({ pid: A.srv.pid, readyMs: Math.round(A.srv.readyMs) });
		return A.srv;
	};
	await A.start();
	const sc = await buildCase(join(tmp, 'case'), { caseId: 'e2e-registers', edit: (r) => { r.DATA.chronology.find((x) => x.ref === 'OD-002').sender = AUTOMATED; } });
	const imp = await A.c.importPkg(sc.caseDir, sc.pkgDir);
	const act = await A.c.activate(imp.importId);
	rv = await A.c.activeVersion();
	if (rv !== sc.resultsVersion) throw new Error(`activation failed: ${J({ imp: { status: imp.status, id: imp.importId }, act })}`);
	const manifest = JSON.parse(new TextDecoder().decode(sc.files.get('manifest.json')));
	const vc = sc.files.get('datasets/view-content.json');
	const shellTitle = vc ? JSON.parse(new TextDecoder().decode(vc)).data?._shell?.documentTitle : null;
	titleName = typeof shellTitle === 'string' && shellTitle.trim() ? shellTitle : manifest.case.label || manifest.case.id;
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	p = await openPage(b, { initScript: `${INIT};${HOOK}` });

	// 1. Each register's first state, reached from the overview's navigation: title, focused heading, empty state.
	for (const view of REGISTER_VIEWS) {
		await scenario(`SC1-${view}`, view, 'opened from the navigation: document title, heading focused, v5 empty state, Add and export controls, no unavailable state', async () => {
			await p.goto(`${base()}/overview`, ready('overview'));
			await p.click(`#nav-${view}`);
			await p.waitFor(`${ready(view)} && document.activeElement?.hasAttribute('data-page-heading')`, 15000);
			const s = await p.evaluate(`({ title: document.title, h1: document.querySelector('[data-page-heading]').textContent.trim(), focused: document.activeElement?.hasAttribute('data-page-heading') ?? false, current: document.querySelector('nav.views a[aria-current="page"]')?.id ?? null, unavailable: !!document.querySelector('[data-unavailable]'), add: document.getElementById('register-save')?.textContent.trim(), exp: document.getElementById('register-export')?.textContent.trim() })`);
			const empty = await emptyRow();
			return { evidence: { ...s, empty }, checks: { title: s.title === `${LABEL[view]} · ${titleName} · ClearCase`, heading: s.h1 === LABEL[view], focus: s.focused, current: s.current === `nav-${view}`, available: !s.unavailable, empty: empty === EMPTY[view], add: s.add === 'Add', export: s.exp === (view === 'deadlines_tab' ? 'Export .ics' : 'Export CSV') } };
		});
	}

	// 2. Create and edit a disbursement.
	await scenario('SC2', 'disbursements_tab', 'create a disbursement, edit it in place through the same form: one row, same id, new values; money shown as v5 formats it', async () => {
		await openView('disbursements_tab');
		await add({ date: '2026-10-01', desc: 'Synthetic courier', payee: 'Synthetic Couriers', amount: '1500' });
		const [r1] = await rows();
		await p.click(`#register-table tr[data-row-id="${r1.id}"] [data-edit]`);
		await p.waitFor(`document.getElementById('register-save').textContent.trim() === 'Save' && document.activeElement?.id === 'in-date'`, 5000);
		const editing = await fieldValues();
		await fill({ amount: '1750.5', desc: 'Synthetic courier, edited' });
		const shot = await screenshot('sc2-disbursement-edit');
		await save(1);
		const after = await rows();
		const db = stored('disbursements');
		await p.goto(`${base()}/registers/disbursements_tab`, ready('disbursements_tab'));
		const reloaded = await rows();
		return { evidence: { editing, after, db, shot },
			checks: { formLoaded: editing.amount === '1500' && editing.rowId === r1.id, oneRow: after.length === 1 && db.length === 1, sameId: after[0]?.id === r1.id && db[0]?.id === r1.id,
				cells: J(after[0]?.cells) === J(['2026-10-01', 'Synthetic courier, edited', 'Synthetic Couriers', 'R 1 750.50']), reload: J(reloaded) === J(after), addAgain: (await p.evaluate(`document.getElementById('register-save').textContent.trim()`)) === 'Add' } };
	});

	// 3. Record time and verify its value (and the corrected unbilled figure, S-overview-1).
	await scenario('SC3', 'timesheet_tab', "record time: Value = money(hours × rate); the overview's Unbilled time counts 'no' and blank, not 'yes' (S-overview-1)", async () => {
		await openView('timesheet_tab');
		await add({ date: '2026-10-05', fee_earner: 'Synthetic earner', activity: 'Synthetic drafting', hours: '2.5', rate: '1200', billed: 'no' });
		await add({ date: '2026-10-06', fee_earner: 'Synthetic earner', activity: 'Synthetic call', hours: '1', rate: '', billed: '' });
		await add({ date: '2026-10-07', fee_earner: 'Synthetic earner', activity: 'Synthetic billed', hours: '4', rate: '1000', billed: 'yes' });
		const r = await rows();
		const t = await tiles();
		return { evidence: { rows: r, tiles: t },
			checks: { value: r[0]?.cells[6] === 'R 3 000.00', zero: r[1]?.cells[6] === 'R 0.00', billed: r[2]?.cells[5] === 'yes' && r[2]?.cells[6] === 'R 4 000.00', unbilled: t['unbilled-time']?.status === 'filled' && t['unbilled-time']?.value === '3.5 h' && t['unbilled-time']?.sub === 'recorded, not yet billed' } };
	});

	// 4. Create deadlines and export the calendar; the countdown at the fixed clock; Delete on the shown row.
	await scenario('SC4', 'deadlines_tab', 'deadlines at the fixed clock (deadline-countdown-fixed-clock), Delete removes the shown row (deadline-delete-shown-row, S-deadlines_tab-1), RFC 5545 calendar export, Open deadlines tile', async () => {
		await openView('deadlines_tab');
		for (const [t, d] of [['E', '2026-10-16'], ['A', '2026-10-01'], ['C', '2026-10-08'], ['D', '2026-10-15'], ['B', '2026-10-07']]) await add({ title: `Synthetic ${t}`, date: d, note: '' });
		const shown = (await rows()).map((r) => [r.cells[2], r.cells[1]]);
		const tones = await p.evaluate(`[...document.querySelectorAll('#register-table tbody tr[data-row-id] td:nth-child(2) .chip')].map((c) => c.className.match(/tone-(\\w+)/)?.[1])`);
		const t = await tiles();
		await clearView('deadlines_tab');
		// expected example deadline-delete-shown-row: stored [later, earlier]; Delete on the first shown row (earlier)
		await add({ title: 'Synthetic later', date: '2026-12-03', cat: 'Filing', note: '' });
		await add({ title: 'Synthetic earlier', date: '2026-11-01', cat: 'Hearing', note: '' });
		const firstShown = (await rows())[0];
		await del(firstShown.id);
		const left = stored('deadlines').map((r) => ({ title: r.fields.title, date: r.fields.date, cat: r.fields.cat, note: r.fields.note }));
		await add({ title: 'Synthetic hearing, room 2; floor 1', date: '2026-11-20', cat: 'Hearing', note: 'bring\\files' });
		const ics = await exportNow();
		const parsed = parseIcs(ics.text);
		const ids = (await rows()).map((r) => r.id);
		const shot = await screenshot('sc4-deadlines');
		return { evidence: { shown, tones, tiles: t, firstShown: firstShown.cells, left, ics: { name: ics.name, type: ics.type, parsed }, shot },
			checks: {
				order: J(shown) === J([['Synthetic A', '7d ago'], ['Synthetic B', '1d ago'], ['Synthetic C', 'today'], ['Synthetic D', 'in 7d'], ['Synthetic E', 'in 8d']]),
				tones: J(tones) === J(['muted', 'muted', 'danger', 'warning', 'success']),
				openTile: t.deadlines?.status === 'filled' && t.deadlines?.value === '3' && t.deadlines?.sub === 'in the deadline tracker',
				deletedShown: firstShown.cells[2] === 'Synthetic earlier' && J(left) === J([{ title: 'Synthetic later', date: '2026-12-03', cat: 'Filing', note: '' }]),
				crlf: ics.text.endsWith('END:VCALENDAR\r\n') && !/[^\r]\n/.test(ics.text) && ics.name === 'deadlines.ics' && /text\/calendar/.test(ics.type),
				events: parsed.rows.length === 2 && parsed.columns.join(',') === 'DESCRIPTION,DTSTAMP,DTSTART,SUMMARY,UID',
				uids: J(parsed.rows.map((r) => r[4]).sort()) === J(ids.map((id) => `${id}@clearcase`).sort()),
				fields: parsed.rows.some((r) => r[3] === 'Synthetic hearing\\, room 2\\; floor 1' && r[0] === 'Hearing bring\\\\files' && r[2] === '20261120T090000' && r[1] === '20261008T090000Z'),
			} };
	});
	await clearView('deadlines_tab');
	await clearView('timesheet_tab');

	// 5. Edit privilege and POPIA records; a Doc ref naming a document links to it, one naming nothing renders broken.
	await scenario('SC5-privilege', 'privilege_tab', 'privilege entry added and edited in place; a ref naming an imported document links to its page and keeps an anchor; a missing ref renders broken, never matched loosely (S-privilege_tab-1)', async () => {
		await openView('privilege_tab');
		await add({ ref: 'OD-001', date: '2026-10-01', desc: 'Synthetic withheld agreement', basis: 'Legal advice' });
		await add({ ref: 'OD-01', date: '', desc: 'Synthetic near miss', basis: 'Other' });
		const [r1, r2] = await rows();
		await p.click(`#register-table tr[data-row-id="${r1.id}"] [data-edit]`);
		await fill({ basis: 'Litigation', desc: 'Synthetic withheld agreement, edited' });
		await save(2);
		const after = await rows();
		const db = stored('privilege');
		return { evidence: { after, db: db.map((r) => ({ id: r.id, ref: r.fields.ref, anchored: !!r.anchor })) },
			checks: { edited: J(after[0].cells) === J(['OD-001', '2026-10-01', 'Synthetic withheld agreement, edited', 'Litigation']) && after[0].id === r1.id,
				link: after[0].link === `${vpath(rv)}/doc/OD-001`, missing: after[1].link === null && after[1].broken && after[1].cells[0] === 'OD-01' && r2.id === after[1].id,
				anchor: db.find((r) => r.id === r1.id)?.anchor?.refAtCreation === 'OD-001' && db.find((r) => r.id === r2.id)?.anchor === null, typedKept: db.find((r) => r.id === r2.id)?.fields.ref === 'OD-01' } };
	});
	await scenario('SC5-popia', 'popia_tab', 'POPIA record added (one field is enough, v5) and edited in place', async () => {
		await openView('popia_tab');
		await add({ retention: 'Synthetic 5 years' });
		const [r1] = await rows();
		await p.click(`#register-table tr[data-row-id="${r1.id}"] [data-edit]`);
		await fill({ activity: 'Synthetic correspondence review', lawful: 'Synthetic legitimate interest' });
		await save(1);
		const after = await rows();
		return { evidence: { after }, checks: { saved: J(r1.cells) === J(['', '', '', 'Synthetic 5 years']), edited: J(after[0].cells) === J(['Synthetic correspondence review', '', 'Synthetic legitimate interest', 'Synthetic 5 years']) && after[0].id === r1.id } };
	});

	// 6. Add a document annotation and follow its ref to the document.
	await scenario('SC6', 'annotations_tab', 'annotation on a document: the ref links to the document page, the multi-line note is kept as typed; a missing ref renders broken (S-annotations_tab-1)', async () => {
		await openView('annotations_tab');
		await add({ ref: 'SD-001', date: '2026-10-02', note: 'Synthetic first line\nSynthetic second line' });
		await add({ ref: 'ZZ-404', date: '', note: 'Synthetic note on nothing' });
		const r = await rows();
		const db = stored('annotations');
		await p.click(`#register-table tr[data-row-id="${r[0].id}"] a`);
		await p.waitFor(`document.querySelector('main#main')?.dataset.ready === 'doc:SD-001'`, 15000);
		const doc = await p.evaluate(`({ path: location.pathname, h1: document.querySelector('[data-page-heading]')?.textContent.trim() })`);
		return { evidence: { rows: r, doc },
			checks: { link: r[0].link === `${vpath(rv)}/doc/SD-001` && doc.path === `${vpath(rv)}/doc/SD-001`, note: db.find((x) => x.id === r[0].id)?.fields.note === 'Synthetic first line\nSynthetic second line', broken: r[1].broken && r[1].link === null } };
	});

	// 7. Inspect and edit a transcript.
	await scenario('SC7', 'transcriptions_tab', 'transcript stored with its full text, shown whole, and its title edited in place', async () => {
		await openView('transcriptions_tab');
		const body = Array.from({ length: 40 }, (_, i) => `Synthetic line ${i + 1}: speaker says something.`).join('\n');
		await add({ title: 'Synthetic hearing', date: '2026-09-30', source: 'Synthetic recording', body });
		const [r1] = await rows();
		await p.click(`#register-table tr[data-row-id="${r1.id}"] [data-edit]`);
		const loaded = (await fieldValues()).body;
		await fill({ title: 'Synthetic hearing (day 1)' });
		await save(1);
		const after = await rows();
		const db = stored('transcripts');
		return { evidence: { cells: after[0].cells.map((c) => c.slice(0, 60)) }, checks: { whole: after[0].cells[3] === body.replace(/\s+/g, ' '), loaded: loaded === body, edited: after[0].cells[0] === 'Synthetic hearing (day 1)' && db[0].fields.body === body && db.length === 1 } };
	});

	// 8. Delete a controlled test record (the privilege ledger example), and the CSV export (S-csv).
	await scenario('SC8', 'privilege_tab', 'ledger-privilege-add-add-delete through the UI (an all-empty Add saves nothing); Delete removes exactly the chosen row; CSV keeps v5 columns, neutralises formulas and quotes commas and quotes', async () => {
		await clearView('privilege_tab');
		await add({ ref: 'OD-002', date: '2026-10-01', desc: 'Synthetic entry one', basis: 'Legal advice' });
		await p.click('#register-save'); await sleep(400);
		const afterEmpty = await count();
		await add({ ref: 'SD-010', date: '', desc: 'Synthetic entry two', basis: 'Litigation' });
		await del((await rows())[0].id);
		const left = stored('privilege').map((r) => ({ ref: r.fields.ref, date: r.fields.date, desc: r.fields.desc, basis: r.fields.basis }));
		// a browser turns a typed CR into a space, so a bare CR cannot come from the form; the CSV unit test covers it
		await add({ ref: '=HYPERLINK("x")', date: '', desc: 'Synthetic, "quoted"', basis: '' });
		const csv = await exportNow();
		const parsed = parseCsv(csv.text);
		return { evidence: { afterEmpty, left, csv: { name: csv.name, rows: parsed } },
			checks: { emptyIgnored: afterEmpty === 1, example: J(left) === '[{"ref":"SD-010","date":"","desc":"Synthetic entry two","basis":"Litigation"}]',
				csvHeader: J(parsed[0]) === J(['ref', 'date', 'desc', 'basis']) && csv.name === 'privilege.csv', csvRows: J(parsed.slice(1)) === J([['SD-010', '', 'Synthetic entry two', 'Litigation'], ["'=HYPERLINK(\"x\")", '', 'Synthetic, "quoted"', '']]),
				quoted: csv.text.includes('"\'=HYPERLINK(""x"")"') && csv.text.includes('"Synthetic, ""quoted"""') } };
	});

	// BA-07: an automated sender is never turned into a role or a privilege finding.
	await scenario('BA-07', 'privilege_tab', 'privilege entry on a document from an automated sender: the sender is shown exactly as imported, no role, attorney or privilege status is derived, the only basis is the one the user chose', async () => {
		await clearView('privilege_tab');
		await add({ ref: 'OD-002', date: '2026-10-03', desc: 'Synthetic automated notice', basis: 'Without prejudice' });
		const r = await rows();
		const page = await p.evaluate(`document.querySelector('#register-table').innerText + '\\n' + document.querySelector('.page-head').innerText`);
		const shot = await screenshot('ba07-privilege-automated-sender');
		await p.click(`#register-table tr[data-row-id="${r[0].id}"] a`);
		await p.waitFor(`document.querySelector('main#main')?.dataset.ready === 'doc:OD-002'`, 15000);
		const doc = await p.evaluate(`({ text: document.querySelector('main').innerText, from: [...document.querySelectorAll('main dt, main th')].find((e) => e.textContent.trim() === 'From')?.nextElementSibling?.textContent.trim() ?? null })`);
		const shotDoc = await screenshot('ba07-document-automated-sender');
		const words = /attorney|lawyer|advocate|counsel for|privileged|privilege status|verified role/i;
		return { evidence: { row: r[0].cells, from: doc.from, shots: [shot, shotDoc] },
			checks: { basis: r[0].cells[3] === 'Without prejudice', onlyBasis: r.length === 1 && J(r[0].cells) === J(['OD-002', '2026-10-03', 'Synthetic automated notice', 'Without prejudice']), senderExact: doc.from === AUTOMATED, noRolePage: !words.test(page), noRoleDoc: !words.test(doc.text) } };
	});

	// 10. Failed writes, caused from outside the app: a busy work.sqlite, then a stopped server.
	await scenario('SC10-busy', 'disbursements_tab', 'a save while work.sqlite is held busy (BEGIN IMMEDIATE, 13 s): the error is shown, every typed value is kept, nothing is written; after release one retry saves exactly one row', async () => {
		await clearView('disbursements_tab');
		const entry = { date: '2026-10-04', desc: 'Synthetic busy save', payee: 'Synthetic payee', amount: '99.95' };
		await fill(entry);
		const lock = new Database(join(A.dataDir, 'work.sqlite'));
		lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
		const t0 = Date.now();
		let during;
		try {
			await p.click('#register-save');
			await p.waitFor(`!!document.getElementById('register-error')`, 30000);
			during = { error: await errorText(), values: await fieldValues(), rows: await count(), ms: Date.now() - t0 };
			while (Date.now() - t0 < 13000) await sleep(100);
		} finally { lock.exec('ROLLBACK'); lock.close(); }
		const dbDuring = stored('disbursements').length;
		await save(1);
		const after = { rows: await rows(), error: await errorText(), db: stored('disbursements') };
		return { evidence: { during, after: { rows: after.rows, error: after.error } },
			checks: { errorShown: /not saved/.test(during.error ?? ''), kept: J({ date: during.values.date, desc: during.values.desc, payee: during.values.payee, amount: during.values.amount }) === J(entry), nothingWritten: during.rows === 0 && dbDuring === 0, retryOnce: after.db.length === 1 && after.rows.length === 1 && after.error === null && after.db[0].fields.desc === entry.desc } };
	});
	await scenario('SC10-transport', 'timesheet_tab', 'a save while the server is stopped: the error is shown, every typed value is kept, nothing is written; after a restart one retry saves exactly one row', async () => {
		await clearView('timesheet_tab');
		const entry = { date: '2026-10-04', fee_earner: 'Synthetic earner', activity: 'Synthetic offline save', hours: '1.5', rate: '900', billed: 'no' };
		await fill(entry);
		await A.stop();
		await p.click('#register-save');
		await p.waitFor(`!!document.getElementById('register-error')`, 30000);
		const during = { error: await errorText(), values: await fieldValues(), rows: await count() };
		await A.start();
		const dbDuring = stored('timesheet').length;
		await save(1);
		const after = { rows: await rows(), error: await errorText(), db: stored('timesheet') };
		const { rowId: _r, ...typed } = during.values;
		return { evidence: { during, after: { rows: after.rows, error: after.error } },
			checks: { errorShown: /could not be reached/.test(during.error ?? ''), kept: J(typed) === J(entry), nothingWritten: during.rows === 0 && dbDuring === 0, retryOnce: after.db.length === 1 && after.rows.length === 1 && after.error === null } };
	});

	// 9. Restart (SIGKILL, then graceful) and recover every saved entry, by id and fields, in every register.
	{
		await openView('deadlines_tab');
		await add({ title: 'Synthetic restart deadline', date: '2026-10-20', cat: 'Payment', note: 'kept' });
		await openView('transcriptions_tab');
		await add({ title: 'Synthetic second transcript', date: '', source: '', body: 'x' });
		const snapshot = () => Object.fromEntries(REGISTER_VIEWS.map((v) => [v, stored(STORE[v]).map((r) => J(r))]));
		const shown = async () => { const out = {}; for (const v of REGISTER_VIEWS) { await openView(v); out[v] = (await rows()).map((r) => [r.id, r.cells]); } return out; };
		const before = snapshot();
		const shownBefore = await shown();
		const killed = await A.srv.stop('SIGKILL');
		await A.start();
		const afterKill = snapshot();
		const shownKill = await shown();
		const graceful = await A.stop();
		await A.start();
		const afterGraceful = snapshot();
		const shownGraceful = await shown();
		for (const view of REGISTER_VIEWS) {
			await scenario(`SC9-${view}`, view, 'every saved entry recovered after a SIGKILL restart and after a graceful restart, by row id and fields, in the store and on the page', async () => ({
				evidence: { rows: before[view].length, killed: { graceful: killed.graceful }, gracefulStop: graceful.graceful },
				checks: { nonEmpty: before[view].length > 0, kill: J(afterKill[view]) === J(before[view]), gracefulRestart: J(afterGraceful[view]) === J(before[view]) && graceful.graceful === true,
					pageKill: J(shownKill[view]) === J(shownBefore[view]), pageGraceful: J(shownGraceful[view]) === J(shownBefore[view]) },
			}));
		}
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
const missing = REGISTER_VIEWS.filter((v) => !results.some((r) => r.view === v));
if (missing.length) ok = false;
writeFileSync(join(OUT, 'summary.json'), J({ ok, offline: true, clock: CLOCK, missing, scenarios: results }, null, 1));
console.log(`registers: ${results.filter((r) => r.pass).length} PASS, ${results.filter((r) => !r.pass).length} FAIL${missing.length ? `, views without a scenario: ${missing.join(', ')}` : ''} -> ${join(OUT, 'summary.json')}`);
process.exit(ok ? 0 : 1);
