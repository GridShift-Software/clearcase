// v5 spec: Documents (GRS-14). bundle_filter: every bundle of the package (index-coded, sorted, as the chronology's
// dimensions) with every generic filter probe, through the bundle buttons and the "Filter in bundle" field; every
// shown ref across every page, and the pager total. A bundle v5 offers no button for reads 'no-option' (S-documents-1).
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';
import { seqValue } from '../../../lib/sweeps.mjs';

/** The refs v5 shows for the current bundle and filter, page by page through Next, and the pager total. */
async function shown(p) {
	const refs = [];
	for (let i = 0; i < 400; i++) {
		const page = await p.evaluate(`(() => { const rows = [...document.querySelectorAll('#docsWrap tbody tr')].map((r) => r.cells[0]?.textContent ?? ''); const next = [...document.querySelectorAll('#docsWrap .pager button')].find((b) => /next/i.test(b.textContent)); if (next && !next.disabled) next.setAttribute('data-parity-next', '1'); return { rows, more: !!next && !next.disabled, total: (/of ([\\d,]+)/.exec(document.querySelector('#docsWrap .pager .count')?.textContent ?? '') ?? [])[1] ?? null }; })()`);
		refs.push(...page.rows);
		if (!page.more) return { refs, total: page.total };
		await p.click('[data-parity-next]');
		await sleep(2);
	}
	throw new Error('v5 documents: more than 400 pages');
}

/**
 * One combination as two values: `set` (the shown refs as a set, and the pager total) and `order` (the shown
 * sequence), so a change of order alone is told apart from a change of what is shown.
 */
export const comboValues = (key, refs, total) => ({
	[`${key}.set`]: `${seqValue([...refs].sort())}|shown ${String(total ?? refs.length).replace(/[,\s]/g, '')}`,
	[`${key}.order`]: seqValue(refs),
});

export const bundleFilterCombos = (dims) => {
	const out = [];
	for (let b = 1; b < dims.bundles.length; b++) for (let q = 0; q < dims.queries.length; q++) out.push({ key: `b${b}.q${q}`, bundle: dims.bundles[b], query: dims.queries[q] });
	return out;
};

export default {
	sweeps: [{
		id: 'bundle_filter',
		async v5(p, ctx) {
			const out = {};
			for (const c of bundleFilterCombos(ctx.dims)) {
				await p.load({});
				await p.go('documents');
				const ok = await p.evaluate(`(() => { const b = [...document.querySelectorAll('#main .toolbar button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(`${c.bundle} (`)})); if (!b) return false; b.setAttribute('data-parity-bundle', '1'); return true; })()`);
				if (!ok) { out[`${c.key}.set`] = out[`${c.key}.order`] = 'no-option'; continue; }
				await p.click('[data-parity-bundle]');
				await sleep(5);
				if (c.query) await p.type('#main input[placeholder="Filter in bundle"]', c.query);
				await sleep(5);
				const { refs, total } = await shown(p);
				Object.assign(out, comboValues(c.key, refs, total));
			}
			return out;
		},
	}],
};
