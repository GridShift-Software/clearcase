// App adapter: Legality & SIU Risk (GRS-18). The generic extraction over #main. The scenarios table's last column
// keeps v5's id (its v5 heading named a party, which view-content does not carry yet), so only its label differs.
import { fromRaw } from '../../lib/snapshot.mjs';
import { openHydrated } from '../../../../tests/e2e/litigation/lib/parity.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'legality_tab';

export default {
	view: VIEW,
	async extract(p, ctx) {
		const nav = await navFocus(p, ctx, { from: '/overview', fromView: 'overview', view: VIEW });
		await openHydrated(p, ctx, VIEW);
		const s = fromRaw(VIEW, 'app', await p.extract('#main'));
		const sc = s.tables.scenarios;
		if (sc) {
			sc.columns = sc.columns.map((c) => (c.id === 'action' ? { ...c, id: 'ess_action' } : c));
			sc.rows = sc.rows.map((r) => { const { action, ...rest } = r; return action === undefined ? r : { ...rest, ess_action: action }; });
		}
		s.focus.after_nav = nav.focus;
		s.texts['shell.crumb'] = nav.crumb;
		return s;
	},
};
