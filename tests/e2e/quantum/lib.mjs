// Helpers of the quantum browser suite (GRS-16): the synthetic case, a restartable server with the fixed clock, page
// helpers and read-only store queries. Synthetic data only; dates are far from any case date.
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { sleep } from '../pilot/lib/cdp.mjs';
import { buildCase, url } from '../pilot/lib/fixtures.ts';
import { startServer } from '../pilot/lib/server.mjs';

export const CLOCK = '2026-10-08T09:00:00Z';
export const J = JSON.stringify;
export const ready = (view) => `!!document.querySelector('[data-ready="${view}"]')`;

/** The suite's synthetic case: quantum and litigation datasets edited to exercise the checks (mismatches on purpose). */
export function quantumCase(root) {
	return buildCase(root, {
		caseId: 'e2e-quantum',
		edit: (r) => {
			const D = r.DATA;
			const inv = url('DISCOVERY A/OD-002 Invoice 1001.pdf');
			D.quantum.invoiceLedger = [
				{ amount: '1150.00', bundle: 'Original', date: '2081-01-31', no: 'SYNINV1', ref: 'OD-002', text_status: 'extracted', url: inv },
				{ amount: '0.10', bundle: 'Original', date: '2081-02-28', no: 'SYNINV2', ref: 'OD-001', text_status: 'ocr', url: url('DISCOVERY A/OD-001 Supply agreement.pdf') },
				{ amount: '0.20', bundle: 'Supplementary', date: '', no: 'SYNINV3', ref: 'OD-003', text_status: 'none', url: '' },
			];
			// the imported reference figures disagree with the rows: both must be shown as given, and flagged
			D.quantum.invoiceCount = 4;
			D.quantum.grossInvoiced = '1150.00';
			D.lit.prescription = [
				{ no: 'SYNP1', ref: 'OD-001', date: '1988-02-29', prescDate: '1991-02-28', risk: 'Relies on interruption', url: '' },
				{ no: 'SYNP2', ref: 'OD-002', date: '1987-05-31', prescDate: '1990-05-31', risk: 'Relies on interruption', url: inv },
				{ no: 'SYNP3', ref: 'OD-003', date: '2088-02-29', prescDate: '2091-02-28', risk: 'Not yet due to prescribe', url: '' },
				{ no: 'SYNP4', ref: 'SD-001', date: '2081-12-31', prescDate: '2084-12-31', risk: 'Not yet due to prescribe', url: '' },
			];
			// the summary contradicts its own rows (3 relying on interruption where 2 rows carry the label)
			D.lit.prescSummary = { awardDate: '2089-01-31', note: 'Synthetic narrative: every invoice has prescribed.', reliesOnInterruption: 3, total: 4 };
			D.lit.interestBasis = { award_date: '2089-01-31', first_invoice_date: '2093-01-10', headline_date: '2094-01-10', headline_due: '1150.00', note: 'Synthetic basis narrative.' };
			D.lit.settlement = { claim: '1150.00', claimDate: '2094-01-10' };
			D.lit.recon = [{ month: '2081-12', invoice: ['OD-002', 'ZZ-404'], statement: ['SD-001'], supporting: [], charging: [], amountdue: [], pod: [] }];
		},
	});
}

/** A restartable production server on one data directory, with the parity clock and time zone. */
export function server({ root, buildDir, port, dir }) {
	const s = {
		port, origin: `http://127.0.0.1:${port}`, dataDir: join(dir, 'data'), srv: null, starts: [],
		async start() { s.srv = await startServer({ root, port, origPort: port + 1, dataDir: s.dataDir, buildDir, logFile: join(dir, 'server.log'), env: { CLEARCASE_FIXED_NOW: CLOCK, TZ: 'UTC' } }); s.starts.push(s.srv.pid); return s.srv; },
		async stop(sig = 'SIGTERM') { const x = s.srv; s.srv = null; return x ? x.stop(sig) : null; },
		/** Read-only rows of a register store, by row id (the user-work file). */
		rows(store) {
			const d = new Database(join(s.dataDir, 'work.sqlite'), { readonly: true });
			try { d.exec('PRAGMA busy_timeout=5000'); return d.query('SELECT row_id, fields FROM register_row WHERE store = ? ORDER BY row_id').all(store).map((r) => ({ id: r.row_id, fields: JSON.parse(r.fields) })); } finally { d.close(); }
		},
	};
	return s;
}

/** Hold the user-work store's write lock from outside the app (IMMEDIATE: readers still work). */
export function holdStore(dataDir) {
	const d = new Database(join(dataDir, 'work.sqlite'));
	d.exec('PRAGMA busy_timeout=0');
	d.exec('BEGIN IMMEDIATE');
	const t0 = Date.now();
	return { held: () => Date.now() - t0, release() { d.exec('ROLLBACK'); d.close(); } };
}

/** Downloads (Blob anchors) captured in the page, as in the parity harness: the content, never a file on disk. */
export const CAPTURE = `(() => { window.__q = { downloads: [] }; const C = URL.createObjectURL.bind(URL); const blobs = new Map();
	URL.createObjectURL = (o) => { const u = C(o); blobs.set(u, o); return u; };
	const click = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () { const o = blobs.get(this.href); if (this.download && o) { window.__q.downloads.push({ name: this.download, blob: o }); return; } return click.call(this); }; })();`;
export const takeDownloads = (p) => p.evaluate(`Promise.all(window.__q.downloads.splice(0).map(async (d) => ({ name: d.name, text: await d.blob.text() })))`);

/** Page helpers on a cdp page. */
export function pageKit(p, base) {
	const k = {
		open: async (path, view) => { await p.navigate(`${base}${path}`); await p.waitFor(ready(view), 30000); await sleep(30); },
		text: (sel) => p.evaluate(`document.querySelector(${J(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`),
		value: (sel) => p.evaluate(`document.querySelector(${J(sel)})?.value ?? null`),
		values: (sels) => p.evaluate(`(${J(sels)}).map((s) => document.querySelector(s)?.value ?? null)`),
		exists: (sel) => p.evaluate(`!!document.querySelector(${J(sel)})`),
		fill: (pairs) => p.evaluate(`(() => { for (const [s, v] of ${J(pairs)}) { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } })()`),
		click: (sel) => p.evaluate(`document.querySelector(${J(sel)}).click()`),
		kpis: (root = '#main') => p.evaluate(`[...document.querySelectorAll(${J(`${root} .kpi`)})].map((k) => ({ label: k.querySelector('.k')?.textContent.trim(), value: k.querySelector('.v')?.textContent.replace(/\\s+/g, ' ').trim(), sub: k.querySelector('.s')?.textContent.replace(/\\s+/g, ' ').trim() ?? '' }))`),
		kpi: async (label, root) => (await k.kpis(root)).find((x) => x.label === label) ?? null,
		search: () => p.evaluate('location.search'),
		/** Reload the current URL as a new document (waits for its load event, then for the view to be ready). */
		reload: async (view) => { const u = await p.evaluate('location.href'); await p.navigate(u); await p.waitFor(ready(view), 30000); await sleep(30); },
	};
	return k;
}
