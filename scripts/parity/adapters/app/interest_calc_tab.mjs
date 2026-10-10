// App adapter: Interest Recalculator (GRS-16, CC-06). The page keeps v5's form and output layout, so the shared
// extractor reads it under v5's ids. The compute sweep fills the app's form with the v5 spec's cases and presses
// Compute, which puts the inputs in the URL query (BA-03) and renders the output.
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { CASES, FIELD_ID, fillScript, readOutput } from '../v5/specs/interest_calc_tab.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'interest_calc_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await open(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		async compute(p, ctx) {
			const out = {};
			for (const [name, c] of Object.entries(CASES)) {
				await open(p, ctx, ctx.registry[VIEW].route, VIEW);
				await p.evaluate(fillScript(Object.entries(c).map(([k, v]) => [FIELD_ID[k], v])));
				await p.click('#ic-compute');
				await p.waitFor(`location.search.length > 1 && !!document.querySelector('#ic_out .kpi, #ic-error')`, 15000);
				await sleep(20);
				await p.settled();
				const error = await p.evaluate(`document.getElementById('ic-error')?.innerText.replace(/\\s+/g, ' ').trim() ?? null`);
				for (const [k, v] of Object.entries(readOutput(await p.extract('#ic_out'), error))) out[`${name}.${k}`] = v;
			}
			return out;
		},
	},
};
