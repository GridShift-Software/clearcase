// App adapter: Payments & Net Claim (GRS-16, CC-06). The page keeps v5's layout (KPI cards, the payment form and
// table, the reconciliation chain), so the shared extractor reads it under v5's ids. Sweeps drive the app's own form:
// register_edit mirrors v5's generic register sequence (every field filled by input type, Add twice, delete the first
// shown row, read the overview tiles) and separators the v5 spec's typed amounts. The app keeps user work for the
// whole run, so each sweep deletes every payment it saved before it returns.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw, tableFromRaw } from '../../lib/snapshot.mjs';
import { syntheticInput } from '../../lib/sweeps.mjs';
import { readPayments, SEPARATED, separatedPayment } from '../v5/specs/payments_tab.mjs';
import { navFocus, open, pressAndCapture, readOverviewTiles } from './_shell.mjs';

const VIEW = 'payments_tab';
const route = (ctx) => ctx.registry[VIEW].route;

/** The number of stored payment rows shown, and the error line's text. */
const state = (p) => p.evaluate(`({ n: document.querySelectorAll('#payments tbody tr[data-row-id]').length, err: document.getElementById('pay-error')?.textContent ?? '' })`);

/** Click a submit button and wait until the action has answered: the row count or the error line changed. */
async function submit(p, sel) {
	const before = await state(p);
	if (!(await p.click(sel))) return false;
	const t0 = Date.now();
	for (;;) {
		await sleep(25);
		const now = await state(p);
		const idle = await p.evaluate(`!document.querySelector('#pay-add')?.disabled`);
		if (idle && (now.n !== before.n || now.err !== before.err || Date.now() - t0 > 1500)) break;
		if (Date.now() - t0 > 15000) throw new Error(`${VIEW}: no answer after submitting ${sel}`);
	}
	await p.settled();
	return true;
}

/** Delete every stored payment whose note marks it as the sweep's own (the app keeps user work across views). */
async function cleanup(p, ctx, notePrefix) {
	await open(p, ctx, route(ctx), VIEW);
	for (let i = 0; i < 50; i++) {
		const tagged = await p.evaluate(`(() => { const r = [...document.querySelectorAll('#payments tbody tr[data-row-id]')].find((r) => r.cells[3]?.textContent.startsWith(${JSON.stringify(notePrefix)})); if (!r) return false; r.querySelector('button').setAttribute('data-parity-cleanup', '1'); return true; })()`);
		if (!tagged) return;
		await submit(p, '[data-parity-cleanup]');
	}
	throw new Error(`${VIEW}: could not remove the sweep's payments`);
}

const firstTableRows = async (p) => {
	const t = (await p.extract('#main')).tables[0];
	if (!t) return [];
	const tab = tableFromRaw(t);
	return tab.rows.map((r) => tab.columns.map((c) => r[c.id]).join(' | '));
};

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await open(p, ctx, route(ctx), VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		if (ctx.exports) {
			const got = await pressAndCapture(p, '#export-payments', parseDownload);
			s.exports.export_payments = got?.[0] ?? { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		/** v5's generic register sequence through the app's form (scripts/parity/adapters/v5/specs.mjs registerSweep). */
		async register_edit(p, ctx) {
			const out = {};
			await open(p, ctx, route(ctx), VIEW);
			const record = async (step) => { const rows = await firstTableRows(p); out[`${step}.rows`] = String(rows.length); rows.forEach((r, i) => { out[`${step}.row.${i}`] = r; }); };
			for (let n = 0; n < 2; n++) {
				const fields = await p.evaluate(`[...document.querySelectorAll('#main input, #main select, #main textarea')].filter((e) => e.getClientRects().length && !e.closest('table') && e.type !== 'file' && e.type !== 'checkbox').map((e, i) => { e.setAttribute('data-parity-field', String(i)); return { i, tag: e.tagName.toLowerCase(), type: e.type, options: e.tagName === 'SELECT' ? [...e.options].map((o) => o.value) : null }; })`);
				for (const f of fields) {
					const sel = `[data-parity-field="${f.i}"]`;
					if (f.tag === 'select') { const v = f.options.find((o) => o) ?? ''; if (v) await p.select(sel, f.options[Math.min(f.options.length - 1, f.options.indexOf(v) + n)]); }
					else await p.evaluate(`(() => { const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(syntheticInput(f.type, n, ctx.clock))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
				}
				const add = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main button')].find((b) => /^\\s*\\+?\\s*add\\b/i.test(b.textContent) && b.getClientRects().length && !b.closest('table')); if (!b) return false; b.setAttribute('data-parity-add', '1'); return true; })()`);
				if (!add) { out.add = 'no-add-control'; return out; }
				await submit(p, '[data-parity-add]');
				await record(`add${n + 1}`);
			}
			const del = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main table tbody tr button')].find((b) => /delete|remove|×|✕/i.test(b.textContent + (b.title || ''))); if (!b) return false; b.setAttribute('data-parity-del', '1'); return true; })()`);
			if (del) { await submit(p, '[data-parity-del]'); await record('delete'); } else out.delete = 'no-delete-control';
			for (const [label, t] of Object.entries(await readOverviewTiles(p, ctx))) out[`overview.${label}`] = t.value;
			await cleanup(p, ctx, 'Synthetic entry');
			return out;
		},
		/** The v5 spec's separated amounts, typed into the app's form (scripts/parity/adapters/v5/specs/payments_tab.mjs). */
		async separators(p, ctx) {
			await open(p, ctx, route(ctx), VIEW);
			for (let i = 0; i < SEPARATED.length; i++) {
				const pay = separatedPayment(ctx.clock, i);
				await p.evaluate(`(() => { const v = ${JSON.stringify(pay)}; for (const [id, k] of [['pay_date', 'date'], ['pay_amount', 'amount'], ['pay_method', 'method'], ['pay_note', 'note']]) { const e = document.getElementById(id); e.value = v[k]; e.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
				await submit(p, '#pay-add');
			}
			const out = readPayments(await p.extract('#main'));
			await cleanup(p, ctx, 'Synthetic separators');
			return out;
		},
	},
};
