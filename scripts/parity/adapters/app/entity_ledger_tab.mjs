// App adapter: Entities (GRS-14). A read-only table in data order.
import { fromRaw } from '../../lib/snapshot.mjs';
import { navFocus, open } from './_shell.mjs';

const VIEW = 'entity_ledger_tab';

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
};
