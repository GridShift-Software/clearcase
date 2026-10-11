#!/usr/bin/env bun
// Offline browser suite of the quantum views (GRS-16, CC-06), run by `bun run --bun test:e2e` in its own network
// namespace after the pilot suites. It starts the production entry (scripts/pilot/start.ts) of this worktree on
// ./build with a fresh data directory and the parity clock (CLEARCASE_FIXED_NOW, TZ=UTC), imports and activates a
// synthetic case (lib.mjs), and drives the six views in Chromium: titles and heading focus, the ticket's ten
// verification scenarios, a busy store and a lost transport across a submit, and SIGKILL and graceful restarts. It
// writes $CLEARCASE_E2E_OUT/quantum/summary.json ({scenarios: [{id, view, pass}]}) and quantum/results.json (evidence),
// and exits non-zero if any scenario fails. Ports 43600-43601; canary 43699.
process.env.CANARY_PORT ??= '43699';
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const { proveOffline } = await import('../pilot/lib/netproof.mjs');
const { launch, newPage, sleep } = await import('../pilot/lib/cdp.mjs');
const { client, vpath } = await import('../pilot/lib/client.mjs');
const { outDir } = await import('../pilot/lib/record.mjs');
const { CAPTURE, CLOCK, J, holdStore, pageKit, quantumCase, ready, server, takeDownloads } = await import('./lib.mjs');
const { r2 } = await import('./r2.mjs');

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..'));
const BUILD = join(ROOT, 'build');
const OUT = join(outDir(), 'quantum');
const LABEL = { quantum_tab: 'Quantum & Interest', invoice_ledger_tab: 'Invoice Ledger', prescription_tab: 'Prescription', interest_calc_tab: 'Interest Recalculator', payments_tab: 'Payments & Net Claim', settlement_tab: 'Settlement / BATNA' };
const results = [];
// QUANTUM_ONLY=<id,id,...> runs only those scenarios (a development probe, e.g. a mutant check); never for evidence
const ONLY = new Set((process.env.QUANTUM_ONLY ?? '').split(',').filter(Boolean));
const scenario = async (id, view, title, fn) => {
	if (ONLY.size && !ONLY.has(id)) return;
	const t0 = Date.now();
	let pass = false, evidence = {};
	try { const r = await fn(); pass = r.pass === true; evidence = r.evidence ?? {}; } catch (e) { evidence = { error: String(e?.stack ?? e).slice(0, 3000) }; }
	results.push({ id, view, title, pass, ms: Date.now() - t0, evidence });
	console.log(`${pass ? 'PASS' : 'FAIL'}    ${id} [${view}] ${title}`);
};
const finish = (extra = {}) => {
	mkdirSync(OUT, { recursive: true });
	writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ scenarios: results.map(({ id, view, pass }) => ({ id, view, pass })), clock: CLOCK, ...(ONLY.size ? { only: [...ONLY], evidence: false } : {}), ...extra }, null, 1));
	writeFileSync(join(OUT, 'results.json'), JSON.stringify({ results, ...extra }, null, 1));
	const failed = results.filter((r) => !r.pass).length;
	console.log(`quantum suite: ${results.length - failed} PASS, ${failed} FAIL -> ${join(OUT, 'summary.json')}`);
	return failed === 0 && results.length > 0;
};

const offline = await proveOffline();
if (!offline.pass) { results.push({ id: 'Q-OFFLINE', view: 'quantum_tab', title: 'the run is offline', pass: false, evidence: offline }); process.exit(finish() ? 0 : 1); }

const tmp = mkdtempSync(join(tmpdir(), 'cc-e2e-quantum-'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
const S = server({ root: ROOT, buildDir: BUILD, port: 43600, dir: tmp });
let b;
try {
	const sc = await quantumCase(join(tmp, 'case'));
	await S.start();
	const c = client(S.port);
	const imp = await c.importPkg(sc.caseDir, sc.pkgDir);
	const act = await c.activate(imp.importId, { ack: true });
	if ((await c.activeVersion()) !== sc.resultsVersion) throw new Error(`activation failed: ${J({ imp: { status: imp.status, id: imp.importId }, act })}`);
	const manifest = JSON.parse(new TextDecoder().decode(sc.files.get('manifest.json')));
	const vcShell = JSON.parse(new TextDecoder().decode(sc.files.get('datasets/view-content.json'))).data?._shell?.documentTitle;
	const titleName = typeof vcShell === 'string' && vcShell.trim() ? vcShell : manifest.case.label || manifest.case.id;
	const base = `${S.origin}${vpath(sc.resultsVersion)}`;
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	const p = await newPage(b, { initScript: CAPTURE });
	await p.s('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
	const k = pageKit(p, base);
	const route = (v) => `/quantum/${v}`;

	// ---- every view: document title and heading focus after navigating from the sidebar (BA-14, BA-16) ----------------
	for (const view of Object.keys(LABEL)) {
		await scenario(`Q-NAV-${view}`, view, 'title and heading focus after a sidebar navigation', async () => {
			await k.open('/overview', 'overview');
			await p.evaluate(`document.getElementById('nav-${view}').click()`);
			await p.waitFor(`${ready(view)} && document.activeElement?.hasAttribute('data-page-heading')`, 20000);
			const got = await p.evaluate(`({ title: document.title, focus: document.activeElement.textContent.trim(), path: location.pathname, current: document.querySelector('nav.views a[aria-current="page"]')?.id ?? null, unavailable: !!document.querySelector('[data-unavailable]') })`);
			const want = `${LABEL[view]} · ${titleName} · ClearCase`;
			return { pass: got.title === want && got.focus === LABEL[view] && got.path.endsWith(route(view)) && got.current === `nav-${view}` && !got.unavailable, evidence: { got, want } };
		});
	}

	// ---- 1. invoice totals against the imported reference ---------------------------------------------------------------
	await scenario('Q1-INVOICE-TOTALS', 'invoice_ledger_tab', 'the ledger sum is exact; the imported gross and count are shown as given and flagged when they differ', async () => {
		await k.open(route('invoice_ledger_tab'), 'invoice_ledger_tab');
		const sum = await k.kpi('Gross invoiced (sum, unreconciled)');
		const rows = await p.evaluate(`document.querySelectorAll('#invoice-ledger tbody tr').length`);
		await k.open(route('quantum_tab'), 'quantum_tab');
		const gross = await k.kpi('Gross invoiced (unreconciled)');
		const count = await k.kpi('Invoices in ledger');
		const flag = await k.text('#reconcile-flag');
		return { pass: sum?.value === 'R 1 150.30' && rows === 3 && gross?.value === 'R 1 150.00' && count?.value === '4' && /count \(4\) differs from the ledger's 3 rows/.test(flag ?? '') && /\(R 1 150\.00\) differs from the sum of the ledger's amounts \(R 1 150\.30\)/.test(flag ?? ''), evidence: { sum, rows, gross, count, flag } };
	});

	// ---- 2. the R100 example: exact in the library for one year; the two dated years on the Actual/365.25 basis --------
	await scenario('Q2-R100', 'interest_calc_tab', 'R1,000 at 10% simple for a dated year: R 99.93 (365 days) and R 100.21 (366 days); R100 for exactly one year is the library proof', async () => {
		await k.open(`${route('interest_calc_tab')}?p=R1%2C000&r=10&m=Simple&from=2093-01-10&to=2094-01-10`, 'interest_calc_tab');
		const a = await k.kpis('#ic_out');
		await k.open(`${route('interest_calc_tab')}?p=1%20000&r=10&m=Simple&from=2091-03-01&to=2092-03-01`, 'interest_calc_tab');
		const b2 = await k.kpis('#ic_out');
		return { pass: a[0]?.value === 'R 1 000.00' && a[1]?.label === 'Interest (1.00 yrs)' && a[1]?.value === 'R 99.93' && a[2]?.value === 'R 1 099.93' && b2[1]?.value === 'R 100.21' && b2[2]?.value === 'R 1 100.21', evidence: { days365: a, days366: b2 } };
	});

	// ---- 3. change and restore the defaults (the URL keeps the inputs; Reset returns to the package defaults) ----------
	await scenario('Q3-DEFAULTS-INTEREST', 'interest_calc_tab', 'change the rate, reload, then Reset to defaults', async () => {
		await k.open(route('interest_calc_tab'), 'interest_calc_tab');
		const before = await k.values(['#ic_p', '#ic_r', '#ic_m', '#ic_from', '#ic_to']);
		await k.fill([['#ic_p', '100000'], ['#ic_r', '9.5']]);
		await k.click('#ic-compute');
		await p.waitFor(`location.search.includes('r=9.5') && !!document.querySelector('#ic_out .kpi')`, 15000);
		const changed = await k.kpis('#ic_out');
		await k.reload('interest_calc_tab');
		const reloaded = { kpis: await k.kpis('#ic_out'), r: await k.value('#ic_r') };
		await k.click('#ic-reset');
		await p.waitFor(`location.search === '' && !document.querySelector('#ic_out .kpi')`, 15000);
		const restored = await k.values(['#ic_p', '#ic_r', '#ic_m', '#ic_from', '#ic_to']);
		return { pass: before[1] === '7.25' && before[3] === '2093-01-10' && before[4] === '2094-01-10' && J(reloaded.kpis) === J(changed) && reloaded.r === '9.5' && J(restored) === J(before), evidence: { before, changed, reloaded, restored } };
	});
	await scenario('Q3-DEFAULTS-SETTLEMENT', 'settlement_tab', 'change the probability, reload, then Reset to defaults', async () => {
		await k.open(route('settlement_tab'), 'settlement_tab');
		const before = await k.values(['#se_claim', '#se_p', '#se_y', '#se_d', '#se_c']);
		const kBefore = await k.kpis('#se_out');
		await k.fill([['#se_p', '75']]);
		await k.click('#se-model');
		await p.waitFor(`location.search.includes('p=75')`, 15000);
		await p.waitFor(`[...document.querySelectorAll('#se_out .kpi .k')].some((e) => e.textContent.trim() === 'Base (p=75%)')`, 15000);
		const changed = await k.kpis('#se_out');
		await k.reload('settlement_tab');
		const reloaded = await k.kpis('#se_out');
		await k.click('#se-reset');
		await p.waitFor(`location.search === ''`, 15000);
		await sleep(50);
		const restored = await k.values(['#se_claim', '#se_p', '#se_y', '#se_d', '#se_c']);
		return { pass: J(before) === J(['1150', '60', '3', '8', '1000']) && kBefore[1]?.label === 'Base (p=60%)' && J(reloaded) === J(changed) && J(restored) === J(before), evidence: { before, kBefore, changed, reloaded, restored } };
	});

	// ---- 4. month ends and leap days --------------------------------------------------------------------------------------
	await scenario('Q4-LEAP-MONTH-END', 'prescription_tab', 'invoice + 3 years with 29 February and month ends; a two-day period across 29 February', async () => {
		await k.open(route('prescription_tab'), 'prescription_tab');
		const plus3 = await k.text('#arith-plus3');
		const cells = await p.evaluate(`[...document.querySelectorAll('#prescription tbody tr')].map((r) => [r.cells[2].textContent, r.cells[3].textContent, r.cells[5].textContent.trim()])`);
		await k.open(`${route('interest_calc_tab')}?p=100000&r=10&m=Simple&from=2092-02-28&to=2092-03-01`, 'interest_calc_tab');
		const leap = await k.kpis('#ic_out');
		return { pass: plus3 === '5 of 7 imported prescription dates are the invoice date plus 3 calendar years. 2 invoices are dated 29 February; 2 of them prescribe on 28 February.' && cells[0][1] === '1991-02-28' && cells[3][1] === '2084-12-31' && leap[1]?.label === 'Interest (0.01 yrs)' && leap[1]?.value === 'R 54.76', evidence: { plus3, cells, leap } };
	});

	// ---- 5. invalid and reversed inputs are refused visibly, the typed text kept ----------------------------------------
	await scenario('Q5-INVALID-INTEREST', 'interest_calc_tab', 'a reversed period and a text capital are refused visibly; nothing is computed; the typed text stays', async () => {
		await k.open(`${route('interest_calc_tab')}?p=100000&r=10&m=Simple&from=2094-01-10&to=2093-01-10`, 'interest_calc_tab');
		const reversed = { error: await k.text('#ic-error'), kpis: (await k.kpis('#ic_out')).length };
		await k.open(`${route('interest_calc_tab')}?p=lots&r=10&m=Simple&from=2093-01-10&to=2094-01-10`, 'interest_calc_tab');
		const text = { error: await k.text('#ic-error'), kept: await k.value('#ic_p'), kpis: (await k.kpis('#ic_out')).length, invalid: await p.evaluate(`document.getElementById('ic_p').getAttribute('aria-invalid')`) };
		return { pass: /reversed period is not computed/.test(reversed.error ?? '') && reversed.kpis === 0 && /Not an amount/.test(text.error ?? '') && text.kept === 'lots' && text.kpis === 0 && text.invalid === 'true', evidence: { reversed, text } };
	});
	await scenario('Q5-INVALID-SETTLEMENT', 'settlement_tab', 'a comma-decimal claim is refused visibly and kept', async () => {
		await k.open(`${route('settlement_tab')}?claim=1%20000%2C50`, 'settlement_tab');
		const r = { error: await k.text('#se-error'), kept: await k.value('#se_claim'), kpis: (await k.kpis('#se_out')).length };
		return { pass: /comma decimal/.test(r.error ?? '') && r.kept === '1 000,50' && r.kpis === 0, evidence: r };
	});
	await scenario('Q5-INVALID-PAYMENT', 'payments_tab', 'a non-numeric amount is refused visibly; every typed field stays; no row is written', async () => {
		await k.open(route('payments_tab'), 'payments_tab');
		const before = S.rows('payments').length;
		const typed = [['#pay_date', '2089-03-31'], ['#pay_amount', 'Synthetic entry 1'], ['#pay_method', 'Synthetic method'], ['#pay_note', 'Synthetic refused']];
		await k.fill(typed);
		await k.click('#pay-add');
		await p.waitFor(`!!document.getElementById('pay-error')`, 15000);
		const r = { error: await k.text('#pay-error'), values: await k.values(typed.map(([s]) => s)), after: S.rows('payments').length, empty: await k.text('#payments tbody tr td') };
		// the refused entry is discarded on purpose, so the next scenario's navigation is not asked about it (CC-06 r2)
		await k.click('#pay-discard');
		r.discarded = await k.values(typed.map(([s]) => s));
		return { pass: /Not an amount/.test(r.error) && J(r.values) === J(typed.map(([, v]) => v)) && r.after === before && /^No payments recorded/.test(r.empty ?? ''), evidence: { before, ...r } };
	});

	// ---- 6. record a payment and reload the net claim ---------------------------------------------------------------------
	await scenario('Q6-PAYMENT-RELOAD', 'payments_tab', 'a payment typed as R 1 000.50 counts in full in the table and the net claim, after a reload too, and the settlement prefill is net', async () => {
		await k.open(route('payments_tab'), 'payments_tab');
		await k.fill([['#pay_date', '2089-03-31'], ['#pay_amount', 'R 1 000.50'], ['#pay_method', 'Synthetic EFT'], ['#pay_note', 'Synthetic payment one']]);
		await k.click('#pay-add');
		await p.waitFor(`document.querySelectorAll('#payments tbody tr[data-row-id]').length === 1`, 15000);
		const after = { kpis: await k.kpis(), row: await p.evaluate(`[...document.querySelector('#payments tbody tr[data-row-id]').cells].map((c) => c.textContent.trim())`), form: await k.values(['#pay_amount', '#pay_note']) };
		await k.reload('payments_tab');
		const reloaded = await k.kpis();
		await k.open(route('settlement_tab'), 'settlement_tab');
		const settle = { claim: await k.value('#se_claim'), note: await k.text('#se-net') };
		const stored = S.rows('payments');
		const pass = after.kpis[1]?.value === 'R 1 000.50' && after.kpis[1]?.sub === '1 receipts' && after.kpis[2]?.value === 'R 149.50' && after.row[1] === 'R 1 000.50' && J(after.form) === J(['', '']) &&
			J(reloaded) === J(after.kpis) && settle.claim === '150' && /net of 1 recorded payment \(R 1 000\.50\)/.test(settle.note ?? '') &&
			stored.length === 1 && stored[0].fields.amount === 'R 1 000.50' && stored[0].fields.amountCents === 100050 && stored[0].fields.seq === 1;
		return { pass, evidence: { after, reloaded, settle, stored: stored.map((r) => r.fields) } };
	});

	// ---- failed writes: a busy store and a lost transport across a submit ------------------------------------------------
	await scenario('Q-BUSY-STORE', 'payments_tab', 'work.sqlite held (BEGIN IMMEDIATE) for more than 12 s across Add: visible error, every field kept, no row; after release one retry saves exactly one row', async () => {
		await k.open(route('payments_tab'), 'payments_tab');
		const typed = [['#pay_date', '2089-04-30'], ['#pay_amount', '250.25'], ['#pay_method', 'Synthetic busy'], ['#pay_note', 'Synthetic busy note']];
		await k.fill(typed);
		const before = S.rows('payments').length;
		const lock = holdStore(S.dataDir);
		let r;
		try {
			await k.click('#pay-add');
			await p.waitFor(`/busy/.test(document.getElementById('pay-error')?.textContent ?? '')`, 30000);
			while (lock.held() < 12500) await sleep(100);
			r = { error: await k.text('#pay-error'), values: await k.values(typed.map(([s]) => s)), heldMs: lock.held() };
		} finally { lock.release(); }
		r.during = S.rows('payments').length;
		await k.click('#pay-add');
		await p.waitFor(`document.querySelectorAll('#payments tbody tr[data-row-id]').length === ${before + 1}`, 20000);
		r.after = S.rows('payments').length;
		r.errorGone = !(await k.exists('#pay-error'));
		return { pass: /busy/.test(r.error) && J(r.values) === J(typed.map(([, v]) => v)) && r.heldMs >= 12000 && r.during === before && r.after === before + 1 && r.errorGone, evidence: { before, ...r } };
	});
	await scenario('Q-LOST-TRANSPORT', 'payments_tab', 'server stopped before Add: visible error, every field kept, no row; after a restart one retry saves exactly one row', async () => {
		await k.open(route('payments_tab'), 'payments_tab');
		const typed = [['#pay_date', '2089-05-31'], ['#pay_amount', '1,000'], ['#pay_method', 'Synthetic offline'], ['#pay_note', 'Synthetic transport note']];
		await k.fill(typed);
		const before = S.rows('payments').length;
		await S.stop();
		await k.click('#pay-add');
		await p.waitFor(`/could not be reached/.test(document.getElementById('pay-error')?.textContent ?? '')`, 20000);
		const r = { error: await k.text('#pay-error'), values: await k.values(typed.map(([s]) => s)), during: S.rows('payments').length };
		await S.start();
		await k.click('#pay-add');
		// the retry clears the error while it is sent (CC-06 r2): wait until it has answered (saved, or failed again)
		r.retry = await p.waitFor(`!document.getElementById('pay-status') && (document.querySelectorAll('#payments tbody tr[data-row-id]').length === ${before + 1} || !!document.getElementById('pay-error'))`, 20000).then(() => k.text('#pay-error'), (e) => String(e).slice(0, 200));
		r.after = S.rows('payments').length;
		return { pass: /could not be reached/.test(r.error) && J(r.values) === J(typed.map(([, v]) => v)) && r.during === before && r.after === before + 1, evidence: { before, ...r } };
	});
	await scenario('Q-RESTARTS', 'payments_tab', 'every saved payment survives a SIGKILL restart and a graceful restart, by id and fields; the page shows them in insertion order', async () => {
		const saved = S.rows('payments');
		await S.stop('SIGKILL');
		await S.start();
		const afterKill = S.rows('payments');
		await S.stop('SIGTERM');
		await S.start();
		const afterTerm = S.rows('payments');
		await k.open(route('payments_tab'), 'payments_tab');
		const notes = await p.evaluate(`[...document.querySelectorAll('#payments tbody tr[data-row-id]')].map((r) => r.cells[3].textContent.trim())`);
		const net = await k.kpi('Net claim');
		return { pass: saved.length === 3 && J(afterKill) === J(saved) && J(afterTerm) === J(saved) && J(notes) === J(['Synthetic payment one', 'Synthetic busy note', 'Synthetic transport note']) && net?.value === '-R 1 100.75', evidence: { saved: saved.length, afterKill: afterKill.length, afterTerm: afterTerm.length, notes, net } };
	});

	// ---- 7. export the invoice ledger --------------------------------------------------------------------------------------
	await scenario('Q7-EXPORT-LEDGER', 'invoice_ledger_tab', 'Export CSV writes v5\'s columns and every ledger row in data order, the source values unchanged', async () => {
		await k.open(route('invoice_ledger_tab'), 'invoice_ledger_tab');
		await takeDownloads(p);
		await k.click('#export-invoices');
		await sleep(100);
		const d = (await takeDownloads(p))[0];
		const lines = d?.text.split('\r\n') ?? [];
		const named = JSON.parse(new TextDecoder().decode(sc.files.get('datasets/view-content.json'))).data?.invoice_ledger_tab?.exportFileName;
		return { pass: typeof named === 'string' && d?.name === named && lines.length === 4 && lines[0] === 'ref,no,date,amount,bundle,text_status,url' && lines[1].startsWith('OD-002,SYNINV1,2081-01-31,1150.00,Original,extracted,./') && lines[3] === 'ZZ-406,SYNINV3,,0.20,Supplementary,none,', evidence: { name: d?.name, lines: lines.length, head: lines[0], last: lines[3] } };
	});
	await scenario('Q7-EXPORT-PRESCRIPTION', 'prescription_tab', 'the prescription export follows the active filter and the shown order (BA-17); the filter is in the URL and the controls show it', async () => {
		await k.open(`${route('prescription_tab')}?risk=Not+yet+due+to+prescribe`, 'prescription_tab');
		const shown = await p.evaluate(`[...document.querySelectorAll('#prescription tbody tr')].map((r) => r.cells[0].textContent.trim())`);
		const control = await k.value('#pr-risk');
		await takeDownloads(p);
		await k.click('#export-presc');
		await sleep(100);
		const d = (await takeDownloads(p))[0];
		const refs = (d?.text.split('\r\n') ?? []).slice(1).map((l) => l.split(',')[0]);
		return { pass: J(shown) === J(['OD-003', 'SD-001', 'ZZ-405', 'OD-001', 'SD-001']) && control === 'Not yet due to prescribe' && J(refs) === J(shown), evidence: { shown, control, refs } };
	});

	// ---- 8. change a settlement assumption and observe the result ----------------------------------------------------------
	await scenario('Q8-SETTLEMENT', 'settlement_tab', 'the checklist inputs give v5\'s figures; raising the probability to 95 clamps the optimistic case at 100', async () => {
		await k.open(`${route('settlement_tab')}?claim=1000000&p=70&y=2&d=10&c=100000`, 'settlement_tab');
		const base = await k.kpis('#se_out');
		await k.fill([['#se_p', '95']]);
		await k.click('#se-model');
		await p.waitFor(`location.search.includes('p=95')`, 15000);
		await p.waitFor(`[...document.querySelectorAll('#se_out .kpi .k')].some((e) => e.textContent.trim() === 'Base (p=95%)')`, 15000);
		const changed = await k.kpis('#se_out');
		return { pass: J(base.map((x) => x.value)) === J(['R 271 900.83', 'R 478 512.40', 'R 602 479.34']) && changed[2]?.value === 'R 726 446.28' && changed[2]?.label === 'Optimistic (p+15)', evidence: { base, changed } };
	});

	// ---- 9. imported narrative is distinguished from computed dates ---------------------------------------------------------
	await scenario('Q9-NARRATIVE', 'prescription_tab', 'the imported note is shown unchanged and labelled as unchecked narrative; the summary that contradicts its rows is flagged; the arithmetic says the legal rule is not approved', async () => {
		await k.open(route('prescription_tab'), 'prescription_tab');
		const r = {
			note: await p.evaluate(`document.querySelector('.narrative')?.textContent.trim() ?? null`), label: await k.text('#note-imported'), flag: await k.text('#summary-flag'),
			kpis: await k.kpis(), caution: await k.text('#arith-caution'), risk: await p.evaluate(`[...document.querySelectorAll('#prescription tbody tr')].map((r) => r.cells[4].textContent.trim() + ' / ' + r.cells[5].textContent.trim())`),
		};
		await k.open(route('interest_calc_tab'), 'interest_calc_tab');
		r.interest = { note: await p.evaluate(`document.querySelector('.narrative')?.textContent.trim() ?? null`), label: await k.text('#note-imported') };
		const pass = r.note === 'Synthetic narrative: every invoice has prescribed.' && /^Imported narrative: not checked/.test(r.label ?? '') && /It counts 3 relying on interruption where 2 rows carry that label/.test(r.flag ?? '') &&
			r.kpis[1]?.value === '3' && /legal rule \(leap day, < or ≤, interruption\) not approved/.test(r.caution ?? '') && /headline date 2094-01-10/.test(r.caution ?? '') &&
			J(r.risk) === J(['Relies on interruption / 3-yr date passed', 'Relies on interruption / 3-yr date passed', 'Not yet due to prescribe / 3-yr date not reached', 'Not yet due to prescribe / 3-yr date not reached', 'Not yet due to prescribe / 3-yr date passed', 'Not yet due to prescribe / 3-yr date passed', 'Not yet due to prescribe / 3-yr date not reached']) &&
			r.interest.note === 'Synthetic basis narrative.' && /^Imported narrative/.test(r.interest.label ?? '');
		return { pass, evidence: r };
	});

	// ---- links: by ref through the document-row contract; a missing ref is visibly broken ---------------------------------
	await scenario('Q-LINKS', 'quantum_tab', 'headline, ledger and recon refs link to document pages; an unknown ref renders broken; the charging link opens the chronology with only its type filter', async () => {
		await k.open(route('quantum_tab'), 'quantum_tab');
		const q = await p.evaluate(`({ headline: [...document.querySelectorAll('#main .kpi a.cite')].map((a) => [a.textContent.trim(), a.getAttribute('href')])[0] ?? null, charging: document.getElementById('charging-link')?.getAttribute('href') ?? null, ledger: [...document.querySelectorAll('#invoice-ledger a.cite')].length })`);
		await k.open(route('payments_tab'), 'payments_tab');
		const recon = await p.evaluate(`({ links: [...document.querySelectorAll('#recon a.cite')].map((a) => a.textContent.trim()), broken: [...document.querySelectorAll('#recon .cite-broken')].map((a) => a.textContent.trim()) })`);
		await p.evaluate(`document.getElementById('nav-quantum_tab').click()`);
		await p.waitFor(ready('quantum_tab'), 20000);
		await p.evaluate(`document.getElementById('charging-link').click()`);
		await p.waitFor(ready('chronology'), 20000);
		const chron = await p.evaluate(`({ search: location.search, type: document.getElementById('f-type')?.value ?? null, q: document.getElementById('f-q')?.value ?? null })`);
		const pass = q.headline?.[0] === 'Open source PDF' && q.headline?.[1] === `${vpath(sc.resultsVersion)}/doc/OD-002` && q.charging === `${vpath(sc.resultsVersion)}/chronology?type=charging+calculation` && q.ledger === 2 &&
			J(recon.links) === J(['OD-002 ↗', 'SD-001 ↗']) && J(recon.broken) === J(['ZZ-404']) && chron.search === '?type=charging+calculation' && chron.q === '';
		return { pass, evidence: { q, recon, chron } };
	});

	// ---- 10. a fixed clock gives identical results, across reloads and a restart ------------------------------------------
	await scenario('Q10-FIXED-CLOCK', 'prescription_tab', 'under CLEARCASE_FIXED_NOW the as-of date is the clock\'s, and the arithmetic, statuses and calculator output are identical across reloads and a restart', async () => {
		const snap = async () => {
			await k.open(route('prescription_tab'), 'prescription_tab');
			const presc = await p.evaluate(`document.getElementById('presc-arithmetic').innerText + '|' + [...document.querySelectorAll('#prescription [data-as-of]')].map((e) => e.dataset.asOf).join(',')`);
			await k.open(`${route('interest_calc_tab')}?p=100000&r=10&m=Compound+%28monthly%29&from=2004-02-03&to=2005-02-03`, 'interest_calc_tab');
			return { presc, interest: J(await k.kpis('#ic_out')) };
		};
		const a = await snap();
		const b2 = await snap();
		await S.stop();
		await S.start();
		const c2 = await snap();
		return { pass: /as-of date 2026-10-08 \(today, South African time\)/.test(a.presc) && /^.*4 of 7 rows have a prescription date on or before/m.test(a.presc) && /"R 10 493.90"/.test(a.interest) && J(a) === J(b2) && J(a) === J(c2), evidence: { a, same: J(a) === J(b2), sameAfterRestart: J(a) === J(c2) } };
	});
	// ---- CC-06 r2: lost edits, limits, dates, URL values, links (r2.mjs) ----------------------------------------------------
	await r2({ b, S, sc, c, scenario, base, route });

	// ---- optional: synthetic screenshots of the product-visible changes (QUANTUM_SCREENS=<dir>; not a scenario) ---------
	if (process.env.QUANTUM_SCREENS) {
		mkdirSync(process.env.QUANTUM_SCREENS, { recursive: true });
		const shot = async (name, path, view, act) => {
			if (await k.exists('#pay-discard')) await k.click('#pay-discard');
			await k.open(path, view);
			if (act) await act();
			await sleep(150);
			const r = await p.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
			writeFileSync(join(process.env.QUANTUM_SCREENS, `${name}.png`), Buffer.from(r.data, 'base64'));
		};
		await p.s('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
		await shot('quantum-reconcile-flag', route('quantum_tab'), 'quantum_tab');
		await shot('invoice-ledger-heading', route('invoice_ledger_tab'), 'invoice_ledger_tab');
		await shot('prescription-arithmetic', route('prescription_tab'), 'prescription_tab');
		await shot('prescription-filter-in-url', `${route('prescription_tab')}?risk=Not+yet+due+to+prescribe`, 'prescription_tab');
		await shot('interest-default-and-note', route('interest_calc_tab'), 'interest_calc_tab');
		await shot('interest-reversed-refused', `${route('interest_calc_tab')}?p=100000&r=10&m=Simple&from=2094-01-10&to=2093-01-10`, 'interest_calc_tab');
		await shot('interest-separated-capital', `${route('interest_calc_tab')}?p=100%20000&r=10&m=Simple&from=2004-02-03&to=2005-02-03`, 'interest_calc_tab');
		await shot('payments-net-claim', route('payments_tab'), 'payments_tab');
		await shot('payments-refused-amount', route('payments_tab'), 'payments_tab', async () => { await k.fill([['#pay_amount', 'Synthetic entry 1']]); await k.click('#pay-add'); await p.waitFor(`!!document.getElementById('pay-error')`, 15000); });
		await shot('settlement-net-prefill-and-reset', route('settlement_tab'), 'settlement_tab');
		await shot('settlement-separated-claim', `${route('settlement_tab')}?claim=1%20000%20000`, 'settlement_tab');
		await shot('heading-focus-after-nav', '/overview', 'overview', async () => { await p.evaluate(`document.getElementById('nav-payments_tab').click()`); await p.waitFor(`${ready('payments_tab')} && document.activeElement?.hasAttribute('data-page-heading')`, 20000); });
	}
} catch (e) {
	results.push({ id: 'Q-SETUP', view: 'quantum_tab', title: 'suite setup', pass: false, evidence: { error: String(e?.stack ?? e).slice(0, 3000) } });
	console.log(`FAIL    Q-SETUP ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
	await S.stop().catch(() => {});
	try { b?.proc?.kill('SIGKILL'); } catch {}
}
const ok = finish({ build: (() => { try { return JSON.parse(readFileSync(join(BUILD, 'clearcase-build.json'), 'utf8')); } catch { return null; } })() });
rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
