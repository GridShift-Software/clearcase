// App adapter: Entities (GRS-14). A read-only table in data order.
import { fromRaw } from '../../lib/snapshot.mjs';
import { openHydrated } from '../../../../tests/e2e/evidence/lib/parity-app.mjs';
import { navFocus } from './_shell.mjs';

const VIEW = 'entity_ledger_tab';

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
};
