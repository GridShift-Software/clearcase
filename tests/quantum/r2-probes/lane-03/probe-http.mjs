// Lane 03 HTTP probe (no browser): the built app on a synthetic case, hostile URL queries and form posts. Synthetic only.
const W = process.argv[2];
const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { buildCase, url } = await import(`${W}/tests/e2e/pilot/lib/fixtures.ts`);
const { client, vpath, decodeHtml } = await import(`${W}/tests/e2e/pilot/lib/client.mjs`);
const { server } = await import(`${W}/tests/e2e/quantum/lib.mjs`);
const { paymentsCsv, paymentOf, ordered } = await import(`${W}/src/lib/views/quantum/payments.ts`);
const tmp = mkdtempSync(join(process.env.TMPDIR, 'v03-'));
const out = {};
const log = (k, v) => { out[k] = v; console.log(k.padEnd(40), typeof v === 'string' ? v : JSON.stringify(v)); };
const S = server({ root: W, buildDir: join(W, 'build'), port: 43480, dir: tmp });
try {
	const HOSTILE = { ledgerRef: 'javascript:alert(1)', seriesRef: '"><img src=x onerror=alert(1)>', headline: 'ZZ-777' };
	let conv;
	try {
		conv = await buildCase(join(tmp, 'case'), { caseId: 'v03-hostile', edit: (r) => {
			const D = r.DATA;
			D.quantum.invoiceLedger = [
				{ amount: '1150.00', bundle: 'Original', date: '2081-01-31', no: 'SYNINV1', ref: 'OD-002', text_status: 'extracted', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf') },
				{ amount: '0.10', bundle: 'Original', date: '2081-02-28', no: '=HYPERLINK("x")', ref: HOSTILE.ledgerRef, text_status: 'ocr', url: 'https://example.invalid/evil.pdf' },
				{ amount: '0.20', bundle: 'Supplementary', date: '', no: 'SYNINV3', ref: 'ZZ-404', text_status: 'none', url: url('DISCOVERY A/OD-001 Supply agreement.pdf') },
			];
			D.quantum.amountDueSeries = [{ amount: '100.00', date: '2081-01-31', filename: 'x.pdf', ref: HOSTILE.seriesRef, url: 'https://example.invalid/s.pdf' }, { amount: '200.00', date: '2081-02-28', filename: 'y.pdf', ref: 'OD-001', url: 'https://example.invalid/t.pdf' }];
			D.quantum.headline_ref = HOSTILE.headline; D.quantum.headline_url = 'https://example.invalid/h.pdf'; D.quantum.headline_due = '1150.00'; D.quantum.headline_date = '2094-01-10';
			D.quantum.invoiceCount = 3; D.quantum.grossInvoiced = '1150.30';
			D.lit.prescription = [
				{ no: 'SYNP1', ref: 'OD-001', date: '1988-02-29', prescDate: '1991-02-28', risk: 'Relies on interruption', url: '' },
				{ no: 'SYNP2', ref: 'OD-002', date: '1987-05-31', prescDate: '1990-05-31', risk: 'Relies on interruption', url: '' },
				{ no: 'SYNP3', ref: 'OD-003', date: '2088-02-29', prescDate: '2091-02-28', risk: 'Not yet due to prescribe', url: '' },
			];
			D.lit.prescSummary = { awardDate: '2089-01-31', note: 'Synthetic narrative.', reliesOnInterruption: 2, total: 3 };
			D.lit.interestBasis = { award_date: '2089-01-31', first_invoice_date: '2093-01-10', headline_date: '2094-01-10', headline_due: '1150.00', note: 'Synthetic basis narrative.' };
			D.lit.settlement = { claim: '1150.00', claimDate: '2094-01-10' };
			D.lit.recon = [{ month: '2081-12', invoice: ['OD-002', 'ZZ-404'], statement: ['SD-001'], supporting: [], charging: [], amountdue: [], pod: [] }];
		} });
	} catch (e) { log('hostile-case conversion', `REFUSED: ${String(e.message).slice(0, 300)}`); throw e; }
	log('hostile-case diagnostics', conv.diagnostics.map((d) => d.code));
	await S.start();
	const c = client(S.port);
	const imp = await c.importPkg(conv.caseDir, conv.pkgDir);
	const act = await c.activate(imp.importId, { ack: true });
	log('import/activate', { status: imp.status, active: (await c.activeVersion()) === conv.resultsVersion });
	const base = vpath(conv.resultsVersion) + '/quantum';
	const mainOf = (html) => { const i = html.indexOf('<main'); return html.slice(i, html.indexOf('</main>', i) + 7); };
	const textOf = (h) => decodeHtml(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
	const sel = (html, re) => { const m = re.exec(html); return m ? textOf(m[1]) : null; };
	// ---- Interest Recalculator ----
	const ic = async (q) => { const r = await c.get(`${base}/interest_calc_tab?${q}`); const m = mainOf(r.text); return { status: r.status, out: r.status === 200 ? sel(m, /<div id="ic_out">([\s\S]*?)<\/div>\s*<\/div>\s*<\/main>/) : textOf(r.text).slice(0, 160), inputs: [...m.matchAll(/<input id="ic_(\w+)"[^>]*?value="([^"]*)"/g)].map((x) => `${x[1]}=${decodeHtml(x[2])}`) }; };
	const IQ = {
		'13-digit capital': 'p=9999999999999.99&r=10&m=Simple&from=2025-01-01&to=2026-01-01',
		'14-digit capital': 'p=99999999999999&r=10&m=Simple&from=2025-01-01&to=2026-01-01',
		'exponent capital': 'p=1e5&r=10&m=Simple&from=2025-01-01&to=2026-01-01',
		'NaN capital, Infinity rate': 'p=NaN&r=Infinity&m=Simple&from=2025-01-01&to=2026-01-01',
		'negative capital': 'p=-1000&r=10&m=Simple&from=2025-01-01&to=2026-01-01',
		'leading zeros': 'p=0001000&r=010&m=Simple&from=2025-01-01&to=2026-01-01',
		'comma decimal': 'p=1000,50&r=10&m=Simple&from=2025-01-01&to=2026-01-01',
		'NBSP separator': 'p=1%C2%A0000&r=10&m=Simple&from=2025-01-01&to=2026-01-01',
		'narrow NBSP separator': 'p=1%E2%80%AF000&r=10&m=Simple&from=2025-01-01&to=2026-01-01',
		'full-width digits': 'p=%EF%BC%91%EF%BC%90%EF%BC%90%EF%BC%90&r=10&m=Simple&from=2025-01-01&to=2026-01-01',
		'30 February': 'p=1000&r=10&m=Simple&from=2086-02-30&to=2086-03-30',
		'year 0000': 'p=1000&r=10&m=Simple&from=0000-01-01&to=0001-01-01',
		'year 0024 typo': 'p=1000&r=10&m=Simple&from=0024-03-01&to=2026-03-01',
		'0099-12-31 to 0100-01-01': 'p=1000&r=10&m=Simple&from=0099-12-31&to=0100-01-01',
		'year 9999': 'p=1000&r=10&m=Simple&from=2026-01-01&to=9999-12-31',
		'reversed': 'p=1000&r=10&m=Simple&from=2026-01-01&to=2025-01-01',
		'repeated params': 'p=1000&p=5&r=10&r=99&m=Simple&from=2025-01-01&to=2026-01-01',
		'only m': 'm=Simple',
		'markup in p': 'p=%3Cscript%3Ealert(1)%3C%2Fscript%3E&r=10&m=Simple&from=2025-01-01&to=2026-01-01',
		'huge simple rate': 'p=9999999999999.99&r=999999999&m=Simple&from=0001-01-01&to=9999-12-31',
		'compound overflow 0001..9999': 'p=1000&r=10&m=Compound+(monthly)&from=0001-01-01&to=9999-12-31',
		'compound typo 1025 (r 10.5)': 'p=1000&r=10.5&m=Compound+(monthly)&from=1025-03-01&to=2026-03-01',
		'compound r=999999999 1y': 'p=1000&r=999999999&m=Compound+(monthly)&from=2025-01-01&to=2026-01-01',
	};
	for (const [k, q] of Object.entries(IQ)) log(`IC ${k}`, await ic(q));
	// ---- Settlement ----
	const se = async (q) => { const r = await c.get(`${base}/settlement_tab?${q}`); const m = mainOf(r.text); return { status: r.status, out: r.status === 200 ? sel(m, /<div id="se_out">([\s\S]*?)<\/div>\s*<\/div>\s*<\/main>/)?.slice(0, 260) : textOf(r.text).slice(0, 160) }; };
	const SQ = {
		'defaults': '', 'p=150': 'p=150&c=0', 'p=101': 'p=101', 'p=-5': 'p=-5', 'p=NaN': 'p=NaN', 'p=Infinity': 'p=Infinity', 'p=1e2': 'p=1e2',
		'y=999999999 overflow': 'y=999999999&d=10&c=0', 'claim 14 digits': 'claim=99999999999999', 'claim NBSP': 'claim=1%C2%A0000%C2%A0000',
		'claim full-width': 'claim=%EF%BC%91%EF%BC%90%EF%BC%90', 'cost comma decimal': 'c=500,50', 'repeated p': 'p=10&p=90', 'p=0 cost>0': 'p=0',
		'p=999999999 claim 13dig': 'p=999999999&claim=9999999999999.99&c=0',
	};
	for (const [k, q] of Object.entries(SQ)) log(`SE ${k}`, await se(q));
	// ---- Prescription filter in the URL ----
	const pr = async (q) => { const r = await c.get(`${base}/prescription_tab?${q}`); const m = mainOf(r.text); return { status: r.status, qValue: decodeHtml(/<input id="pr-q"[^>]*?value="([^"]*)"/.exec(m)?.[1] ?? '(no value attr)'), selected: [...m.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].filter((o) => /selected/.test(o[1])).map((o) => decodeHtml(o[2])), rows: [...m.matchAll(/<tr data-ref=/g)].length, pager: sel(m, /<span class="count q-push">([^<]*)</), rawMarkup: /<img src=x|<script>alert/.test(m) }; };
	for (const [k, q] of Object.entries({ 'none': '', 'known risk': 'risk=Relies+on+interruption', 'unknown risk': 'risk=Bogus', 'stale page 99': 'page=99', 'page -3': 'page=-3', 'page 1e1': 'page=1e1', 'markup q': 'q=%3Cimg+src%3Dx+onerror%3Dalert(1)%3E', 'markup risk': 'risk=%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'repeated risk': 'risk=Bogus&risk=Relies+on+interruption' }))
		log(`PR ${k}`, await pr(q));
	// ---- Links on the quantum, ledger and payments views ----
	for (const v of ['quantum_tab', 'invoice_ledger_tab', 'payments_tab', 'prescription_tab']) {
		const m = mainOf((await c.get(`${base}/${v}`)).text);
		const hrefs = [...m.matchAll(/href="([^"]*)"/g)].map((x) => decodeHtml(x[1]));
		const broken = [...m.matchAll(/<span class="cite-broken"[^>]*>([^<]*)<\/span>/g)].map((x) => decodeHtml(x[1]));
		log(`LINKS ${v}`, { hrefs: [...new Set(hrefs)], broken, anyUrlHref: hrefs.some((h) => /example\.invalid|DISCOVERY|\.pdf/.test(h)), rawHostile: /<img src=x onerror/.test(m), styleAttr: / style="/.test(m) });
	}
	for (const v of ['interest_calc_tab', 'settlement_tab']) log(`STYLE ${v}`, / style="/.test(mainOf((await c.get(`${base}/${v}`)).text)));
	// ---- Payments: hostile text through the form ----
	const add = (f) => c.form(`${base}/payments_tab?/add`, f);
	const HOST = [
		{ date: '2081-03-01', amount: '100', method: '=1+1', note: '+cmd' },
		{ date: '2081-03-02', amount: 'R 1 000.00', method: '-2+3', note: '@SUM(A1)' },
		{ date: '2081-03-03', amount: '1,000', method: '\t=1+1', note: '\r=1+1' },
		{ date: '2081-03-04', amount: '5', method: 'ok;=1+1', note: 'paid;=cmd|\' /C calc\'!A0' },
		{ date: '2081-03-05', amount: '6', method: 'a "quoted" value', note: 'line1\nline2\n=1+1' },
		{ date: '2081-03-06', amount: '7', method: 'ctrl\u0000\u0007\u001b[31m', note: '<script>alert(1)</script>' },
		{ date: '=1+1', amount: '8', method: '', note: 'x'.repeat(200000) },
		{ date: '2026-02-30', amount: '9', method: '', note: '' },
	];
	const res = [];
	for (const f of HOST) { const r = await add(f); res.push(r.status); }
	log('PAY add statuses', res);
	for (const amt of ['1e5', 'NaN', '-5', '1 000,50', '1 000', '１０', '99999999999999', '']) { const r = await add({ date: '2081-04-01', amount: amt, method: 'm', note: 'n' }); log(`PAY refuse ${JSON.stringify(amt)}`, { status: r.status, error: /role="alert" id="pay-error">([^<]*)</.exec(r.text)?.[1]?.slice(0, 90) ?? null, kept: /id="pay_amount"[^>]*value="([^"]*)"/.exec(r.text)?.[1] ?? null }); }
	const huge = await add({ date: '2081-04-02', amount: '1', method: '', note: 'y'.repeat(2_000_000) });
	log('PAY 2 MB note', { status: huge.status, body: textOf(huge.text).slice(0, 120) });
	const stored = S.rows('payments');
	log('PAY stored rows', stored.length);
	const pays = ordered(stored.map((r) => paymentOf(r.id, r.fields)));
	const csv = paymentsCsv(pays);
	writeFileSync(join(process.env.PROBE_OUT, 'payments-probe.csv'), csv);
	const lines = csv.split('\r\n');
	log('CSV header', lines[0]);
	log('CSV lines (first 120 chars each)', lines.slice(1).map((l) => JSON.stringify(l.slice(0, 120))));
	// semicolon reader: split each physical record (outside quotes) on ';' and look for a field starting with a formula prefix
	const semicolonFields = (rec) => { const f = []; let cur = '', q = false; for (const ch of rec) { if (ch === '"') q = !q; if (ch === ';' && !q) { f.push(cur); cur = ''; } else cur += ch; } f.push(cur); return f; };
	log('CSV semicolon-reader formula fields', csv.split('\r\n').flatMap(semicolonFields).filter((x) => /^[=+\-@\t\r]/.test(x)));
	log('CSV comma-reader formula fields', csv.split('\r\n').flatMap((rec) => rec.split(',')).filter((x) => /^[=+\-@\t\r]/.test(x)));
	const pm = mainOf((await c.get(`${base}/payments_tab`)).text);
	log('PAY page', { rawScript: /<script>alert/.test(pm), rows: [...pm.matchAll(/<tr data-row-id=/g)].length, kpis: [...pm.matchAll(/<div class="v[^"]*">([^<]*)<\/div>/g)].map((x) => decodeHtml(x[1])) });
} finally {
	await S.stop();
	rmSync(tmp, { recursive: true, force: true });
	writeFileSync(join(process.env.PROBE_OUT, 'probe-http.json'), JSON.stringify(out, null, 1));
}
