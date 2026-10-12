// v5 sweeps for CaseLines (GRS-19): page-text search probes, go-to-page and opening a result. Drivers are shared
// with the app adapter (scripts/parity/adapters/app/caselines_tab.mjs), which passes its own steps; queries are
// generic probes, never case values, and combo keys are index-coded.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { seqValue } from '../../../lib/sweeps.mjs';

const VIEW = 'caselines_tab';
export const QUERIES = ['court', 'the', 'zzzq', 'plaintiff', 'a', '  '];
export const PAGES = ['5', '0', ''];

/** The results as shown: the summary line, the hits' text in order, and the first hit. */
export const readResults = (p) => p.evaluate(`(() => { const t = (e) => (e?.textContent ?? '').replace(/\\s+/g, ' ').trim(); const box = document.getElementById('cl-results'); const hits = [...(box?.querySelectorAll('.cl-hit') ?? [])].map(t); const hints = [...(box?.querySelectorAll('.cl-hint') ?? [])].map(t); return { hints, hits }; })()`);
export const encodeResults = (r) => `${r.hints.join(' || ')}|hits=${seqValue(r.hits)}|first=${r.hits[0] ?? ''}`;

/** The sweeps, given a side's steps: fresh(p, ctx), search(p, q), gotoPage(p, n) and clickHit(p) -> 'page=N' | 'none'. */
export function runSweeps(side) {
	return {
		async search(p, ctx) {
			const out = {};
			for (const [k, q] of QUERIES.entries()) { await side.fresh(p, ctx); await side.search(p, q); out[`q${k}`] = encodeResults(await readResults(p)); }
			return out;
		},
		async goto_page(p, ctx) {
			const out = {};
			for (const [k, n] of PAGES.entries()) { await side.fresh(p, ctx); out[`p${k}`] = await side.gotoPage(p, n); }
			return out;
		},
		async open_result(p, ctx) {
			await side.fresh(p, ctx);
			await side.search(p, QUERIES[0]);
			return { first: await side.clickHit(p) };
		},
	};
}

const opened = (p) => p.evaluate(`(() => { const m = document.getElementById('docModal'); if (!m || m.style.display !== 'flex') return 'none'; const f = /#page=(\\d+)$/.exec(document.getElementById('docFrame')?.getAttribute('src') ?? ''); return f ? 'page=' + f[1] : 'open'; })()`);
const V5 = {
	fresh: async (p) => { await p.load({}); await p.go(VIEW); },
	search: async (p, q) => { await p.type('#cl-q', q); await p.click('#cl-go'); await sleep(80); },
	gotoPage: async (p, n) => { await p.type('#cl-pg', n); await p.click('#cl-goto'); await sleep(80); return opened(p); },
	clickHit: async (p) => { await p.click('#cl-results .cl-hit'); await sleep(80); return opened(p); },
};
export default { sweeps: Object.entries(runSweeps(V5)).map(([id, fn]) => ({ id, v5: (p, ctx) => fn(p, ctx) })) };
