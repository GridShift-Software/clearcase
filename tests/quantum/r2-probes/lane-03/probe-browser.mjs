// Lane 03 targeted browser job: six quantum views in Chromium on a synthetic case. CSP violations, inline style
// attributes, the Prescription select on an unknown risk, a same-route navigation, the client-side compound overflow,
// a year-0000 date field, and the three real CSV downloads. Synthetic data only.
const W = process.argv[2];
const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { launch, newPage, sleep } = await import(`${W}/tests/e2e/pilot/lib/cdp.mjs`);
const { client, vpath } = await import(`${W}/tests/e2e/pilot/lib/client.mjs`);
const { CAPTURE, pageKit, quantumCase, ready, server, takeDownloads } = await import(`${W}/tests/e2e/quantum/lib.mjs`);
const tmp = mkdtempSync(join(process.env.TMPDIR, 'v03b-'));
const out = {};
const log = (k, v) => { out[k] = v; console.log(k.padEnd(36), JSON.stringify(v).slice(0, 700)); };
const S = server({ root: W, buildDir: join(W, 'build'), port: 43482, dir: tmp });
let b;
const CSP_HOOK = `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ dir: e.violatedDirective, uri: e.blockedURI, sample: e.sample }));`;
const watchdog = setTimeout(() => { console.log('WATCHDOG: no completion in 9 min'); process.exit(3); }, 9 * 60_000);
try {
	const sc = await quantumCase(join(tmp, 'case'));
	await S.start();
	const c = client(S.port);
	const imp = await c.importPkg(sc.caseDir, sc.pkgDir);
	await c.activate(imp.importId, { ack: true });
	const base = vpath(sc.resultsVersion);
	// hostile payments through the form (HTTP) before the browser reads them
	for (const f of [{ date: '2081-03-01', amount: '100', method: '=1+1', note: '+cmd' }, { date: '2081-03-04', amount: '5', method: 'ok;=1+1', note: 'paid;=cmd|\' /C calc\'!A0' }, { date: '2081-03-05', amount: '6', method: '@SUM(1)', note: 'a "q";b\n=1' }])
		await c.form(`${base}/quantum/payments_tab?/add`, f);
	b = await launch({ profileRoot: join(tmp, 'chromium') });
	const p = await newPage(b, { initScript: CAPTURE + CSP_HOOK });
	await p.s('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
	const k = pageKit(p, `${S.origin}${base}`);
	const views = ['quantum_tab', 'invoice_ledger_tab', 'prescription_tab', 'interest_calc_tab', 'payments_tab', 'settlement_tab'];
	const styleScan = `({ doc: [...document.querySelectorAll('[style]')].map((e) => e.tagName + '#' + e.id + ' ' + e.getAttribute('style')).slice(0, 10), main: document.querySelectorAll('#main [style]').length, csp: window.__csp })`;
	const c0 = b.events.console.length;
	for (const v of views) {
		await k.open(`/quantum/${v}`, v);
		log(`STYLE/CSP load ${v}`, await p.evaluate(styleScan));
	}
	// interactions that re-render: interest compute, settlement model, prescription filter + paging, payments add error
	await k.open('/quantum/interest_calc_tab?p=1000&r=10&m=Simple&from=2025-01-01&to=2026-01-01', 'interest_calc_tab');
	log('STYLE/CSP interest computed', await p.evaluate(styleScan));
	await k.open('/quantum/settlement_tab?p=70', 'settlement_tab');
	log('STYLE/CSP settlement modelled', await p.evaluate(styleScan));
	await k.open('/quantum/payments_tab', 'payments_tab');
	await k.fill([['#pay_date', '2081-05-01'], ['#pay_amount', '1e5']]);
	await k.click('#pay-add');
	await p.waitFor(`!!document.getElementById('pay-error')`, 15000).catch(() => null);
	log('STYLE/CSP payments refused add', { ...(await p.evaluate(styleScan)), error: await k.text('#pay-error') });
	log('CSP console messages', b.events.console.slice(c0).filter((x) => /Content.Security.Policy|Refused to/i.test(x.text)).map((x) => x.text.slice(0, 200)));
	log('exceptions', b.events.console.slice(c0).filter((x) => x.kind === 'exception').map((x) => x.text.slice(0, 200)));
	// Prescription: an unknown risk in the URL
	await k.open('/quantum/prescription_tab?risk=Bogus', 'prescription_tab');
	log('PR unknown risk', await p.evaluate(`(() => { const s = document.getElementById('pr-risk'); return { selectValue: s.value, selectedIndex: s.selectedIndex, shownText: s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : '(blank)', rows: document.querySelectorAll('#prescription tbody tr').length, pager: document.querySelector('#pr-pager .count').textContent, search: location.search }; })()`));
	// Prescription: filtered, then the same route from the sidebar
	await k.open('/quantum/prescription_tab?risk=Relies+on+interruption', 'prescription_tab');
	await p.evaluate(`document.getElementById('nav-prescription_tab').click()`);
	await sleep(1500);
	log('PR same-route sidebar nav', await p.evaluate(`(() => { const s = document.getElementById('pr-risk'); return { search: location.search, selectValue: s.value, rows: document.querySelectorAll('#prescription tbody tr').length }; })()`));
	// Prescription export with a filter, and the shown order
	await k.open('/quantum/prescription_tab?q=SYNP', 'prescription_tab');
	await p.evaluate(`(() => { const s = document.getElementById('pr-risk'); s.value = 'Not yet due to prescribe'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
	await sleep(300);
	const shownRefs = await p.evaluate(`[...document.querySelectorAll('#prescription tbody tr')].map((r) => r.children[1].textContent)`);
	await k.click('#export-presc');
	await sleep(300);
	const pd = await takeDownloads(p);
	log('PR export filtered', { shown: shownRefs, search: await k.search(), files: pd.map((d) => ({ name: d.name, lines: d.text.split('\r\n') })) });
	// Interest: year 0000 in the URL (what the From field shows vs what is computed)
	await k.open('/quantum/interest_calc_tab?p=1000&r=10&m=Simple&from=0000-01-01&to=0001-01-01', 'interest_calc_tab');
	log('IC year 0000 field vs result', { from: await k.value('#ic_from'), to: await k.value('#ic_to'), kpis: await k.kpis() });
	await k.open('/quantum/interest_calc_tab?p=1000&r=10&m=Simple&from=0024-03-01&to=2026-03-01', 'interest_calc_tab');
	log('IC year 0024 field vs result', { from: await k.value('#ic_from'), kpis: (await k.kpis()).map((x) => `${x.label}=${x.value}`) });
	// Interest: client-side compound overflow through the form (Compute)
	await k.open('/quantum/interest_calc_tab', 'interest_calc_tab');
	const e0 = b.events.console.length;
	await k.fill([['#ic_p', '1000'], ['#ic_r', '10.5'], ['#ic_from', '1025-03-01'], ['#ic_to', '2026-03-01']]);
	await p.evaluate(`(() => { const s = document.getElementById('ic_m'); s.value = 'Compound (monthly)'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
	await k.click('#ic-compute');
	await sleep(2500);
	log('IC compound overflow via Compute', { url: await p.evaluate('location.pathname + location.search'), title: await p.evaluate('document.title'), h1: await p.evaluate(`document.querySelector('h1')?.textContent.trim() ?? null`), icOut: await k.text('#ic_out'), alert: await k.text('[role="alert"]'), exceptions: b.events.console.slice(e0).filter((x) => x.kind === 'exception' || /error/i.test(x.kind)).map((x) => x.text.slice(0, 160)) });
	// Real downloads: payments.csv and invoices.csv
	await k.open('/quantum/payments_tab', 'payments_tab');
	await k.click('#export-payments'); await sleep(300);
	log('PAY export', (await takeDownloads(p)).map((d) => ({ name: d.name, lines: d.text.split('\r\n') })));
	await k.open('/quantum/invoice_ledger_tab', 'invoice_ledger_tab');
	await k.click('#export-invoices'); await sleep(300);
	log('INV export', (await takeDownloads(p)).map((d) => ({ name: d.name, lines: d.text.split('\r\n').map((l) => l.slice(0, 90)) })));
	log('CSP console messages (whole run)', b.events.console.slice(c0).filter((x) => /Content.Security.Policy|Refused to/i.test(x.text)).map((x) => x.text.slice(0, 200)));
} finally {
	clearTimeout(watchdog);
	if (b) await b.close?.().catch?.(() => {});
	await S.stop();
	writeFileSync(join(process.env.PROBE_OUT, 'probe-browser.json'), JSON.stringify(out, null, 1));
	rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
