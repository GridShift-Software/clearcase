// App adapter: Settlement / BATNA (GRS-16, CC-06). The page keeps v5's layout (narrative, the five inputs, the three
// scenario KPIs and the disclaimer), so the shared extractor reads it under v5's ids. The model sweep changes the v5
// spec's assumptions through the app's form and presses Model, which puts the inputs in the URL query (BA-03).
import { sleep } from '../../../../tests/e2e/pilot/lib/cdp.mjs';
import { fromRaw } from '../../lib/snapshot.mjs';
import { CASES, FIELD_ID, fillScript, readOutput } from '../v5/specs/settlement_tab.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'settlement_tab';

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
		async model(p, ctx) {
			const out = {};
			for (const [name, c] of Object.entries(CASES)) {
				await open(p, ctx, ctx.registry[VIEW].route, VIEW);
				await p.evaluate(fillScript(Object.entries(c).map(([k, v]) => [FIELD_ID[k], v])));
				await p.click('#se-model');
				await p.waitFor(`location.search.length > 1`, 15000);
				await sleep(20);
				await p.settled();
				const error = await p.evaluate(`document.getElementById('se-error')?.innerText.replace(/\\s+/g, ' ').trim() ?? null`);
				for (const [k, v] of Object.entries(readOutput(await p.extract('#se_out'), error))) out[`${name}.${k}`] = v;
			}
			return out;
		},
	},
};
