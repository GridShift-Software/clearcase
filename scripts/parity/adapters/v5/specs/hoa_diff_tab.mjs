// v5 spec: Document Diff (GRS-14). compare_pair: explicit pairs chosen by option position (never by ref), in both
// modes, the same document twice, the pair reversed, and a missing second document. Each value is the comparison's
// heading, its file-name line and a digest of the diff body as merged (operation, text) segments.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { seqValue } from '../../../lib/sweeps.mjs';

/** Pairs by option index (1 = the first document after the placeholder); 0 leaves the select on its placeholder. */
export const PAIRS = [
	{ key: 'p12.words', a: 1, b: 2, mode: 'words' },
	{ key: 'p12.lines', a: 1, b: 2, mode: 'lines' },
	{ key: 'p21.words', a: 2, b: 1, mode: 'words' },
	{ key: 'p33.words', a: 3, b: 3, mode: 'words' },
	{ key: 'p45.words', a: 4, b: 5, mode: 'words' },
	{ key: 'p10.words', a: 1, b: 0, mode: 'words' },
];

/** The comparison as shown: heading, file line and the body's merged segments (a page expression; `body` selects it). */
export const readComparison = (body) => `(() => {
	const out = document.getElementById('diffOut'); if (!out) return 'no-output';
	const t = (e) => (e?.textContent ?? '').replace(/\\s+/g, ' ').trim();
	const empty = out.querySelector('.empty'); if (empty) return 'empty: ' + t(empty);
	const segs = [];
	for (const n of (document.querySelector(${JSON.stringify(body)})?.childNodes ?? [])) {
		const op = n.nodeType === 3 ? 'eq' : n.classList?.contains('diffdel') ? 'del' : n.classList?.contains('diffadd') ? 'add' : null;
		if (!op) continue;
		const last = segs[segs.length - 1];
		if (last && last.op === op) last.text += n.textContent; else segs.push({ op, text: n.textContent });
	}
	return { head: t(out.querySelector('h3')), files: t(out.querySelector('.tag')), segs: segs.filter((s) => s.text !== '').map((s) => s.op + ':' + s.text) };
})()`;
export const comparisonValue = (r, seq) => (typeof r === 'string' ? r : `${r.head} | ${r.files} | ${seq(r.segs)}`);

export default {
	sweeps: [{
		id: 'compare_pair',
		async v5(p) {
			const out = {};
			for (const c of PAIRS) {
				await p.load({});
				await p.go('hoa_diff_tab');
				for (const [sel, i] of [['#diffA', c.a], ['#diffB', c.b]]) if (i) await p.select(sel, await p.evaluate(`document.querySelector('${sel}').options[${i}]?.value ?? ''`));
				await p.select('#diffmode', c.mode);
				await p.evaluate(`[...document.querySelectorAll('#main button')].find((b) => b.textContent.trim() === 'Compare')?.setAttribute('data-parity-compare', '1')`);
				await p.click('[data-parity-compare]');
				await sleep(10);
				out[c.key] = comparisonValue(await p.evaluate(readComparison('#diffOut > div:last-child')), seqValue);
			}
			return out;
		},
	}],
};
