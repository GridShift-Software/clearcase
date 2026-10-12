// v5 spec: Conflict Check (GRS-18). The first state shows no result, so this sweep drives the check through its own
// controls with generic probes, never case words: options of the "Pick a party" select by index (index 0 is the
// blank option, which clears the result), and typed queries through the box and the Check button. Each combination
// records the box's value and the result as shown: the badge line and the Kind | Match | Detail rows.
import { sleep } from '../../../../../tests/e2e/pilot/lib/cdp.mjs';

/** Option indexes of the select (entities first, then people, in data order) and typed probes, by key. */
export const PICKS = [1, 2, 5, 9, 22, 23, 30, 45, 64, 0];
export const PROBES = [['none', 'zzz-no-such-party'], ['short', ' A '], ['co', 'co'], ['ltd', 'ltd'], ['two', 'xq zv'], ['empty', '']];

/** The box's value and the result area as text, in the same shape on both sides (#confq and #confres on both). */
export const readResult = (p) => p.evaluate(`(() => {
	const t = (e) => (e?.textContent ?? '').replace(/\\s+/g, ' ').trim();
	const res = document.getElementById('confres');
	const badge = t(res?.querySelector('.badge'));
	const rows = [...(res?.querySelectorAll('table tbody tr') ?? [])].map((r) => [...r.cells].map(t).join(' | '));
	return ['q=' + (document.getElementById('confq')?.value ?? '<no box>'), badge || '<no result>', ...rows].join(' ¶ ');
})()`);

/** Drive the probes with side-specific control selectors; `reset` opens a fresh view. */
export async function conflictSweep(p, { reset, check }) {
	const out = {};
	await reset();
	const n = await p.evaluate(`document.getElementById('confsel')?.options.length ?? 0`);
	for (const i of PICKS) {
		if (i >= n) { out[`pick.${i}`] = 'no-option'; continue; }
		const v = await p.evaluate(`document.getElementById('confsel').options[${i}].value`);
		const r = await p.select('#confsel', v);
		await sleep(10);
		out[`pick.${i}`] = r === 'ok' ? await readResult(p) : r;
	}
	await reset();
	for (const [k, q] of PROBES) {
		await p.type('#confq', q);
		await check();
		await sleep(10);
		out[`type.${k}`] = await readResult(p);
	}
	return out;
}

export default {
	sweeps: [{
		id: 'conflict_check',
		v5: (p) => conflictSweep(p, {
			reset: async () => { await p.load({}); await p.go('conflict_tab'); },
			check: async () => {
				await p.evaluate(`[...document.querySelectorAll('#main button')].find((b) => b.textContent.trim() === 'Check')?.setAttribute('data-parity-check', '1')`);
				await p.click('[data-parity-check]');
			},
		}),
	}],
};
