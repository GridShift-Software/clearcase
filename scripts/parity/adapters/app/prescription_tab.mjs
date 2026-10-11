// App adapter: Prescription (GRS-16, CC-06). The page keeps v5's layout (KPI cards, the imported note, the filter
// row, the paged table with v5's pager wording); the shared extractor reads page 1 and the adapter pages through with
// Next, as the v5 adapter does, appending every page's rows. The sweeps run the v5 spec's filter, stale-filter and
// export steps through the app's own controls.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { parseDownload } from '../../lib/exports.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { COMBOS, comboKey, EXPORT_COMBOS, exportValue, PROBES, readAll, RISKS, STALE } from '../v5/specs/prescription_tab.mjs';
import { navFocus, open, pressAndCapture } from './_shell.mjs';

/** Open one of this view's routes and wait until it is hydrated (data-ready is server-rendered; data-hydrated marks working controls). */
const openView = async (p, ctx, route, view) => { await open(p, ctx, route, view); await p.waitFor(`!!document.querySelector('main[data-ready="${view}"][data-hydrated]')`, 30000); };

const VIEW = 'prescription_tab';
const APP = { table: '#prescription', pager: '#pr-pager' };
const route = (ctx) => ctx.registry[VIEW].route;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');
const dim = (y, m) => (m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
const ymd = (d) => { const m = ISO.exec(d ?? ''); if (!m) return null; const [y, mo, da] = [+m[1], +m[2], +m[3]]; return y >= 1000 && mo >= 1 && mo <= 12 && da >= 1 && da <= dim(y, mo) ? [y, mo, da] : null; };
const plus3 = (d) => { const p = ymd(d); return p ? `${p[0] + 3}-${pad(p[1])}-${pad(Math.min(p[2], dim(p[0] + 3, p[1])))}` : null; };
const STATUS = { passed: '3-yr date passed', not: '3-yr date not reached', none: 'no valid date' };
/**
 * CC-06 r2, D14: the arithmetic card checked against the rows the page shows, by an oracle written here (not the
 * app's code). `check.as_of_status_disagreements` counts the rows whose shown As-of status differs from their shown
 * prescription date against the card's as-of date (<); `check.arithmetic_disagreements` counts the card's figures
 * (the +3-year count, the passed count, the row count) that differ from the rows. Both are 0 when the page is right;
 * v5 has neither, so the register pins the app to exactly '0'. No case value enters the register.
 */
function checks(rows, card) {
	const asOf = /as-of date (\d{4}-\d{2}-\d{2})/.exec(card.asof)?.[1] ?? null;
	const expect = (r) => (!ymd(r.prescribes_3yr) ? STATUS.none : asOf !== null && r.prescribes_3yr < asOf ? STATUS.passed : STATUS.not);
	const shown3 = /^(\d+) of (\d+) imported/.exec(card.plus3), shownPassed = /^(\d+) of (\d+) rows have/.exec(card.asof);
	const figures = [
		[shown3?.[1], rows.filter((r) => plus3(r.invoice_date) === r.prescribes_3yr).length],
		[shown3?.[2], rows.length],
		[shownPassed?.[1], rows.filter((r) => expect(r) === STATUS.passed).length],
		[shownPassed?.[2], rows.length],
	];
	return {
		'check.as_of_status_disagreements': String(asOf === null ? rows.length : rows.filter((r) => r.as_of_status !== expect(r)).length),
		'check.arithmetic_disagreements': String(figures.filter(([shown, want]) => shown === undefined || Number(shown) !== want).length),
	};
}

async function filter(p, c) {
	if (PROBES[c.q]) await p.type('#pr-q', PROBES[c.q]);
	if (RISKS[c.r]) await p.select('#pr-risk', RISKS[c.r]);
	await sleep(5);
	await p.settled();
}

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openView(p, ctx, route(ctx), VIEW);
		const raw = await p.extract('#main');
		// every page through Next, appended to the page-1 table (the v5 adapter's pageThrough)
		const at = await p.evaluate(`[...document.querySelectorAll('#main table, #main [role=table]')].filter((x) => x.getClientRects().length).indexOf(document.getElementById('prescription'))`);
		const pager = await p.evaluate(`document.getElementById('pr-pager').innerText.replace(/\\s+/g, ' ').trim()`);
		for (let i = 0; i < 100; i++) {
			const more = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#pr-pager button')].find((b) => /next/i.test(b.textContent)); if (!b || b.disabled) return false; b.setAttribute('data-parity-next', '1'); return true; })()`);
			if (!more) break;
			await p.click('[data-parity-next]');
			await sleep(5);
			await p.settled();
			raw.tables[at].rows.push(...(await p.extract('#prescription')).tables[0].rows);
		}
		const s = fromRaw(VIEW, 'app', raw);
		const id = Object.keys(s.tables)[at];
		Object.assign(s.counts, checks(s.tables[id].rows, await p.evaluate(`({ plus3: document.getElementById('arith-plus3')?.textContent ?? '', asof: document.getElementById('arith-asof')?.textContent ?? '' })`)));
		s.texts[`${id}.pager`] = pager;
		const m = /of ([\d,\s]+)\s*$/.exec(pager);
		if (m) s.counts[`${id}.total`] = m[1].trim();
		if (ctx.exports) {
			await openView(p, ctx, route(ctx), VIEW);
			const got = await pressAndCapture(p, '#export-presc', parseDownload);
			s.exports.export_csv = got?.[0] ?? { name: '(nothing captured)' };
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		async filters(p, ctx) {
			const out = {};
			for (const c of COMBOS) {
				await openView(p, ctx, route(ctx), VIEW);
				await filter(p, c);
				const r = await readAll(p, APP);
				out[`${comboKey(c)}.rows`] = r.rows;
				out[`${comboKey(c)}.pager`] = r.pager;
			}
			return out;
		},
		async stale(p, ctx) {
			await openView(p, ctx, route(ctx), VIEW);
			await filter(p, STALE);
			await p.click('#nav-overview');
			await p.waitFor(`!!document.querySelector('[data-ready="overview"]')`, 30000);
			await p.click(`#nav-${VIEW}`);
			await p.waitFor(`!!document.querySelector('[data-ready="${VIEW}"]')`, 30000);
			await p.settled();
			const ctl = await p.evaluate(`({ input: document.getElementById('pr-q').value, select: document.getElementById('pr-risk').value })`);
			const r = await readAll(p, APP);
			return { input: ctl.input, select: ctl.select, rows: r.rows, pager: r.pager };
		},
		async export(p, ctx) {
			const out = {};
			for (const c of EXPORT_COMBOS) {
				await openView(p, ctx, route(ctx), VIEW);
				await filter(p, c);
				const e = await exportValue(p, () => p.click('#export-presc'));
				for (const [k, v] of Object.entries(e)) if (k !== 'name') out[`${comboKey(c)}.${k}`] = v;
			}
			return out;
		},
	},
};
