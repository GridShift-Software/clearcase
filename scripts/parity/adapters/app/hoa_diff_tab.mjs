// App adapter: Document Diff (GRS-14). The first state (no comparison yet) and v5's compare_pair sweep through the
// app's own selects and Compare button.
import { fromRaw } from '../../lib/snapshot.mjs';
import { seqValue } from '../../lib/sweeps.mjs';
import { PAIRS, comparisonValue, readComparison } from '../v5/specs/hoa_diff_tab.mjs';
import { openHydrated } from '../../../../tests/e2e/evidence/lib/parity-app.mjs';
import { navFocus } from './_shell.mjs';

const VIEW = 'hoa_diff_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openHydrated(p, ctx, ctx.registry[VIEW].route, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
	sweeps: {
		async compare_pair(p, ctx) {
			const out = {};
			for (const c of PAIRS) {
				await openHydrated(p, ctx, ctx.registry[VIEW].route, VIEW);
				for (const [sel, i] of [['#diffA', c.a], ['#diffB', c.b]]) if (i) await p.select(sel, await p.evaluate(`document.querySelector('${sel}').options[${i}]?.value ?? ''`));
				await p.select('#diffmode', c.mode);
				await p.click('#diff-run');
				await p.waitFor(`document.getElementById('main').dataset.result !== 'none' && !document.getElementById('main').dataset.busy`, 20000);
				out[c.key] = comparisonValue(await p.evaluate(readComparison('#diff-body')), seqValue);
			}
			return out;
		},
	},
};
