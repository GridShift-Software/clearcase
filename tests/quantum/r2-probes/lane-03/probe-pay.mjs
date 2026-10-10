// isolate the refused payment: a formula date vs a 200 000-character note; and imported CSV cells unchanged
const W = process.argv[2];
const { mkdtempSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { client, vpath } = await import(`${W}/tests/e2e/pilot/lib/client.mjs`);
const { quantumCase, server } = await import(`${W}/tests/e2e/quantum/lib.mjs`);
const { invoicesCsv } = await import(`${W}/src/lib/views/quantum/ledger.ts`);
const { prescriptionCsv } = await import(`${W}/src/lib/views/quantum/prescription.ts`);
const tmp = mkdtempSync(join(process.env.TMPDIR, 'v03p-'));
const S = server({ root: W, buildDir: join(W, 'build'), port: 43484, dir: tmp });
try {
	const sc = await quantumCase(join(tmp, 'case'));
	await S.start();
	const c = client(S.port);
	const imp = await c.importPkg(sc.caseDir, sc.pkgDir); await c.activate(imp.importId, { ack: true });
	const add = (f) => c.form(`${vpath(sc.resultsVersion)}/quantum/payments_tab?/add`, f);
	const show = async (k, f) => { const r = await add(f); console.log(k.padEnd(34), r.status, (/id="pay-error">([^<]*)</.exec(r.text)?.[1] ?? '').slice(0, 140), '| kept note length', (/id="pay_note"[^>]*value="([^"]*)"/.exec(r.text)?.[1] ?? '').length); };
	await show('formula date, short note', { date: '=1+1', amount: '8', method: '', note: 'x' });
	await show('valid date, 60 000-char note', { date: '2081-01-01', amount: '8', method: '', note: 'x'.repeat(60000) });
	await show('valid date, 70 000-char note', { date: '2081-01-01', amount: '8', method: '', note: 'x'.repeat(70000) });
	console.log('stored', S.rows('payments').map((r) => ({ date: r.fields.date, noteLen: r.fields.note.length })));
	const led = [{ ref: 'OD-1', no: '=HYPERLINK("http://x")', date: '2081-01-01', amount: '1.00', bundle: '+b', text_status: 'none', url: '@u' }];
	console.log('invoicesCsv imported', JSON.stringify(invoicesCsv(led)));
	console.log('prescriptionCsv imported', JSON.stringify(prescriptionCsv([{ no: '-1+1', ref: 'OD-1', date: '2081-01-01', prescDate: '2084-01-01', risk: '=x', url: '' }])));
} finally { await S.stop(); rmSync(tmp, { recursive: true, force: true }); }
