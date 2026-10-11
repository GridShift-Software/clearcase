// CC-06 r2 scenarios of the quantum browser suite (GRS-16), run by suite.mjs after its own scenarios on the same
// server and synthetic case. Payments: one failure slot per action, text typed while a save is in flight, two tabs
// adding under a busy store, a Delete of a changed or gone row, leaving the page, with and without JavaScript (D1 to
// D4, D8, D18, and lane 04's passing scenarios). The calculators: results too large to show, years outside 1000 to
// 9999, bounds, Settlement after an overpayment, Reset, and a field typed while Compute is in flight (D4 to D7, D10,
// D11, D17). Prescription: a URL filter the controls cannot show, the filter without JavaScript, same-route navigation,
// the South African as-of date (D9, D12, D19). Links by ref and broken unknown refs (D13). Failures are caused from
// outside the app: the store held with BEGIN IMMEDIATE, the server stopped, a response held with CDP Fetch, the clock
// and time zone of the server process.
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { newPage, sleep } from '../pilot/lib/cdp.mjs';
import { buildCase } from '../pilot/lib/fixtures.ts';
import { vpath } from '../pilot/lib/client.mjs';
import { EXPORT_NAME_NOTE } from '../../../src/lib/local-case/results.server.ts';
import { CAPTURE, J, fieldsHash, holdStore, pageKit, ready, rewriteRow, takeDownloads } from './lib.mjs';

export async function r2({ b, S, sc, c, scenario, base, route }) {
	const PAY = route('payments_tab');
	const VP = vpath(sc.resultsVersion);
	const stored = () => S.rows('payments');
	const clearAll = async () => { for (const r of stored()) await c.form(`${VP}${PAY}?/delete`, { rowId: r.id, [`hash.${r.id}`]: fieldsHash(r.fields) }); if (stored().length) throw new Error('clean-up failed'); };
	const seed = async (note, amount = '10.00') => {
		const before = new Set(stored().map((r) => r.id));
		const r = await c.form(`${VP}${PAY}?/add`, { date: '2089-01-15', amount, method: 'Synthetic seed', note });
		const row = stored().find((x) => !before.has(x.id));
		if (!row) throw new Error(`seed failed ${r.status}`);
		return row.id;
	};
	const js = async () => { const p = await newPage(b, { initScript: CAPTURE }); await p.s('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }); return { p, k: pageKit(p, base) }; };
	const nojs = async () => {
		const p = await newPage(b, { fresh: true });
		await p.s('Emulation.setScriptExecutionDisabled', { value: true });
		const open = async (path) => { await p.navigate(`${base}${path}`); await p.waitFor(`!!document.querySelector('[data-ready]')`, 30000); };
		/** run `expr` (a native submit) and wait for the answering document */
		const submit = async (expr, timeout = 40000) => {
			await p.evaluate('window.__old = 1');
			const loaded = b.once((m) => m.sessionId === p.sessionId && m.method === 'Page.loadEventFired', timeout).catch(() => null);
			await p.evaluate(expr);
			await loaded;
			await p.waitFor(`!window.__old && document.readyState === 'complete'`, timeout);
		};
		return { p, k: pageKit(p, base), open, submit };
	};
	const fill = (p, pairs) => p.evaluate(`(() => { for (const [s, v] of ${J(pairs)}) { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
	const FIELDS = ['#pay_date', '#pay_amount', '#pay_method', '#pay_note'];
	const vals = (p) => p.evaluate(`${J(FIELDS)}.map((s) => document.querySelector(s)?.value ?? null)`);
	const err = (p) => p.evaluate(`document.getElementById('pay-error')?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
	const invalid = (p, id) => p.evaluate(`document.getElementById(${J(id)})?.getAttribute('aria-invalid') ?? null`);
	const rowErr = (p, id) => p.evaluate(`document.querySelector('[data-delete-error=${J(id)}]')?.textContent.trim() ?? null`);
	const shownRows = (p) => p.evaluate(`[...document.querySelectorAll('#payments tbody tr[data-row-id]')].map((tr) => ({ id: tr.dataset.rowId, cells: [...tr.cells].slice(0, 4).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()) }))`);
	const del = (p, id) => p.evaluate(`document.querySelector('tr[data-row-id=${J(id)}] button[data-delete]').click()`);
	const waitRows = (p, n, t = 20000) => p.waitFor(`document.querySelectorAll('#payments tbody tr[data-row-id]').length === ${n}`, t);
	const gone = (p, id, t = 20000) => p.waitFor(`!document.querySelector('tr[data-row-id=${J(id)}]')`, t);
	const typedA = [['#pay_date', '2089-02-01'], ['#pay_amount', 'abc'], ['#pay_method', 'Synthetic slot'], ['#pay_note', 'Synthetic refused note']];
	const valid = [['#pay_date', '2089-02-02'], ['#pay_amount', '12.34'], ['#pay_method', 'Synthetic slot'], ['#pay_note', 'Synthetic unsaved note']];
	const V = (pairs) => pairs.map(([, v]) => v);
	/** a nojs Delete: the row's button submits the Add form with formaction ?/delete */
	const nojsDel = (id) => `(() => { const f = document.getElementById('pay-form'); f.requestSubmit(document.querySelector('tr[data-row-id=${J(id)}] button[data-delete]')); })()`;
	const nojsAdd = `document.getElementById('pay-form').requestSubmit(document.getElementById('pay-add'))`;

	// ---- D1: one failure slot per action -------------------------------------------------------------------------------
	await scenario('Q-R2-D1-SLOT-400', 'payments_tab', 'JS: a refused Add keeps its error, aria-invalid and entry through a successful Delete of another payment', async () => {
		await clearAll();
		const x = await seed('Synthetic delete target');
		const { p, k } = await js();
		try {
			await k.open(PAY, 'payments_tab');
			await fill(p, typedA);
			await k.click('#pay-add');
			await p.waitFor(`!!document.getElementById('pay-error')`, 15000);
			const before = await err(p);
			await del(p, x);
			await gone(p, x);
			await sleep(200);
			const after = { error: await err(p), invalid: await invalid(p, 'pay_amount'), values: await vals(p), stored: stored().length };
			return { pass: /Not an amount/.test(before ?? '') && after.error === before && after.invalid === 'true' && J(after.values) === J(V(typedA)) && after.stored === 0, evidence: { before, after } };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-D1-SLOT-503', 'payments_tab', 'JS: an Add refused by a busy store keeps its error and Retry through another payment\'s Delete; Retry then saves it', async () => {
		await clearAll();
		const x = await seed('Synthetic delete target');
		const { p, k } = await js();
		try {
			await k.open(PAY, 'payments_tab');
			await fill(p, valid);
			const lock = holdStore(S.dataDir);
			try { await k.click('#pay-add'); await p.waitFor(`/busy/.test(document.getElementById('pay-error')?.textContent ?? '')`, 30000); } finally { lock.release(); }
			const before = await err(p);
			await del(p, x);
			await gone(p, x);
			await sleep(200);
			const after = { error: await err(p), retry: await k.exists('#pay-retry'), values: await vals(p), stored: stored().length };
			await k.click('#pay-retry');
			await waitRows(p, 1);
			await sleep(200);
			const retried = { error: await err(p), values: await vals(p), stored: stored().map((r) => r.fields.note) };
			return { pass: after.error === before && after.retry && J(after.values) === J(V(valid)) && after.stored === 0 && retried.error === null && J(retried.stored) === J(['Synthetic unsaved note']) && J(retried.values) === J(['', '', '', '']), evidence: { before, after, retried } };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-D1-SLOT-TRANSPORT', 'payments_tab', 'JS: an Add lost to a stopped server keeps its error through another payment\'s Delete after the restart', async () => {
		await clearAll();
		const x = await seed('Synthetic delete target');
		const { p, k } = await js();
		try {
			await k.open(PAY, 'payments_tab');
			await fill(p, valid);
			await S.stop();
			await k.click('#pay-add');
			await p.waitFor(`/could not be reached/.test(document.getElementById('pay-error')?.textContent ?? '')`, 20000);
			const before = await err(p);
			await S.start();
			await del(p, x);
			await gone(p, x);
			await sleep(200);
			const after = { error: await err(p), values: await vals(p), stored: stored().length };
			return { pass: after.error === before && J(after.values) === J(V(valid)) && after.stored === 0, evidence: { before, after } };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-DELETE-ERROR-BY-ROW', 'payments_tab', 'JS: a Delete refused by a busy store shows by its row, not as an Add error, and a later successful Add does not clear it', async () => {
		await clearAll();
		const x = await seed('Synthetic busy delete');
		const { p, k } = await js();
		try {
			await k.open(PAY, 'payments_tab');
			const lock = holdStore(S.dataDir);
			try { await del(p, x); await p.waitFor(`!!document.querySelector('[data-delete-error=${J(x)}]')`, 30000); } finally { lock.release(); }
			const failed = { row: await rowErr(p, x), addError: await err(p) };
			await fill(p, valid);
			await k.click('#pay-add');
			await waitRows(p, 2);
			await sleep(200);
			const after = { row: await rowErr(p, x), addError: await err(p), stored: stored().length };
			return { pass: /^Not deleted: the workspace store is busy/.test(failed.row ?? '') && failed.addError === null && after.row === failed.row && after.addError === null && after.stored === 2, evidence: { failed, after } };
		} finally { await p.close(); }
	});

	// ---- D2: text typed while a save is in flight --------------------------------------------------------------------
	await scenario('Q-R2-D2-INFLIGHT-ADD', 'payments_tab', 'JS: text typed while an Add is in flight survives its success; only the untouched fields clear; the busy state is a status line', async () => {
		await clearAll();
		const { p, k } = await js();
		try {
			await k.open(PAY, 'payments_tab');
			await fill(p, [['#pay_date', '2089-03-01'], ['#pay_amount', '100.00'], ['#pay_method', 'Synthetic first'], ['#pay_note', 'Synthetic first note']]);
			const lock = holdStore(S.dataDir);
			let during;
			try {
				await k.click('#pay-add');
				await sleep(400);
				await fill(p, [['#pay_amount', '200.00'], ['#pay_note', 'Synthetic typed during flight']]);
				during = { status: await k.text('#pay-status'), addDisabled: await p.evaluate(`document.getElementById('pay-add').disabled`), busy: await p.evaluate(`document.getElementById('pay-form').getAttribute('aria-busy')`) };
				await sleep(1200);
			} finally { lock.release(); }
			await waitRows(p, 1);
			await sleep(300);
			const after = { values: await vals(p), error: await err(p), status: await k.exists('#pay-status'), stored: stored().map((r) => [r.fields.amount, r.fields.note]) };
			return { pass: /^Saving the payment/.test(during.status ?? '') && during.addDisabled && during.busy === 'true' && J(after.values) === J(['', '200.00', '', 'Synthetic typed during flight']) && after.error === null && !after.status && J(after.stored) === J([['100.00', 'Synthetic first note']]), evidence: { during, after } };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-D2-INFLIGHT-DELETE', 'payments_tab', 'JS: an entry typed while a Delete is in flight survives that Delete\'s success', async () => {
		await clearAll();
		const x = await seed('Synthetic delete target');
		const { p, k } = await js();
		try {
			await k.open(PAY, 'payments_tab');
			const lock = holdStore(S.dataDir);
			try { await del(p, x); await sleep(300); await fill(p, valid); await sleep(800); } finally { lock.release(); }
			await gone(p, x);
			await sleep(200);
			const after = { values: await vals(p), error: await err(p), stored: stored().length };
			return { pass: J(after.values) === J(V(valid)) && after.error === null && after.stored === 0, evidence: after };
		} finally { await p.close(); }
	});

	// ---- D3: two tabs adding under a busy store ----------------------------------------------------------------------
	await scenario('Q-R2-D3-SEQ', 'payments_tab', 'two tabs Add while the store is busy (fixed clock): distinct seq in submission order, both rows kept, the order shown after a reload is A then B (2 trials)', async () => {
		const trials = [];
		for (let i = 0; i < 2; i++) {
			await clearAll();
			await seed('Synthetic first', '1.00');
			const A = await js(), B = await js();
			try {
				await A.k.open(PAY, 'payments_tab'); await B.k.open(PAY, 'payments_tab');
				await fill(A.p, [['#pay_date', '2089-04-01'], ['#pay_amount', '2.00'], ['#pay_method', 'Synthetic A'], ['#pay_note', `Synthetic tab A ${i}`]]);
				await fill(B.p, [['#pay_date', '2089-04-01'], ['#pay_amount', '3.00'], ['#pay_method', 'Synthetic B'], ['#pay_note', `Synthetic tab B ${i}`]]);
				const lock = holdStore(S.dataDir);
				try { await A.k.click('#pay-add'); await sleep(150); await B.k.click('#pay-add'); await sleep(3500); } finally { lock.release(); }
				await waitRows(A.p, 3, 30000).catch(() => null); await waitRows(B.p, 3, 30000).catch(() => null);
				const seqs = stored().map((r) => [r.fields.note, r.fields.seq]).sort((a, b2) => a[1] - b2[1]);
				await A.k.reload('payments_tab');
				trials.push({ seqs, shown: (await shownRows(A.p)).map((r) => r.cells[3]) });
			} finally { await A.p.close(); await B.p.close(); }
		}
		const ok = trials.every((t, i) => J(t.seqs) === J([['Synthetic first', 1], [`Synthetic tab A ${i}`, 2], [`Synthetic tab B ${i}`, 3]]) && J(t.shown) === J(['Synthetic first', `Synthetic tab A ${i}`, `Synthetic tab B ${i}`]));
		return { pass: ok, evidence: { trials } };
	});

	// ---- the Delete recheck: changed elsewhere (409), already gone ------------------------------------------------------
	await scenario('Q-R2-DELETE-CHANGED', 'payments_tab', 'JS: Delete of a payment whose stored fields changed since the page showed them (a restore) is refused by its row; the row stays and shows as stored', async () => {
		await clearAll();
		const x = await seed('Synthetic before restore');
		const { p, k } = await js();
		try {
			await k.open(PAY, 'payments_tab');
			rewriteRow(S.dataDir, x, { note: 'Synthetic restored note' });
			await del(p, x);
			await p.waitFor(`!!document.querySelector('[data-delete-error=${J(x)}]')`, 15000);
			await sleep(200);
			const r = { row: await rowErr(p, x), shown: (await shownRows(p)).map((s) => s.cells[3]), stored: stored().map((s) => s.fields.note), addError: await err(p) };
			return { pass: /^Not deleted: this payment changed since the page showed it/.test(r.row ?? '') && J(r.shown) === J(['Synthetic restored note']) && J(r.stored) === J(['Synthetic restored note']) && r.addError === null, evidence: r };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-DELETE-GONE', 'payments_tab', 'JS (lane 04 JS-DELETE-ALREADY-DELETED): Delete of a payment another tab deleted says so, with no error page, and loses nothing else', async () => {
		await clearAll();
		const x = await seed('Synthetic deleted twice');
		const y = await seed('Synthetic survivor');
		const A = await js(), B = await js();
		try {
			await A.k.open(PAY, 'payments_tab'); await B.k.open(PAY, 'payments_tab');
			await del(A.p, x); await waitRows(A.p, 1);
			await del(B.p, x); await waitRows(B.p, 1).catch(() => null);
			await sleep(300);
			const out = { notice: await B.k.text('#pay-delete-notice'), stored: stored().map((r) => r.id === y), bRows: (await shownRows(B.p)).length, bMain: await B.p.evaluate(`!!document.querySelector('[data-ready="payments_tab"]')`) };
			return { pass: /already deleted elsewhere/.test(out.notice ?? '') && J(out.stored) === J([true]) && out.bRows === 1 && out.bMain, evidence: out };
		} finally { await A.p.close(); await B.p.close(); }
	});

	// ---- lane 04's passing JavaScript scenarios ----------------------------------------------------------------------------
	await scenario('Q-R2-JS-DELETE-DURING-ADD', 'payments_tab', 'JS (lane 04): while an Add is in flight this tab\'s Delete buttons are disabled; another tab\'s Delete lands; one row added, the other deleted', async () => {
		await clearAll();
		const other = await seed('Synthetic delete target');
		const keep = await seed('Synthetic keep row');
		const A = await js(), B = await js();
		try {
			await A.k.open(PAY, 'payments_tab'); await B.k.open(PAY, 'payments_tab');
			await fill(A.p, [['#pay_date', '2089-03-02'], ['#pay_amount', '55.00'], ['#pay_method', 'Synthetic A'], ['#pay_note', 'Synthetic add in flight']]);
			const lock = holdStore(S.dataDir);
			let sameTab;
			try {
				await A.k.click('#pay-add');
				await sleep(300);
				sameTab = await A.p.evaluate(`[...document.querySelectorAll('#payments tbody button')].map((x) => x.disabled)`);
				await del(A.p, other);
				await del(B.p, other);
				await sleep(1500);
			} finally { lock.release(); }
			await waitRows(A.p, 2, 30000).catch(() => null);
			await sleep(800);
			const s = stored();
			return { pass: s.length === 2 && s.some((r) => r.id === keep) && !s.some((r) => r.id === other) && s.some((r) => r.fields.note === 'Synthetic add in flight') && sameTab.every(Boolean), evidence: { sameTab, stored: s.map((r) => r.fields.note) } };
		} finally { await A.p.close(); await B.p.close(); }
	});
	await scenario('Q-R2-JS-TWO-FAILS-THEN-SUCCESS', 'payments_tab', 'JS (lane 04): refused (400), then busy (503), then success: fields kept after each failure, exactly one row, error cleared', async () => {
		await clearAll();
		const { p, k } = await js();
		try {
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
			const ok = { error: await err(p), stored: stored().map((r) => r.fields.amountCents) };
			return { pass: /full stop/.test(f1.error ?? '') && f1.values[1] === '1 000,50' && f2.values[1] === '1 000.50' && f2.values[3] === 'Synthetic two failures' && f2.stored === 0 && J(ok.stored) === J([100050]) && ok.error === null, evidence: { f1, f2, ok } };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-JS-LEGACY-TEXT', 'payments_tab', 'JS (lane 04): a stored text amount is shown as typed, flagged, left out of the totals and the Settlement prefill, exported as typed', async () => {
		await clearAll();
		await seed('Synthetic counted', '100.00');
		await S.stop();
		const d = new Database(join(S.dataDir, 'work.sqlite'));
		try {
			const fields = JSON.stringify({ date: '2089-05-05', amount: 'Synthetic entry 1', method: 'Synthetic legacy', note: 'Synthetic legacy note', seq: 2, amountCents: null });
			const now = '2026-10-08T09:00:00.000Z';
			d.query('INSERT INTO register_row(case_id, store, row_id, anchor, fields, fields_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('e2e-quantum', 'payments', '00000000-0000-4000-8000-000000legacy', null, fields, createHash('sha256').update(fields).digest('hex'), now, now);
		} finally { d.close(); }
		await S.start();
		const { p, k } = await js();
		try {
			await k.open(PAY, 'payments_tab');
			const out = { rows: await shownRows(p), flag: await p.evaluate(`document.querySelectorAll('[data-not-counted]').length`), paid: await k.kpi('Payments recorded') };
			await takeDownloads(p);
			await k.click('#export-payments'); await sleep(200);
			out.csv = (await takeDownloads(p)).map((x) => x.text)[0] ?? '';
			await k.open(route('settlement_tab'), 'settlement_tab');
			out.claim = await k.value('#se_claim');
			return { pass: out.flag === 1 && /Synthetic entry 1/.test(out.rows[1]?.cells[1] ?? '') && out.paid?.value === 'R 100.00' && /1 not counted/.test(out.paid?.sub ?? '') && out.csv.includes('Synthetic entry 1') && out.claim === '1050', evidence: out };
		} finally { await p.close(); }
	});

	// ---- without JavaScript ------------------------------------------------------------------------------------------------
	await scenario('Q-R2-NOJS-SLOT-400', 'payments_tab', 'no JS: a Delete after a refused Add keeps the refused entry and its reason (the Delete submits the Add form)', async () => {
		await clearAll();
		const x = await seed('Synthetic nojs delete target');
		const N = await nojs();
		try {
			await N.open(PAY);
			await fill(N.p, typedA);
			await N.submit(nojsAdd);
			const refused = { error: await err(N.p), values: await vals(N.p) };
			await N.submit(nojsDel(x));
			const after = { error: await err(N.p), invalid: await invalid(N.p, 'pay_amount'), values: await vals(N.p), rows: (await shownRows(N.p)).length, stored: stored().length };
			return { pass: /Not an amount/.test(refused.error ?? '') && J(refused.values) === J(V(typedA)) && /Not an amount/.test(after.error ?? '') && after.invalid === 'true' && J(after.values) === J(V(typedA)) && after.rows === 0 && after.stored === 0, evidence: { refused, after } };
		} finally { await N.p.close(); }
	});
	await scenario('Q-R2-NOJS-SLOT-503', 'payments_tab', 'no JS: after a busy-store refusal, a Delete keeps the unsaved entry and says it is not saved; Add then saves it', async () => {
		await clearAll();
		const x = await seed('Synthetic nojs delete target');
		const N = await nojs();
		try {
			await N.open(PAY);
			await fill(N.p, valid);
			const lock = holdStore(S.dataDir);
			let busy;
			try { await N.submit(nojsAdd); busy = { error: await err(N.p), values: await vals(N.p), retry: await N.k.exists('#pay-retry') }; } finally { lock.release(); }
			await N.submit(nojsDel(x));
			const after = { error: await err(N.p), values: await vals(N.p), rows: (await shownRows(N.p)).length };
			await N.submit(nojsAdd);
			const saved = { stored: stored().map((r) => r.fields.note), values: await vals(N.p), error: await err(N.p) };
			return { pass: /busy/.test(busy.error ?? '') && busy.retry && J(busy.values) === J(V(valid)) && /not saved yet/.test(after.error ?? '') && J(after.values) === J(V(valid)) && after.rows === 0 && J(saved.stored) === J(['Synthetic unsaved note']) && saved.error === null && J(saved.values) === J(['', '', '', '']), evidence: { busy, after, saved } };
		} finally { await N.p.close(); }
	});
	await scenario('Q-R2-NOJS-TWO-ADDS', 'payments_tab', 'no JS (lane 04): two Adds in a row both stay, in order, with distinct seq', async () => {
		await clearAll();
		const N = await nojs();
		try {
			await N.open(PAY);
			await fill(N.p, [['#pay_date', '2089-06-01'], ['#pay_amount', '11.00'], ['#pay_method', 'Synthetic nojs'], ['#pay_note', 'Synthetic nojs one']]);
			await N.submit(nojsAdd);
			await fill(N.p, [['#pay_date', '2089-06-02'], ['#pay_amount', '22.00'], ['#pay_method', 'Synthetic nojs'], ['#pay_note', 'Synthetic nojs two']]);
			await N.submit(nojsAdd);
			const rows = (await shownRows(N.p)).map((r) => r.cells[3]);
			const s = stored();
			return { pass: s.length === 2 && J(rows) === J(['Synthetic nojs one', 'Synthetic nojs two']) && new Set(s.map((r) => r.fields.seq)).size === 2, evidence: { rows, seqs: s.map((r) => r.fields.seq) } };
		} finally { await N.p.close(); }
	});
	await scenario('Q-R2-NOJS-REFUSED', 'payments_tab', 'no JS (lane 04): a refused Add returns the page with the error and every typed field, not an error page', async () => {
		await clearAll();
		const N = await nojs();
		try {
			await N.open(PAY);
			const typed = ['2089-06-03', 'R -5', 'Synthetic nojs', 'Synthetic nojs refused'];
			await fill(N.p, FIELDS.map((s, i) => [s, typed[i]]));
			await N.submit(nojsAdd);
			const out = { error: await err(N.p), values: await vals(N.p), main: await N.p.evaluate(`!!document.querySelector('[data-ready="payments_tab"]')`), stored: stored().length };
			return { pass: /negative/.test(out.error ?? '') && J(out.values) === J(typed) && out.main && out.stored === 0, evidence: out };
		} finally { await N.p.close(); }
	});
	await scenario('Q-R2-NOJS-DELETE-GONE', 'payments_tab', 'no JS (lane 04): Delete of a payment already deleted elsewhere returns the page with a notice; the other row is kept', async () => {
		await clearAll();
		const x = await seed('Synthetic nojs deleted twice');
		const y = await seed('Synthetic nojs survivor');
		const N = await nojs();
		try {
			await N.open(PAY);
			const r0 = stored().find((r) => r.id === x);
			await c.form(`${VP}${PAY}?/delete`, { rowId: x, hash: fieldsHash(r0.fields) });
			await N.submit(nojsDel(x));
			const out = { main: await N.p.evaluate(`!!document.querySelector('[data-ready="payments_tab"]')`), notice: await N.k.text('#pay-delete-notice'), rows: (await shownRows(N.p)).map((r) => r.id === y), stored: stored().map((r) => r.id === y) };
			return { pass: out.main && /already deleted elsewhere/.test(out.notice ?? '') && J(out.stored) === J([true]) && J(out.rows) === J([true]), evidence: out };
		} finally { await N.p.close(); }
	});
	await scenario('Q-R2-D18-LONG-NOTE', 'payments_tab', 'a note over 2 000 characters is refused with the limit and kept, with and without JavaScript; nothing is stored', async () => {
		await clearAll();
		const long = 'Synthetic long note '.repeat(101);
		const { p, k } = await js();
		const N = await nojs();
		try {
			await k.open(PAY, 'payments_tab');
			await fill(p, [['#pay_amount', '5.00'], ['#pay_note', long]]);
			await k.click('#pay-add');
			await p.waitFor(`!!document.getElementById('pay-error')`, 15000);
			const withJs = { error: await err(p), kept: (await vals(p))[3] === long, invalid: await invalid(p, 'pay_note') };
			await N.open(PAY);
			await fill(N.p, [['#pay_amount', '5.00'], ['#pay_note', long]]);
			await N.submit(nojsAdd);
			const noJs = { error: await err(N.p), kept: (await vals(N.p))[3] === long };
			const re = /^Note: at most 2 000 characters \(this one has 2 020\)/;
			return { pass: re.test(withJs.error ?? '') && withJs.kept && withJs.invalid === 'true' && re.test(noJs.error ?? '') && noJs.kept && stored().length === 0, evidence: { withJs, noJs } };
		} finally { await p.close(); await N.p.close(); }
	});
	await scenario('Q-R2-D8-DATE', 'payments_tab', 'the add action refuses a date that is not a calendar date (30 February, formula text) with 400 and stores nothing', async () => {
		await clearAll();
		const out = [];
		for (const date of ['2086-02-30', '=1+1', '0024-01-01']) {
			const r = await c.form(`${VP}${PAY}?/add`, { date, amount: '1.00', method: 'Synthetic', note: 'Synthetic bad date' });
			out.push({ date, status: r.status, named: /Date: /.test(r.text ?? '') });
		}
		return { pass: out.every((o) => o.status === 400 && o.named) && stored().length === 0, evidence: { out, stored: stored().length } };
	});

	// ---- leaving the page with an unsaved entry ----------------------------------------------------------------------------
	await scenario('Q-R2-LEAVE', 'payments_tab', 'JS: an in-app navigation with an unsaved entry asks first (Stay keeps it, Leave goes); a reload gets the browser\'s prompt', async () => {
		await clearAll();
		const { p, k } = await js();
		try {
			await k.open(PAY, 'payments_tab');
			await fill(p, [['#pay_note', 'Synthetic unsent note']]);
			await p.evaluate(`document.getElementById('nav-quantum_tab').click()`);
			await p.waitFor(`!!document.getElementById('pay-ask')`, 10000);
			const asked = { text: await k.text('#pay-ask-text'), path: await p.evaluate('location.pathname') };
			await k.click('#pay-ask-stay');
			await sleep(200);
			const stayed = { path: await p.evaluate('location.pathname'), note: (await vals(p))[3], ask: await k.exists('#pay-ask') };
			const mark = b.mark();
			const href = await p.evaluate('location.href');
			// the browser's prompt is dismissed by the harness (stay): the reload does not happen and the entry stays
			const reload = await p.navigate(href, { timeout: 4000 }).then(() => 'navigate returned', () => 'navigate timed out');
			await sleep(300);
			const prompt = b.events.dialogs.slice(mark.dialogs).map((d) => d.type);
			const afterReload = { note: (await vals(p))[3] };
			await p.evaluate(`document.getElementById('nav-quantum_tab').click()`);
			await p.waitFor(`!!document.getElementById('pay-ask')`, 10000);
			await k.click('#pay-ask-leave');
			await p.waitFor(ready('quantum_tab'), 20000);
			return { pass: /not saved yet/.test(asked.text ?? '') && asked.path.endsWith(PAY) && stayed.path.endsWith(PAY) && stayed.note === 'Synthetic unsent note' && !stayed.ask && prompt.includes('beforeunload') && afterReload.note === 'Synthetic unsent note', evidence: { asked, stayed, reload, prompt, afterReload } };
		} finally { await p.close(); }
	});

	// ---- D5 to D7, D10, D11, D17: the calculators --------------------------------------------------------------------------
	const IC = route('interest_calc_tab'), SE = route('settlement_tab');
	const icErr = (k) => k.text('#ic-error');
	await scenario('Q-R2-D5-URL', 'interest_calc_tab', 'a compound result too large to compute: HTTP 200, a visible error naming the cause, every input kept, no figure', async () => {
		const q = '?p=1000&r=10.5&m=Compound+(monthly)&from=1025-03-01&to=2026-03-01';
		const status = (await fetch(`${base}${IC}${q}`)).status;
		const { p, k } = await js();
		try {
			await k.open(`${IC}${q}`, 'interest_calc_tab');
			const r = { status, error: await icErr(k), values: await k.values(['#ic_p', '#ic_r', '#ic_m', '#ic_from', '#ic_to']), kpis: (await k.kpis('#ic_out')).length };
			return { pass: status === 200 && /too large to show/.test(r.error ?? '') && J(r.values) === J(['1000', '10.5', 'Compound (monthly)', '1025-03-01', '2026-03-01']) && r.kpis === 0, evidence: r };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-D5-COMPUTE', 'interest_calc_tab', 'Compute with the same values shows the error, keeps the inputs and throws nothing (no Runtime.exceptionThrown)', async () => {
		const { p, k } = await js();
		try {
			await k.open(IC, 'interest_calc_tab');
			const mark = b.mark();
			await fill(p, [['#ic_p', '1000000'], ['#ic_r', '100'], ['#ic_m', 'Compound (monthly)'], ['#ic_from', '1950-01-01'], ['#ic_to', '2026-01-01']]);
			await k.click('#ic-compute');
			await p.waitFor(`!!document.getElementById('ic-error')`, 15000);
			const r = { error: await icErr(k), values: await k.values(['#ic_p', '#ic_r', '#ic_from']), exceptions: b.events.console.slice(mark.console).filter((e) => e.kind === 'exception').map((e) => e.text) };
			return { pass: /too large to show/.test(r.error ?? '') && J(r.values) === J(['1000000', '100', '1950-01-01']) && r.exceptions.length === 0, evidence: r };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-D7-YEARS', 'interest_calc_tab', 'years 0024 and 0000 are refused with a message naming the field, the text and 1000 to 9999; nothing is computed', async () => {
		const { p, k } = await js();
		try {
			await k.open(`${IC}?p=1000&r=10&m=Simple&from=0024-03-01&to=2026-03-01`, 'interest_calc_tab');
			const y24 = { error: await icErr(k), kpis: (await k.kpis('#ic_out')).length, invalid: await invalid(p, 'ic_from') };
			await k.open(`${IC}?p=1000&r=10&m=Simple&from=0000-01-01&to=0001-01-01`, 'interest_calc_tab');
			const y0 = { error: await icErr(k), field: await k.value('#ic_from'), kpis: (await k.kpis('#ic_out')).length };
			return { pass: /From \(mora\): '0024-03-01' is outside the accepted years\. Enter a year from 1000 to 9999/.test(y24.error ?? '') && y24.kpis === 0 && y24.invalid === 'true' && /'0000-01-01'/.test(y0.error ?? '') && /'0001-01-01'/.test(y0.error ?? '') && y0.kpis === 0, evidence: { y24, y0 } };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-D11-BOUNDS', 'settlement_tab', 'a probability of 150 and a rate above 100 are refused visibly, the text kept, no figures; the bounds are shown beside the fields', async () => {
		const { p, k } = await js();
		try {
			await k.open(`${SE}?p=150&c=0`, 'settlement_tab');
			const se = { error: await k.text('#se-error'), kept: await k.value('#se_p'), kpis: (await k.kpis('#se_out')).length, hint: await p.evaluate(`document.getElementById('se_p').nextElementSibling?.textContent ?? null`) };
			await k.open(`${IC}?p=1000&r=999999999&m=Simple&from=2093-01-10&to=2094-01-10`, 'interest_calc_tab');
			const ic = { error: await icErr(k), kept: await k.value('#ic_r') };
			return { pass: /A probability is 0 to 100 \(150 is above 100\)/.test(se.error ?? '') && se.kept === '150' && se.kpis === 0 && se.hint === '0 to 100' && /A rate is 0 to 100/.test(ic.error ?? '') && ic.kept === '999999999', evidence: { se, ic } };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-D10-OVERPAID', 'settlement_tab', 'payments above the gross amount due: Settlement opens with a negative net claim modelled (figures, no error) and a note of the excess; Reset gives the same', async () => {
		await clearAll();
		await seed('Synthetic overpayment', '2000.00');
		const { p, k } = await js();
		try {
			await k.open(SE, 'settlement_tab');
			const first = { claim: await k.value('#se_claim'), kpis: await k.kpis('#se_out'), error: await k.text('#se-error'), note: await k.text('#se-net') };
			await k.click('#se-reset');
			await sleep(400);
			const reset = { claim: await k.value('#se_claim'), kpis: await k.kpis('#se_out') };
			return { pass: first.claim === '-850' && first.kpis.length === 3 && first.kpis.every((x) => x.value.startsWith('-R ')) && first.error === null && /exceed the gross amount due by R 850\.00/.test(first.note ?? '') && reset.claim === '-850' && J(reset.kpis) === J(first.kpis), evidence: { first, reset } };
		} finally { await p.close(); await clearAll(); }
	});
	await scenario('Q-R2-D17-RESET', 'interest_calc_tab', 'Reset to defaults restores a field typed without Compute or Model, on both calculators', async () => {
		const { p, k } = await js();
		try {
			await k.open(IC, 'interest_calc_tab');
			const before = await k.value('#ic_r');
			await fill(p, [['#ic_r', '99']]);
			await k.click('#ic-reset');
			await sleep(400);
			const ic = await k.value('#ic_r');
			await k.open(SE, 'settlement_tab');
			const sBefore = await k.value('#se_p');
			await fill(p, [['#se_p', '75']]);
			await k.click('#se-reset');
			await sleep(400);
			const se = { p: await k.value('#se_p'), base: (await k.kpis('#se_out'))[1]?.label };
			return { pass: before === '7.25' && ic === '7.25' && sBefore === '60' && se.p === '60' && se.base === 'Base (p=60%)', evidence: { before, ic, sBefore, se } };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-CALC-INFLIGHT', 'interest_calc_tab', 'a rate typed while Compute is in flight (its __data.json held with CDP Fetch, if it makes one) survives the navigation\'s end', async () => {
		const { p, k } = await js();
		try {
			await k.open(`${IC}?p=1000&r=10&m=Simple&from=2093-01-10&to=2094-01-10`, 'interest_calc_tab');
			await p.s('Fetch.enable', { patterns: [{ urlPattern: '*__data.json*', requestStage: 'Request' }] });
			const paused = b.once((m) => m.sessionId === p.sessionId && m.method === 'Fetch.requestPaused', 2000).catch(() => null);
			await fill(p, [['#ic_r', '9.5']]);
			await k.click('#ic-compute');
			const held = await paused;
			await fill(p, [['#ic_r', '9.75'], ['#ic_p', '2000']]);
			if (held) await p.s('Fetch.continueRequest', { requestId: held.params.requestId });
			await p.waitFor(`location.search.includes('r=9.5')`, 15000);
			await sleep(300);
			await p.s('Fetch.disable');
			const r = { held: !!held, search: await k.search(), values: await k.values(['#ic_p', '#ic_r', '#ic_from']) };
			return { pass: J(r.values) === J(['2000', '9.75', '2093-01-10']), evidence: r };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-D12-URL', 'prescription_tab', 'an unknown risk in the URL is named and ignored (every row shown, the select on Any risk); an unknown method is named', async () => {
		const { p, k } = await js();
		try {
			await k.open(`${route('prescription_tab')}?risk=Bogus%3Cb%3E`, 'prescription_tab');
			const r = { note: await k.text('#pr-url-note'), select: await k.value('#pr-risk'), rows: await p.evaluate(`document.querySelectorAll('#prescription tbody tr').length`), pager: await k.text('#pr-pager .count'), bold: await p.evaluate(`!!document.querySelector('#pr-url-note b')`) };
			await k.open(`${IC}?p=1000&r=10&m=Bogus&from=2093-01-10&to=2094-01-10`, 'interest_calc_tab');
			r.method = await icErr(k);
			return { pass: r.note === "The risk filter 'Bogus<b>' in the link matches no risk in this case and was ignored: every risk is shown." && r.select === '' && r.rows === 7 && r.pager === 'Showing 1–7 of 7' && !r.bold && /Method 'Bogus' is not one this calculator offers/.test(r.method ?? ''), evidence: r };
		} finally { await p.close(); }
	});
	await scenario('Q-R2-NOJS-PRESCRIPTION', 'prescription_tab', 'no JS: the risk filter works through its GET form (Apply filter), and the URL and the controls agree', async () => {
		const N = await nojs();
		try {
			await N.open(route('prescription_tab'));
			const apply = await N.p.evaluate(`!!document.getElementById('pr-apply') && !document.getElementById('pr-apply').hidden`);
			await N.p.evaluate(`document.getElementById('pr-risk').value = 'Relies on interruption'`);
			await N.submit(`document.getElementById('pr-form').requestSubmit(document.getElementById('pr-apply'))`);
			const r = { apply, search: await N.p.evaluate('location.search'), select: await N.k.value('#pr-risk'), rows: await N.p.evaluate(`[...document.querySelectorAll('#prescription tbody tr')].map((r) => r.cells[1].textContent.trim())`) };
			return { pass: apply && /risk=Relies\+on\+interruption/.test(r.search) && r.select === 'Relies on interruption' && J(r.rows) === J(['SYNP1', 'SYNP2']), evidence: r };
		} finally { await N.p.close(); }
	});
	await scenario('Q-R2-D19-SAME-ROUTE', 'prescription_tab', 'a filtered Prescription, then its own sidebar link: the URL and the controls agree on the filter shown', async () => {
		const { p, k } = await js();
		try {
			await k.open(`${route('prescription_tab')}?risk=Relies+on+interruption`, 'prescription_tab');
			await p.evaluate(`document.getElementById('nav-prescription_tab').click()`);
			await sleep(800);
			await p.waitFor(ready('prescription_tab'), 20000);
			const r = { search: await k.search(), select: await k.value('#pr-risk'), rows: await p.evaluate(`document.querySelectorAll('#prescription tbody tr').length`) };
			const agree = (r.search === '' && r.select === '' && r.rows === 7) || (/risk=Relies\+on\+interruption/.test(r.search) && r.select === 'Relies on interruption' && r.rows === 2);
			return { pass: agree, evidence: r };
		} finally { await p.close(); }
	});

	// ---- D13: links by ref only, unknown refs broken ------------------------------------------------------------------------
	await scenario('Q-R2-D13-LINKS', 'prescription_tab', 'every document link on Prescription, Invoice Ledger, Quantum (series and ledger) and the reconciliation chain is /v/<vid>/doc/<ref> for a ref the case holds; unknown refs render broken', async () => {
		const KNOWN = ['OD-001', 'OD-002', 'OD-003', 'SD-001'];
		const { p, k } = await js();
		const read = (table, refCol) => p.evaluate(`[...document.querySelectorAll(${J(`${table} tbody tr`)})].map((tr) => ({ ref: ${refCol === null ? 'null' : `tr.cells[${refCol}].textContent.trim()`}, links: [...tr.querySelectorAll('a.cite')].map((a) => [a.textContent.replace(' ↗', '').trim(), a.getAttribute('href')]), broken: [...tr.querySelectorAll('.cite-broken')].map((s) => s.textContent.trim()) }))`);
		try {
			const out = {};
			await k.open(route('prescription_tab'), 'prescription_tab');
			out.prescription = await read('#prescription', 0);
			await k.open(route('invoice_ledger_tab'), 'invoice_ledger_tab');
			out.ledger = await read('#invoice-ledger', 0);
			await k.open(route('quantum_tab'), 'quantum_tab');
			out.qledger = await read('#invoice-ledger', 0);
			out.series = await read('#amount-due-series', 1);
			await k.open(PAY, 'payments_tab');
			out.recon = await read('#recon', null);
			const bad = [];
			for (const [t, rows] of Object.entries(out)) for (const r of rows) {
				for (const [text, href] of r.links) {
					const ref = r.ref ?? text;
					if (href !== `${VP}/doc/${encodeURIComponent(ref)}` || (t !== 'series' && !KNOWN.includes(ref))) bad.push({ t, ref, href });
				}
				if (r.ref && r.ref.startsWith('ZZ-') && (r.links.length || !r.broken.length)) bad.push({ t, ref: r.ref, unknownLinked: true });
			}
			const unknown = { presc: out.prescription.find((r) => r.ref === 'ZZ-405'), ledger: out.ledger.find((r) => r.ref === 'ZZ-406'), recon: out.recon.flatMap((r) => r.broken) };
			return { pass: bad.length === 0 && unknown.presc?.broken.length === 1 && unknown.presc.links.length === 0 && unknown.ledger?.broken.length === 1 && unknown.recon.includes('ZZ-404') && out.prescription.some((r) => r.links.length) && out.series.some((r) => r.links.length), evidence: { bad, unknown, counts: Object.fromEntries(Object.entries(out).map(([t, rows]) => [t, rows.reduce((n, r) => n + r.links.length, 0)])) } };
		} finally { await p.close(); }
	});

	// ---- D9: the South African as-of date, by the server's clock and time zone -----------------------------------------
	await scenario('Q-R2-D9-AS-OF', 'prescription_tab', 'TZ=Africa/Johannesburg, clock 2026-10-08T22:30Z (00:30 on 9 October locally): the as-of date is 2026-10-09 (today); the row due on 8 October has passed and the row due that day has not', async () => {
		await S.stop();
		await S.start({ TZ: 'Africa/Johannesburg', CLEARCASE_FIXED_NOW: '2026-10-08T22:30:00Z' });
		const { p, k } = await js();
		try {
			await k.open(route('prescription_tab'), 'prescription_tab');
			const status = (no) => p.evaluate(`[...document.querySelectorAll('#prescription tbody tr')].find((tr) => tr.cells[1].textContent.trim() === '${no}')?.querySelector('[data-as-of]')?.dataset.asOf ?? null`);
			const r = { asof: await k.text('#arith-asof'), before: await status('SYNP5'), onTheDay: await status('SYNP7') };
			return { pass: /as-of date 2026-10-09 \(today, South African time\)/.test(r.asof ?? '') && /^4 of 7 rows/.test(r.asof ?? '') && r.before === 'passed' && r.onTheDay === 'not-reached', evidence: r };
		} finally { await p.close(); await S.stop(); await S.start(); }
	});

	// ---- BASE-R2 step 6: the four export names come from the package's view-content ---------------------------------------
	await scenario('Q-R2-EXPORT-NAMES', 'payments_tab', "Quantum, Invoice Ledger, Prescription and Payments exports are named by the package's view-content exportFileName with no note; a package without view-content (viewCode: false) gives the neutral names, each with the note beside its export", async () => {
		const EX = [['quantum_tab', '#export-invoices', 'invoices.csv'], ['invoice_ledger_tab', '#export-invoices', 'invoices.csv'], ['prescription_tab', '#export-presc', 'prescription.csv'], ['payments_tab', '#export-payments', 'payments.csv']];
		// the expected names are read from the built synthetic package, never written here
		const vcText = (pkg, view) => { const f = pkg.files.get('datasets/view-content.json'); const v = f ? JSON.parse(new TextDecoder().decode(f)).data?.[view]?.exportFileName : undefined; return typeof v === 'string' ? v : null; };
		const neutral = await buildCase(join(sc.root, '..', 'neutral-r2'), { caseId: 'e2e-quantum-neutral', viewCode: false });
		const imp = await c.importPkg(neutral.caseDir, neutral.pkgDir);
		if (!imp.importId) throw new Error(`neutral import failed: ${imp.status} ${imp.location}`);
		const p = await newPage(b, { initScript: CAPTURE });
		const read = async (pkg) => {
			const k = pageKit(p, `${S.origin}${vpath(pkg.resultsVersion)}`);
			const out = {};
			for (const [view, sel] of EX) {
				await k.open(route(view), view);
				await takeDownloads(p);
				await k.click(sel); await sleep(200);
				out[view] = { names: (await takeDownloads(p)).map((d) => d.name), notes: await p.evaluate(`[...document.querySelectorAll('[data-export-note]')].map((e) => e.textContent.trim())`) };
			}
			return out;
		};
		try {
			const named = await read(sc), generic = await read(neutral);
			const pass = EX.every(([view, , neutralName]) => { const want = vcText(sc, view); return typeof want === 'string' && want !== neutralName && J(named[view].names) === J([want]) && named[view].notes.length === 0 &&
				vcText(neutral, view) === null && J(generic[view].names) === J([neutralName]) && J(generic[view].notes) === J([EXPORT_NAME_NOTE]); });
			return { pass, evidence: { named, generic, neutral: { resultsVersion: neutral.resultsVersion, import: imp.location } } };
		} finally { await p.close(); }
	});
}
