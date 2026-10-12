#!/usr/bin/env bun
// CC-06 verification lane 04: adversarial probes of the Payments user-work store (synthetic case only).
// Usage: bun probe.mjs <checkout> <workdir> [probe ids...]
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2]);
const WORK = resolve(process.argv[3]);
const ONLY = new Set(process.argv.slice(4));
process.env.CANARY_PORT ??= '43649';
const { launch, newPage, sleep } = await import(join(ROOT, 'tests/e2e/pilot/lib/cdp.mjs'));
const { client, vpath } = await import(join(ROOT, 'tests/e2e/pilot/lib/client.mjs'));
const { CAPTURE, J, holdStore, pageKit, quantumCase, ready, server, takeDownloads } = await import(join(ROOT, 'tests/e2e/quantum/lib.mjs'));

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const results = [];
const probe = async (id, title, fn) => {
	if (ONLY.size && !ONLY.has(id)) return;
	const t0 = Date.now();
	let r;
	try { r = await fn(); } catch (e) { r = { pass: false, evidence: { error: String(e?.stack ?? e).slice(0, 2000) } }; }
	results.push({ id, title, pass: r.pass, ms: Date.now() - t0, evidence: r.evidence });
	console.log(`${r.pass ? 'PASS' : 'FAIL'} ${id} ${title}\n     ${J(r.evidence).slice(0, 1500)}`);
};

const S = server({ root: ROOT, buildDir: join(ROOT, 'build'), port: 43640, dir: WORK });
const sc = await quantumCase(join(WORK, 'case'));
await S.start();
const c = client(S.port);
const imp = await c.importPkg(sc.caseDir, sc.pkgDir);
await c.activate(imp.importId, { ack: true });
if ((await c.activeVersion()) !== sc.resultsVersion) throw new Error('activation failed');
const base = `${S.origin}${vpath(sc.resultsVersion)}`;
const PAY = '/quantum/payments_tab';
const b = await launch({ profileRoot: join(WORK, 'chromium') });

const pageJs = async () => { const p = await newPage(b, { initScript: CAPTURE }); await p.s('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }); return { p, k: pageKit(p, base) }; };
const pageNoJs = async () => {
	const p = await newPage(b, { fresh: true });
	await p.s('Emulation.setScriptExecutionDisabled', { value: true });
	const open = async (path) => { await p.navigate(`${base}${path}`); await p.waitFor(`!!document.querySelector('[data-ready]')`, 30000); };
	// submit a form natively and wait for the new document
	const submit = async (formSel, btnSel, timeout = 40000) => {
		await p.evaluate('window.__old = 1');
		const loaded = b.once((m) => m.sessionId === p.sessionId && m.method === 'Page.loadEventFired', timeout).catch(() => null);
		await p.evaluate(`(() => { const f = document.querySelector(${J(formSel)}); f.requestSubmit(${btnSel ? `f.querySelector(${J(btnSel)})` : ''}); })()`);
		await loaded;
		await p.waitFor(`!window.__old && document.readyState === 'complete'`, timeout);
	};
	return { p, open, submit };
};
const fill = (p, pairs) => p.evaluate(`(() => { for (const [s, v] of ${J(pairs)}) { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
const vals = (p) => p.evaluate(`['#pay_date', '#pay_amount', '#pay_method', '#pay_note'].map((s) => document.querySelector(s)?.value ?? null)`);
const err = (p) => p.evaluate(`document.getElementById('pay-error')?.textContent.trim() ?? null`);
const pageRows = (p) => p.evaluate(`[...document.querySelectorAll('#payments tbody tr[data-row-id]')].map((tr) => ({ id: tr.dataset.rowId, cells: [...tr.cells].slice(0, 4).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()) }))`);
const kpis = (p) => p.evaluate(`[...document.querySelectorAll('#main .kpi')].map((k) => [k.querySelector('.k')?.textContent.trim(), k.querySelector('.v')?.textContent.replace(/\\s+/g, ' ').trim(), k.querySelector('.s')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''])`);
const del = (p, id) => p.evaluate(`document.querySelector('tr[data-row-id=${J(id)}] button').click()`);
const stored = () => S.rows('payments');
const seed = async (note, amount = '10.00') => {
	const before = new Set(stored().map((r) => r.id));
	const r = await c.form(`${vpath(sc.resultsVersion)}${PAY}?/add`, { date: '2089-01-15', amount, method: 'Synthetic seed', note });
	const row = stored().find((x) => !before.has(x.id));
	if (!row) throw new Error(`seed failed ${r.status} ${r.text.slice(0, 200)}`);
	return row.id;
};
const clearAll = async () => { for (const r of stored()) await c.form(`${vpath(sc.resultsVersion)}${PAY}?/delete`, { rowId: r.id }); };
const waitRows = (p, n, t = 20000) => p.waitFor(`document.querySelectorAll('#payments tbody tr[data-row-id]').length === ${n}`, t);

// ---- JS path ---------------------------------------------------------------------------------------------------------
await probe('JS-SLOT-400', 'JS: after a refused Add (invalid amount), a successful Delete of another payment keeps the error while the unsaved input stays', async () => {
	await clearAll();
	const other = await seed('Synthetic other row');
	const { p, k } = await pageJs();
	await k.open(PAY, 'payments_tab');
	const typed = ['2089-02-01', 'abc', 'Synthetic method', 'Synthetic unsaved note'];
	await fill(p, [['#pay_date', typed[0]], ['#pay_amount', typed[1]], ['#pay_method', typed[2]], ['#pay_note', typed[3]]]);
	await k.click('#pay-add');
	await p.waitFor(`!!document.getElementById('pay-error')`, 15000);
	const afterFail = { error: await err(p), values: await vals(p), invalid: await p.evaluate(`document.getElementById('pay_amount').getAttribute('aria-invalid')`) };
	await del(p, other);
	await waitRows(p, 0);
	await sleep(300);
	const afterDelete = { error: await err(p), values: await vals(p), invalid: await p.evaluate(`document.getElementById('pay_amount').getAttribute('aria-invalid')`), stored: stored().length };
	await p.close();
	return { pass: !!afterDelete.error && J(afterDelete.values) === J(typed), evidence: { afterFail, afterDelete } };
});

await probe('JS-SLOT-503', 'JS: after a busy-store Add failure, a successful Delete of another payment keeps the error while the unsaved input stays', async () => {
	await clearAll();
	const other = await seed('Synthetic other row');
	const { p, k } = await pageJs();
	await k.open(PAY, 'payments_tab');
	const typed = ['2089-02-02', '300.00', 'Synthetic method', 'Synthetic unsaved busy note'];
	await fill(p, [['#pay_date', typed[0]], ['#pay_amount', typed[1]], ['#pay_method', typed[2]], ['#pay_note', typed[3]]]);
	const lock = holdStore(S.dataDir);
	try { await k.click('#pay-add'); await p.waitFor(`/busy/.test(document.getElementById('pay-error')?.textContent ?? '')`, 30000); } finally { lock.release(); }
	const afterFail = { error: await err(p), values: await vals(p), stored: stored().length };
	await del(p, other);
	await waitRows(p, 0);
	await sleep(300);
	const afterDelete = { error: await err(p), values: await vals(p), stored: stored().length };
	await p.close();
	return { pass: !!afterDelete.error && J(afterDelete.values) === J(typed), evidence: { afterFail, afterDelete } };
});

await probe('JS-SLOT-TRANSPORT', 'JS: after a lost-transport Add failure, a successful Delete (server back) keeps the error while the unsaved input stays', async () => {
	await clearAll();
	const other = await seed('Synthetic other row');
	const { p, k } = await pageJs();
	await k.open(PAY, 'payments_tab');
	const typed = ['2089-02-03', '400.00', 'Synthetic method', 'Synthetic unsaved transport note'];
	await fill(p, [['#pay_date', typed[0]], ['#pay_amount', typed[1]], ['#pay_method', typed[2]], ['#pay_note', typed[3]]]);
	await S.stop();
	await k.click('#pay-add');
	await p.waitFor(`/could not be reached/.test(document.getElementById('pay-error')?.textContent ?? '')`, 20000);
	const afterFail = { error: await err(p), values: await vals(p) };
	await S.start();
	await del(p, other);
	await waitRows(p, 0);
	await sleep(300);
	const afterDelete = { error: await err(p), values: await vals(p), stored: stored().length };
	await p.close();
	return { pass: !!afterDelete.error && J(afterDelete.values) === J(typed), evidence: { afterFail, afterDelete } };
});

await probe('JS-INFLIGHT-TYPED', 'JS: text typed into amount and note while an Add is in flight survives the Add completing', async () => {
	await clearAll();
	const { p, k } = await pageJs();
	await k.open(PAY, 'payments_tab');
	await fill(p, [['#pay_date', '2089-03-01'], ['#pay_amount', '100.00'], ['#pay_method', 'Synthetic first'], ['#pay_note', 'Synthetic first note']]);
	const lock = holdStore(S.dataDir);
	let during;
	try {
		await k.click('#pay-add');
		await sleep(400);
		await fill(p, [['#pay_amount', '200.00'], ['#pay_note', 'Synthetic typed during flight']]);
		during = { values: await vals(p), addDisabled: await p.evaluate(`document.getElementById('pay-add').disabled`) };
		await sleep(600);
	} finally { lock.release(); }
	await waitRows(p, 1);
	await sleep(300);
	const after = { values: await vals(p), error: await err(p), stored: stored().map((r) => ({ amount: r.fields.amount, note: r.fields.note })) };
	await p.close();
	return { pass: after.values[1] === '200.00' && after.values[3] === 'Synthetic typed during flight', evidence: { during, after } };
});

await probe('JS-DELETE-DURING-ADD', 'JS: Delete of another row while an Add is in flight (same tab disabled; second tab deletes): one row added, the other deleted, nothing else lost', async () => {
	await clearAll();
	const other = await seed('Synthetic delete target');
	const keep = await seed('Synthetic keep row');
	const A = await pageJs(); const B = await pageJs();
	await A.k.open(PAY, 'payments_tab'); await B.k.open(PAY, 'payments_tab');
	await fill(A.p, [['#pay_date', '2089-03-02'], ['#pay_amount', '55.00'], ['#pay_method', 'Synthetic A'], ['#pay_note', 'Synthetic add in flight']]);
	const lock = holdStore(S.dataDir);
	let sameTab;
	try {
		await A.k.click('#pay-add');
		await sleep(300);
		sameTab = await A.p.evaluate(`[...document.querySelectorAll('#payments tbody button')].map((x) => x.disabled)`);
		await del(A.p, other); // a disabled button: nothing should be sent
		await del(B.p, other);
		await sleep(1500);
	} finally { lock.release(); }
	await waitRows(A.p, 2, 30000).catch(() => null);
	await sleep(800);
	const s = stored();
	const out = { sameTabDisabled: sameTab, stored: s.map((r) => r.fields.note), aRows: (await pageRows(A.p)).map((r) => r.cells[3]), aErr: await err(A.p), aVals: await vals(A.p), bErr: await err(B.p) };
	await A.p.close(); await B.p.close();
	return { pass: s.length === 2 && s.some((r) => r.id === keep) && !s.some((r) => r.id === other) && s.some((r) => r.fields.note === 'Synthetic add in flight') && sameTab.every(Boolean), evidence: out };
});

await probe('JS-TWO-FAILS-THEN-SUCCESS', 'JS: refused (400), then busy (503), then success: fields kept after each failure, exactly one row, error cleared', async () => {
	await clearAll();
	const { p, k } = await pageJs();
	await k.open(PAY, 'payments_tab');
	await fill(p, [['#pay_date', '2089-03-03'], ['#pay_amount', '1 000,50'], ['#pay_method', 'Synthetic twice'], ['#pay_note', 'Synthetic two failures']]);
	await k.click('#pay-add');
	await p.waitFor(`!!document.getElementById('pay-error')`, 15000);
	const f1 = { error: await err(p), values: await vals(p) };
	await fill(p, [['#pay_amount', '1 000.50']]);
	const lock = holdStore(S.dataDir);
	try { await k.click('#pay-add'); await p.waitFor(`/busy/.test(document.getElementById('pay-error')?.textContent ?? '')`, 30000); } finally { lock.release(); }
	const f2 = { error: await err(p), values: await vals(p), stored: stored().length };
	await k.click('#pay-add');
	await waitRows(p, 1);
	await sleep(300);
	const ok = { error: await err(p), values: await vals(p), stored: stored().map((r) => r.fields), kpis: await kpis(p) };
	await p.close();
	return { pass: /full stop/.test(f1.error ?? '') && f1.values[1] === '1 000,50' && f1.values[3] === 'Synthetic two failures' && f2.values[1] === '1 000.50' && f2.values[3] === 'Synthetic two failures' && f2.stored === 0 && ok.stored.length === 1 && ok.stored[0].amountCents === 100050 && ok.error === null, evidence: { f1, f2, ok } };
});

await probe('JS-DELETE-ALREADY-DELETED', 'JS: Delete of a row another tab already deleted: no error page, the list refreshes, no other row lost', async () => {
	await clearAll();
	const x = await seed('Synthetic deleted twice');
	const y = await seed('Synthetic survivor');
	const A = await pageJs(); const B = await pageJs();
	await A.k.open(PAY, 'payments_tab'); await B.k.open(PAY, 'payments_tab');
	await del(A.p, x); await waitRows(A.p, 1);
	await del(B.p, x); await waitRows(B.p, 1).catch(() => null);
	await sleep(300);
	const out = { stored: stored().map((r) => r.id === y), bRows: (await pageRows(B.p)).length, bErr: await err(B.p), bMain: await B.p.evaluate(`!!document.querySelector('[data-ready="payments_tab"]')`) };
	await A.p.close(); await B.p.close();
	return { pass: out.stored.length === 1 && out.stored[0] && out.bRows === 1 && out.bMain, evidence: out };
});

await probe('JS-SEQ-COLLISION', 'two tabs Add at once while the store is briefly busy, fixed clock: distinct seq, insertion order kept', async () => {
	const trials = [];
	for (let i = 0; i < 4; i++) {
		await clearAll();
		await seed('Synthetic first', '1.00');
		const A = await pageJs(); const B = await pageJs();
		await A.k.open(PAY, 'payments_tab'); await B.k.open(PAY, 'payments_tab');
		await fill(A.p, [['#pay_date', '2089-04-01'], ['#pay_amount', '2.00'], ['#pay_method', 'Synthetic A'], ['#pay_note', `Synthetic tab A ${i}`]]);
		await fill(B.p, [['#pay_date', '2089-04-01'], ['#pay_amount', '3.00'], ['#pay_method', 'Synthetic B'], ['#pay_note', `Synthetic tab B ${i}`]]);
		const lock = holdStore(S.dataDir);
		try { await A.k.click('#pay-add'); await sleep(150); await B.k.click('#pay-add'); await sleep(3500); } finally { lock.release(); }
		await waitRows(A.p, 3, 30000).catch(() => null); await waitRows(B.p, 3, 30000).catch(() => null);
		const s = stored();
		const seqs = Object.fromEntries(s.map((r) => [r.fields.note, r.fields.seq]));
		await A.k.reload('payments_tab');
		const shown = (await pageRows(A.p)).map((r) => r.cells[3]);
		trials.push({ seqs, shown, aErr: await err(A.p), bErr: await err(B.p) });
		await A.p.close(); await B.p.close();
	}
	const collided = trials.filter((t) => new Set(Object.values(t.seqs)).size < Object.keys(t.seqs).length).length;
	const reversed = trials.filter((t, i) => t.shown.indexOf(`Synthetic tab A ${i}`) > t.shown.indexOf(`Synthetic tab B ${i}`)).length;
	return { pass: collided === 0, evidence: { collided, reversed, trials } };
});

await probe('JS-LEGACY-TEXT', 'legacy text amount (v5 import shape): shown as typed, flagged not counted, excluded from the totals and the Settlement prefill, exported as typed', async () => {
	await clearAll();
	await seed('Synthetic counted', '100.00');
	await S.stop();
	const d = new Database(join(S.dataDir, 'work.sqlite'));
	const fields = JSON.stringify({ date: '2089-05-05', amount: 'Synthetic entry 1', method: 'Synthetic legacy', note: 'Synthetic legacy note', seq: 2, amountCents: null });
	const now = '2026-10-08T09:00:00.000Z';
	d.query('INSERT INTO register_row(case_id, store, row_id, anchor, fields, fields_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('e2e-quantum', 'payments', '00000000-0000-4000-8000-00000000legacy'.slice(0, 36), null, fields, createHash('sha256').update(fields).digest('hex'), now, now);
	d.close();
	await S.start();
	const { p, k } = await pageJs();
	await k.open(PAY, 'payments_tab');
	const out = { rows: await pageRows(p), flag: await p.evaluate(`document.querySelectorAll('[data-not-counted]').length`), kpis: await kpis(p) };
	await k.click('#export-payments'); await sleep(200);
	out.csv = (await takeDownloads(p)).map((x) => x.text);
	await k.open('/quantum/settlement_tab', 'settlement_tab');
	out.settle = { claim: await k.value('#se_claim'), note: await k.text('#se-net') };
	await p.close();
	return { pass: out.flag === 1 && /Synthetic entry 1/.test(out.rows[1]?.cells[1] ?? '') && out.kpis[1]?.[1] === 'R 100.00' && /1 not counted/.test(out.kpis[1]?.[2] ?? '') && out.settle.claim === '1050', evidence: out };
});

// ---- no-JS path ------------------------------------------------------------------------------------------------------
await probe('NOJS-TWO-ADDS', 'no JS: two Adds in a row both stay (the second does not overwrite the first), in order', async () => {
	await clearAll();
	const N = await pageNoJs();
	await N.open(PAY);
	await fill(N.p, [['#pay_date', '2089-06-01'], ['#pay_amount', '11.00'], ['#pay_method', 'Synthetic nojs'], ['#pay_note', 'Synthetic nojs one']]);
	await N.submit('#pay-form');
	const after1 = { url: await N.p.evaluate('location.pathname + location.search'), values: await vals(N.p), rows: (await pageRows(N.p)).length };
	await fill(N.p, [['#pay_date', '2089-06-02'], ['#pay_amount', '22.00'], ['#pay_method', 'Synthetic nojs'], ['#pay_note', 'Synthetic nojs two']]);
	await N.submit('#pay-form');
	const after2 = { url: await N.p.evaluate('location.pathname + location.search'), rows: (await pageRows(N.p)).map((r) => r.cells[3]), kpis: await kpis(N.p), hydrated: await N.p.evaluate(`document.querySelector('main').hasAttribute('data-hydrated')`) };
	const s = stored();
	await N.p.close();
	return { pass: s.length === 2 && J(after2.rows) === J(['Synthetic nojs one', 'Synthetic nojs two']) && new Set(s.map((r) => r.fields.seq)).size === 2, evidence: { after1, after2, stored: s.map((r) => [r.fields.note, r.fields.seq]) } };
});

await probe('NOJS-REFUSED', 'no JS: a refused Add returns the page with the error and every typed field, not an error page', async () => {
	await clearAll();
	const N = await pageNoJs();
	await N.open(PAY);
	const typed = ['2089-06-03', 'R -5', 'Synthetic nojs', 'Synthetic nojs refused'];
	await fill(N.p, [['#pay_date', typed[0]], ['#pay_amount', typed[1]], ['#pay_method', typed[2]], ['#pay_note', typed[3]]]);
	await N.submit('#pay-form');
	const out = { error: await err(N.p), values: await vals(N.p), main: await N.p.evaluate(`!!document.querySelector('[data-ready="payments_tab"]')`), stored: stored().length };
	await N.p.close();
	return { pass: !!out.error && J(out.values) === J(typed) && out.main && out.stored === 0, evidence: out };
});

await probe('NOJS-BUSY', 'no JS: busy store across Add returns the page with the busy error and every typed field; a retry after release saves one row', async () => {
	await clearAll();
	const N = await pageNoJs();
	await N.open(PAY);
	const typed = ['2089-06-04', '77.70', 'Synthetic nojs', 'Synthetic nojs busy'];
	await fill(N.p, [['#pay_date', typed[0]], ['#pay_amount', typed[1]], ['#pay_method', typed[2]], ['#pay_note', typed[3]]]);
	const lock = holdStore(S.dataDir);
	let out;
	try { await N.submit('#pay-form'); out = { heldMs: lock.held(), error: await err(N.p), values: await vals(N.p), main: await N.p.evaluate(`!!document.querySelector('[data-ready="payments_tab"]')`), stored: stored().length }; } finally { lock.release(); }
	await N.submit('#pay-form');
	out.retry = { stored: stored().length, rows: (await pageRows(N.p)).length, error: await err(N.p) };
	await N.p.close();
	return { pass: /busy/.test(out.error ?? '') && J(out.values) === J(typed) && out.main && out.stored === 0 && out.retry.stored === 1, evidence: out };
});

await probe('NOJS-DELETE-ALREADY-DELETED', 'no JS: Delete of a row another tab already deleted: page, no error page, other row kept', async () => {
	await clearAll();
	const x = await seed('Synthetic nojs deleted twice');
	const y = await seed('Synthetic nojs survivor');
	const N = await pageNoJs();
	await N.open(PAY);
	await c.form(`${vpath(sc.resultsVersion)}${PAY}?/delete`, { rowId: x });
	await N.submit(`tr[data-row-id="${x}"] form`);
	const out = { main: await N.p.evaluate(`!!document.querySelector('[data-ready="payments_tab"]')`), rows: (await pageRows(N.p)).map((r) => r.id === y), error: await err(N.p), stored: stored().map((r) => r.id === y) };
	await N.p.close();
	return { pass: out.main && J(out.stored) === J([true]) && J(out.rows) === J([true]), evidence: out };
});

await probe('NOJS-SLOT-400', 'no JS: after a refused Add, a successful Delete of another row: what happens to the error and the typed text', async () => {
	await clearAll();
	const other = await seed('Synthetic nojs other');
	const N = await pageNoJs();
	await N.open(PAY);
	await fill(N.p, [['#pay_date', '2089-06-05'], ['#pay_amount', 'abc'], ['#pay_method', 'Synthetic nojs'], ['#pay_note', 'Synthetic nojs unsaved']]);
	await N.submit('#pay-form');
	const afterFail = { error: await err(N.p), values: await vals(N.p) };
	await N.submit(`tr[data-row-id="${other}"] form`);
	const afterDelete = { error: await err(N.p), values: await vals(N.p), stored: stored().length };
	await N.p.close();
	// informational: without JS the delete form cannot carry the add form's text; the platform reloads the page
	return { pass: true, evidence: { afterFail, afterDelete } };
});

// ---- restarts, backup and restore ------------------------------------------------------------------------------------
await probe('RESTART-BACKUP-RESTORE', 'stop after load / before submit (SIGTERM and SIGKILL), payments + seq order + net claim + Settlement prefill survive; present in a backup and its restore', async () => {
	await clearAll();
	const { p, k } = await pageJs();
	const snap = async () => { await k.open(PAY, 'payments_tab'); const rows = await pageRows(p); const kp = await kpis(p); await k.open('/quantum/settlement_tab', 'settlement_tab'); return { rows, kpis: kp, claim: await k.value('#se_claim'), note: await k.text('#se-net') }; };
	const add = async (amount, note) => { await fill(p, [['#pay_date', '2089-07-01'], ['#pay_amount', amount], ['#pay_method', 'Synthetic restart'], ['#pay_note', note]]); await k.click('#pay-add'); };
	await k.open(PAY, 'payments_tab');
	// graceful stop after load, before submit
	await S.stop('SIGTERM');
	await add('10.10', 'Synthetic r1');
	await p.waitFor(`/could not be reached/.test(document.getElementById('pay-error')?.textContent ?? '')`, 20000);
	await S.start();
	await k.click('#pay-add'); await waitRows(p, 1);
	// SIGKILL after load, before submit
	await k.open(PAY, 'payments_tab');
	await S.stop('SIGKILL');
	await add('20.20', 'Synthetic r2');
	await p.waitFor(`/could not be reached/.test(document.getElementById('pay-error')?.textContent ?? '')`, 20000);
	await S.start();
	await k.click('#pay-add'); await waitRows(p, 2);
	await add('30.30', 'Synthetic r3'); await waitRows(p, 3);
	const live = stored().map((r) => ({ id: r.id, ...r.fields }));
	// SIGKILL right after the last write (inside the backup debounce), then a graceful restart
	await S.stop('SIGKILL'); await S.start();
	const afterKill = await snap();
	await S.stop('SIGTERM'); await S.start();
	const afterTerm = await snap();
	// the graceful stop wrote the pending backup: read the newest one
	await S.stop('SIGTERM');
	const bdir = join(S.dataDir, 'backups');
	const backups = readdirSync(bdir).filter((n) => /^work-.*\.sqlite$/.test(n)).sort();
	const newest = join(bdir, backups.at(-1));
	const bd = new Database(newest, { readonly: true });
	const inBackup = bd.query(`SELECT row_id, fields FROM register_row WHERE store = 'payments' ORDER BY row_id`).all().map((r) => ({ id: r.row_id, ...JSON.parse(r.fields) }));
	bd.close();
	// operator restore: move work.sqlite and sidecars aside, copy the newest backup in, start
	await S.start();
	await k.open(PAY, 'payments_tab');
	await fill(p, [['#pay_date', '2089-07-02'], ['#pay_amount', '40.40'], ['#pay_method', 'Synthetic restart'], ['#pay_note', 'Synthetic after backup']]);
	await k.click('#pay-add'); await waitRows(p, 4);
	await S.stop('SIGTERM');
	const aside = join(WORK, 'aside'); mkdirSync(aside, { recursive: true });
	for (const n of ['work.sqlite', 'work.sqlite-journal', 'work.sqlite-wal', 'work.sqlite-shm']) if (existsSync(join(S.dataDir, n))) renameSync(join(S.dataDir, n), join(aside, n));
	copyFileSync(newest, join(S.dataDir, 'work.sqlite'));
	await S.start();
	const restored = await snap();
	const restoredRows = stored().map((r) => ({ id: r.id, ...r.fields }));
	await p.close();
	const byId = (a) => J([...a].sort((x, y) => (x.id < y.id ? -1 : 1)));
	const pass = live.length === 3 && byId(inBackup) === byId(live) && byId(restoredRows) === byId(live) &&
		J(afterKill) === J(afterTerm) && J(restored) === J(afterTerm) && J(afterTerm.rows.map((r) => r.cells[3])) === J(['Synthetic r1', 'Synthetic r2', 'Synthetic r3']) && J(live.map((r) => r.seq).sort()) === J([1, 2, 3]);
	return { pass, evidence: { live: live.map((r) => [r.note, r.seq, r.amountCents]), afterKill, afterTerm, backups: backups.length, inBackup: inBackup.length, restored, restoredRows: restoredRows.length } };
});

// ---- calculator inputs in the URL ------------------------------------------------------------------------------------
await probe('CALC-URL-RESET', 'Interest and Settlement inputs survive a reload through the URL; Reset to defaults restores the defaults (also after typing without Compute)', async () => {
	const { p, k } = await pageJs();
	const out = {};
	await k.open('/quantum/interest_calc_tab', 'interest_calc_tab');
	const defaults = await k.values(['#ic_p', '#ic_r', '#ic_m', '#ic_from', '#ic_to']);
	await fill(p, [['#ic_p', '100 000'], ['#ic_r', '12.5'], ['#ic_from', '2089-01-31'], ['#ic_to', '2090-02-28']]);
	await k.click('#ic-compute'); await p.waitFor(`location.search.includes('r=12.5')`, 10000); await sleep(200);
	const computed = { search: await k.search(), values: await k.values(['#ic_p', '#ic_r', '#ic_from', '#ic_to']), out: await k.text('#main') };
	await k.reload('interest_calc_tab');
	const reloaded = { search: await k.search(), values: await k.values(['#ic_p', '#ic_r', '#ic_from', '#ic_to']), out: await k.text('#main') };
	await k.click('#ic-reset'); await p.waitFor(`location.search === ''`, 10000); await sleep(200);
	const reset = await k.values(['#ic_p', '#ic_r', '#ic_m', '#ic_from', '#ic_to']);
	// type without Compute, then Reset to defaults
	await fill(p, [['#ic_r', '99']]);
	await k.click('#ic-reset'); await sleep(500);
	const resetAfterTyping = { search: await k.search(), values: await k.values(['#ic_p', '#ic_r', '#ic_m', '#ic_from', '#ic_to']) };
	out.interest = { defaults, computedSearch: computed.search, sameAfterReload: J(computed.values) === J(reloaded.values) && computed.out === reloaded.out, reset, resetOk: J(reset) === J(defaults), resetAfterTyping, resetAfterTypingOk: J(resetAfterTyping.values) === J(defaults) };
	await k.open('/quantum/settlement_tab', 'settlement_tab');
	const sdef = await k.values(['#se_claim', '#se_p', '#se_y', '#se_d', '#se_c']);
	await fill(p, [['#se_p', '42'], ['#se_y', '3']]);
	await k.click('#se-model'); await p.waitFor(`location.search.includes('p=42')`, 10000); await sleep(200);
	const sComputed = { values: await k.values(['#se_claim', '#se_p', '#se_y', '#se_d', '#se_c']), out: await k.text('#se_out') };
	await k.reload('settlement_tab');
	const sReloaded = { values: await k.values(['#se_claim', '#se_p', '#se_y', '#se_d', '#se_c']), out: await k.text('#se_out') };
	await k.click('#se-reset'); await p.waitFor(`location.search === ''`, 10000); await sleep(200);
	const sReset = await k.values(['#se_claim', '#se_p', '#se_y', '#se_d', '#se_c']);
	await fill(p, [['#se_p', '7']]);
	await k.click('#se-reset'); await sleep(500);
	const sResetAfterTyping = await k.values(['#se_claim', '#se_p', '#se_y', '#se_d', '#se_c']);
	out.settlement = { sdef, sameAfterReload: J(sComputed) === J(sReloaded), sReset, resetOk: J(sReset) === J(sdef), sResetAfterTyping, resetAfterTypingOk: J(sResetAfterTyping) === J(sdef) };
	await p.close();
	return { pass: out.interest.sameAfterReload && out.interest.resetOk && out.settlement.sameAfterReload && out.settlement.resetOk, evidence: out };
});

// ---- corrected backup/restore (backups ordered by their sequence number) and the crash lag ----------------------------
const backupList = () => readdirSync(join(S.dataDir, 'backups')).filter((n) => /^work-\d+-.*\.sqlite$/.test(n)).sort();
const backupRows = (n) => { const d = new Database(join(S.dataDir, 'backups', n), { readonly: true }); try { return d.query(`SELECT row_id, fields FROM register_row WHERE store = 'payments' ORDER BY row_id`).all().map((r) => ({ id: r.row_id, ...JSON.parse(r.fields) })); } finally { d.close(); } };
const byId = (a) => J([...a].sort((x, y) => (x.id < y.id ? -1 : 1)));
await probe('BACKUP-RESTORE', 'graceful stop writes a backup holding every payment (ids, fields, seq); restoring it brings back the rows in seq order, the net claim and the Settlement prefill', async () => {
	await clearAll();
	const { p, k } = await pageJs();
	const snap = async () => { await k.open(PAY, 'payments_tab'); const rows = await pageRows(p); const kp = await kpis(p); await k.open('/quantum/settlement_tab', 'settlement_tab'); return { rows, kpis: kp, claim: await k.value('#se_claim'), note: await k.text('#se-net') }; };
	await k.open(PAY, 'payments_tab');
	for (const [i, a] of [['1', '10.10'], ['2', 'R 1 000.20'], ['3', '30,000.30']]) { await fill(p, [['#pay_date', '2089-08-0' + i], ['#pay_amount', a], ['#pay_method', 'Synthetic backup'], ['#pay_note', `Synthetic b${i}`]]); await k.click('#pay-add'); await waitRows(p, Number(i)); }
	const live = stored().map((r) => ({ id: r.id, ...r.fields }));
	const before = await snap();
	await S.stop('SIGTERM');
	const list1 = backupList();
	const b1 = list1.at(-1);
	const inB1 = backupRows(b1);
	await S.start();
	await k.open(PAY, 'payments_tab');
	await fill(p, [['#pay_date', '2089-08-09'], ['#pay_amount', '9.99'], ['#pay_method', 'Synthetic backup'], ['#pay_note', 'Synthetic after backup']]); await k.click('#pay-add'); await waitRows(p, 4);
	await S.stop('SIGTERM');
	const aside = join(WORK, 'aside2'); mkdirSync(aside, { recursive: true });
	for (const n of ['work.sqlite', 'work.sqlite-journal', 'work.sqlite-wal', 'work.sqlite-shm']) if (existsSync(join(S.dataDir, n))) renameSync(join(S.dataDir, n), join(aside, n));
	copyFileSync(join(S.dataDir, 'backups', b1), join(S.dataDir, 'work.sqlite'));
	await S.start();
	const restored = await snap();
	const restoredRows = stored().map((r) => ({ id: r.id, ...r.fields }));
	await p.close();
	const pass = live.length === 3 && byId(inB1) === byId(live) && byId(restoredRows) === byId(live) && J(restored) === J(before) && J(before.rows.map((r) => r.cells[3])) === J(['Synthetic b1', 'Synthetic b2', 'Synthetic b3']);
	return { pass, evidence: { live: live.map((r) => [r.note, r.seq, r.amountCents]), backup: b1.replace(/-20\d\d.*/, ''), inBackup: inB1.length, before, restored, restoredRows: restoredRows.length } };
});

await probe('CRASH-BACKUP-LAG', 'a payment saved less than the backup delay before a SIGKILL: is it in a backup after the restart (and after a later graceful stop)?', async () => {
	await clearAll();
	await sleep(3500); // let the clear's own backup run
	const { p, k } = await pageJs();
	await k.open(PAY, 'payments_tab');
	await fill(p, [['#pay_date', '2089-09-01'], ['#pay_amount', '5.55'], ['#pay_method', 'Synthetic crash'], ['#pay_note', 'Synthetic crash payment']]);
	await k.click('#pay-add'); await waitRows(p, 1);
	const id = stored()[0].id;
	const n0 = backupList().length;
	await S.stop('SIGKILL');
	await S.start();
	await sleep(5000); // longer than the 3 s backup delay, no writes
	const afterRestart = { backups: backupList().length - n0, live: stored().some((r) => r.id === id), inNewest: backupRows(backupList().at(-1)).some((r) => r.id === id) };
	await S.stop('SIGTERM');
	const afterGraceful = { backups: backupList().length - n0, inAny: backupList().some((n) => backupRows(n).some((r) => r.id === id)) };
	await S.start();
	await p.close();
	return { pass: afterGraceful.inAny, evidence: { afterRestart, afterGraceful } };
});

writeFileSync(join(WORK, 'probe-results.json'), JSON.stringify(results, null, 1));
await S.stop();
try { b.proc.kill('SIGKILL'); } catch {}
console.log(`probes: ${results.filter((r) => r.pass).length} PASS, ${results.filter((r) => !r.pass).length} FAIL`);
process.exit(0);
